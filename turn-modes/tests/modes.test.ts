import { expect, test } from 'claude-code/testing'

type Step = { turnId: string; agentId?: string; model: string; effort?: unknown }

// The engine beneath the plugin: prompts enter as rewritten, steps and spawns are recorded.
function mockEngine(on: any) {
  const prompts: string[] = []
  const steps: Step[] = []
  const spawns: (string | undefined)[] = []
  on('prompt.submit', ($: any, e: any) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($: any, e: any) {
    steps.push({ turnId: e.turnId, agentId: e.agentId, model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: 'the answer' }))
  let spawned = 0
  on('agent.spawn', ($: any, e: any) => {
    spawns.push(e.model)
    spawned += 1
    return { model: e.model ?? 'claude-opus-5-5', agentId: `agent-${spawned}` }
  })

  return { prompts, steps, spawns }
}

async function step($: any, turnId: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
  for await (const _ of stream) {
    // Drained so the result settles.
  }
  return stream.result
}

async function turn($: any, text: string, turnId: string) {
  await $.prompt.submit({ text })
  await $.turn.start({ text: text.replace(/^[_+]\s*/, ''), turnId })
}

function complete($: any, turnId: string) {
  return $.turn.complete({ turnId, answer: 'the answer', reason: 'answer', isAborted: false, durationMs: 1 })
}

const spawnArgs = { prompt: 'map it', description: 'Map', subagentType: 'Explore' }

test('_ strips the prefix and runs the turn and its subagents on the cheap model', async ($, on) => {
  const engine = mockEngine(on)
  await turn($, '_fix the lint error', 't1')
  expect(engine.prompts).toEqual(['fix the lint error'])

  await step($, 't1')
  await $.agent.spawn(spawnArgs as any)
  await step($, 't1-sub', 'agent-1')
  const done = await complete($, 't1')

  expect(engine.steps.map(s => s.model)).toEqual(['haiku', 'haiku'])
  expect(engine.spawns).toEqual(['haiku'])
  expect(done.text).toBe('↳ ran on haiku')
})

test('+ runs the turn and its subagents at maximum effort, on the session model', async ($, on) => {
  const engine = mockEngine(on)
  await turn($, '+ why does this race', 't1')
  expect(engine.prompts).toEqual(['why does this race'])

  await step($, 't1')
  await $.agent.spawn(spawnArgs as any)
  await step($, 't1-sub', 'agent-1')
  const done = await complete($, 't1')

  expect(engine.steps).toEqual([
    { turnId: 't1', agentId: undefined, model: 'claude-opus-5-5', effort: 'max' },
    { turnId: 't1-sub', agentId: 'agent-1', model: 'claude-opus-5-5', effort: 'max' },
  ])
  expect(engine.spawns).toEqual([undefined])
  expect(done.text).toBe('↳ effort max')
})

test('the cheap model comes from the plugin options', { options: { cheapModel: 'claude-haiku-5-5' } }, async ($, on) => {
  const engine = mockEngine(on)
  await turn($, '_rename it', 't1')
  await step($, 't1')

  expect(engine.steps[0]?.model).toBe('claude-haiku-5-5')
})

test('a plain prompt, and __ or +1, keep the session model, effort and text', async ($, on) => {
  const engine = mockEngine(on)
  for (const [i, text] of ['plain prompt', '__init__.py fails', '+1 on that', '++ nope'].entries()) {
    await turn($, text, `t${i}`)
    await step($, `t${i}`)
    const done = await complete($, `t${i}`)
    expect(done.text).toBe('the answer')
  }

  expect(engine.prompts).toEqual(['plain prompt', '__init__.py fails', '+1 on that', '++ nope'])
  expect(engine.steps.every(s => s.model === 'claude-opus-5-5' && s.effort === 'high')).toBe(true)
})

test('a _ prompt typed during another turn leaves the running turn alone and applies to its own', async ($, on) => {
  const engine = mockEngine(on)
  await turn($, 'long refactor', 't1')
  await step($, 't1')
  // Typed while t1 runs: queued by the engine, it starts its own turn later.
  await ($ as any).prompt.submit({ text: '_summarize it' })
  await step($, 't1')
  await complete($, 't1')
  await $.turn.start({ text: 'summarize it', turnId: 't2' })
  await step($, 't2')

  expect(engine.steps.map(s => [s.turnId, s.model])).toEqual([
    ['t1', 'claude-opus-5-5'],
    ['t1', 'claude-opus-5-5'],
    ['t2', 'haiku'],
  ])
})

test('after the turn ends, the next plain turn is back on the session model', async ($, on) => {
  const engine = mockEngine(on)
  await turn($, '_quick one', 't1')
  await step($, 't1')
  await complete($, 't1')
  await turn($, 'next task', 't2')
  await step($, 't2')
  await $.agent.spawn(spawnArgs as any)

  expect(engine.steps.map(s => s.model)).toEqual(['haiku', 'claude-opus-5-5'])
  expect(engine.spawns).toEqual([undefined])
})
