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

test('the sidebar shows model, context, limits and MCP, and no subagents', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({ value: [] }))
  on('session.version', () => ({ value: ({ version: '2.1.292', base: '2.1.292' }) }))
  on('session.usage', () => ({ value: ({
    startedAt: Date.parse('2026-10-20T09:00:00Z'),
    context: { tokens: 76875, window: 200000, percent: 38 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 42, resetsAt: '2026-10-22T10:00:00Z' }],
    cost: { usd: 0.45 },
  }) }))
  on('agent.list', () => ({ value: [
    { id: 'a1', description: 'Map auth flow', type: 'Explore', status: 'running' },
  ] }))
  on('tool.list', () => ({ value: [
    { name: 'mcp__engram__mem_save', description: 'save', mcp: true },
    { name: 'Read', description: 'read', mcp: false },
  ] }))
  on('fs.read', () => ({ deny: 'missing' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-sidebar', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /76,875/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$0\.45/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /engram/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Map auth flow|Subagents/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('stored limits show before any reply, and a passed reset reads 0%', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on, {
    limits: [
      { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-10-20T09:00:00Z' },
      { kind: 'seven_day', percentUsed: 55, resetsAt: '2026-10-21T10:00:00Z' },
    ],
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /55%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 0%/ })).toBeDefined()
  await ui.unmount()
})

test('the title skips /clear and injected blocks for the first real prompt', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 2 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({
    value: [
      {
        role: 'user',
        text: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
        toolUses: [],
      },
      { role: 'user', text: '<local-command-stdout></local-command-stdout>', toolUses: [] },
      { role: 'user', text: 'Renew SSL for mail.example.com', toolUses: [] },
    ],
  }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Renew SSL for mail.example.com' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /command-name/ })).toBeUndefined()
  await ui.unmount()
})

test('a generated title replaces the prompt, and a saved one is reused without asking again', async ($, on) => {
  let asked = 0
  mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-2' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: 'renueva el certificado ssl de mail.example.com con certbot', toolUses: [] }],
  }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('model.complete', () => {
    asked += 1
    return {
      value: {
        isAnswered: true,
        text: '"Renovar SSL de mail."',
        usage: { input_tokens: 40, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  // The title arrives after the model answers: draw afresh until it shows.
  let found
  for (let i = 0; i < 20 && !found; i++) {
    const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
    found = await ui.find({ type: 'Text', text: 'Renovar SSL de mail' })
    await ui.unmount()
  }
  expect(found).toBeDefined()

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  expect(asked).toBe(1)
})

test("the generated title becomes Claude Code's session title on the first prompt", async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.id', () => ({ value: 'session-3' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Sidebar para Claude Code',
      usage: { input_tokens: 40, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('classic.UserPromptSubmit', () => ({}))

  const result = await $.classic.UserPromptSubmit({
    session_id: 'session-3',
    transcript_path: '/tmp/session-3.jsonl',
    cwd: '/work',
    prompt: 'quiero crear un plugin con un sidebar para claude code',
  })
  expect(result.sessionTitle).toBe('Sidebar para Claude Code')
})

test('a session that already has a title keeps it', async ($, on) => {
  let asked = 0
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.id', () => ({ value: 'session-4' }))
  on('model.complete', () => {
    asked += 1
    return {
      value: {
        isAnswered: false,
        reason: 'empty-reply',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('classic.UserPromptSubmit', () => ({}))

  const result = await $.classic.UserPromptSubmit({
    session_id: 'session-4',
    transcript_path: '/tmp/session-4.jsonl',
    cwd: '/work',
    prompt: 'otra cosa',
    session_title: 'My renamed session',
  })
  expect(result.sessionTitle).toBeUndefined()
  expect(asked).toBe(0)
})

test(
  'the title model comes from the plugin options',
  { options: { titleModel: 'sonnet' } },
  async ($, on) => {
    const models: string[] = []
    mock.clock(on, { now: 0 })
    mock.store(on)
    on('session.id', () => ({ value: 'session-6' }))
    on('model.complete', (_$: any, e: any) => {
      models.push(String(e.model))
      return {
        value: {
          isAnswered: true,
          text: 'Custom title',
          usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })
    on('classic.UserPromptSubmit', () => ({}))

    await $.classic.UserPromptSubmit({
      session_id: 'session-6',
      transcript_path: '/tmp/session-6.jsonl',
      cwd: '/work',
      prompt: 'name this session with the configured model',
    })
    expect(models).toEqual(['sonnet'])
  },
)

test("under kitty the pane takes the terminal's background, followed through includes", async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/test', TERM: 'xterm-kitty' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-5' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('fs.read', ($, e) => {
    if (e.path === '/home/test/.config/kitty/kitty.conf') {
      return { value: 'include ./themes/1984 Dark.conf\nfont_size 12' }
    }
    if (e.path === '/home/test/.config/kitty/themes/1984 Dark.conf') {
      return { value: 'foreground #ffffff\nbackground #0d0f31' }
    }
    return { deny: 'missing' }
  })
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes[0]?.props.backgroundColor).toBe('#0d0f31')
  await ui.unmount()
})
