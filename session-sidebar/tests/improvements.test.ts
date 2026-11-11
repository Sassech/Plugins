import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'session-sidebar',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const START = { cwd: '/work', surface: 'terminal', isInteractive: false } as const

function stubSession(on: any, usage: () => unknown) {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.usage', () => ({ value: usage() }))
  on('tool.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
}

const live = { tokens: 76875, window: 200000, percent: 38 }
const unread = { window: 200000 }

test('without a live reading the context shows the last one, prefixed with ~', async ($, on) => {
  let context: Record<string, number> = live
  stubSession(on, () => ({ startedAt: 0, context, rateLimits: [], cost: { usd: 0 } }))
  await $.session.start(START)
  await $.session.measure({ context: live, rateLimits: [], changed: ['context'] })

  let ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^76,875 \/ 200,000 tokens$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 38%$/ })).toBeDefined()
  await ui.unmount()

  // A resume or a compaction: the engine has no fill to report yet.
  context = unread
  await $.session.measure({ context: unread, rateLimits: [], changed: ['context'] })
  ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^~76,875 \/ 200,000 tokens$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / ~38%$/ })).toBeDefined()
  await ui.unmount()
})

test('a fresh session with no reading ever still shows —', async ($, on) => {
  stubSession(on, () => ({ startedAt: 0, context: unread, rateLimits: [], cost: { usd: 0 } }))
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^— \/ 200,000 tokens$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~/ })).toBeUndefined()
  await ui.unmount()
})

test('each rate-limit window draws label, bar, percent and countdown on one line', async ($, on) => {
  stubSession(on, () => ({
    startedAt: 0,
    context: live,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-20T12:30:00Z' },
      { kind: 'seven_day', percentUsed: 42, resetsAt: '2026-10-22T10:00:00Z' },
    ],
    cost: { usd: 0 },
  }))
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^5h window ━*─* 12% · 2h 30m$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Week ━*─* 42% · 2d 0h$/ })).toBeDefined()
  await ui.unmount()
})
