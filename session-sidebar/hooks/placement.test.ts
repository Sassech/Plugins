import { expect, mock, test } from 'claude-code/testing'

import { DOCK_COLUMNS } from './register'

const PROPS = {
  title: 'Session',
  isFocused: false,
  bodyColumns: 40,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

// The sidebar as the terminal seats it: inline above the prompt on a narrow fullscreen terminal, or docked.
const INLINE = {
  component: 'Pane',
  requestId: 'session-sidebar',
  props: { ...PROPS, placement: 'inline' },
  viewport: { columns: 90, rows: 40, isFullscreen: true },
} as const
const DOCKED = {
  component: 'Pane',
  requestId: 'session-sidebar',
  props: { ...PROPS, placement: 'dock' },
  viewport: { columns: 150, rows: 40, isFullscreen: true },
} as const
const MAIN_SCREEN = { ...INLINE, viewport: { columns: 150, rows: 40, isFullscreen: false } } as const

const TOOL_USE = {
  component: 'ToolUse',
  requestId: 'tu-9',
  props: { tool_use_id: 'tu-9', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
} as const

// An empty session, and an engine that keeps the plugin's panes: an open on a narrow terminal waits undrawn.
function mockEngine(on: any) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-a' }))
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
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(String(e.text))
    return { value: null }
  })
  // The engine's own row, beneath the plugin: what a pass-through draws.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))

  const wide = { value: true }
  const panes = new Map<string, boolean>()
  const opens: any[] = []
  const closes: any[] = []
  on('ui.open', ($: any, e: any) => {
    opens.push(e)
    panes.set(e.id, wide.value)
    return { value: wide.value ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', ($: any, e: any) => {
    closes.push(e)
    panes.delete(e.id)
    return { value: null }
  })
  on('ui.panes', () => ({
    value: [...panes].map(([id, isPlaced]) => ({ id, title: id, isShown: true, isFocused: false, isPlaced })),
  }))

  return { clock, wide, opens, closes, panes, toasts }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('a narrow terminal is told the width the sidebar waits for', async ($, on) => {
  const engine = mockEngine(on)
  engine.wide.value = false
  await $.session.start(START)

  expect(engine.toasts).toHaveLength(1)
  expect(engine.toasts[0]).toContain(`${DOCK_COLUMNS} cols`)
})

test('a sidebar seated inline is closed and waits undrawn to dock again', async ($, on) => {
  const engine = mockEngine(on)
  await $.session.start(START)
  expect(engine.opens).toHaveLength(1)

  // The window narrows: the engine seats the open sidebar inline. It draws nothing there meanwhile.
  engine.wide.value = false
  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...INLINE })
  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()
  await engine.clock.advance(1000)
  await ui.unmount()

  expect(engine.closes).toHaveLength(1)
  expect(engine.closes[0].id).toBe('session-sidebar')
  expect(engine.closes[0].origin.kind).toBe('plugin')
  // Opened again unasked, so the engine holds it until the terminal is wide enough to dock it.
  expect(engine.opens).toHaveLength(2)
  expect(engine.opens[1].id).toBe('session-sidebar')
  expect(engine.opens[1].focus).toBeUndefined()
})

test('a docked sidebar lists no tool activity and leaves tool rows in the transcript', async ($, on) => {
  mockEngine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...DOCKED })
  expect(await ui.find({ type: 'Text', text: 'Activity' })).toBeUndefined()
  await ui.unmount()

  const row = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...TOOL_USE })
  expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await row.unmount()
})

test('a docked sidebar is left alone', async ($, on) => {
  const engine = mockEngine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...DOCKED })
  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
  await engine.clock.advance(3000)
  await ui.unmount()

  expect(engine.closes).toHaveLength(0)
  expect(engine.opens).toHaveLength(1)
})

test('on the main screen, where nothing docks, an inline sidebar closes and is not reopened', async ($, on) => {
  const engine = mockEngine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...MAIN_SCREEN })
  await engine.clock.advance(1000)
  await ui.unmount()

  expect(engine.closes).toHaveLength(1)
  expect(engine.opens).toHaveLength(1)
})

test('a sidebar the person closed stays closed', async ($, on) => {
  const engine = mockEngine(on)
  await $.session.start(START)

  engine.wide.value = false
  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...INLINE })
  // The person's close mark: the engine drops the pane before the plugin's next check.
  engine.panes.delete('session-sidebar')
  await engine.clock.advance(3000)
  await ui.unmount()

  expect(engine.closes).toHaveLength(0)
  expect(engine.opens).toHaveLength(1)
})

test('/sidebar on a narrow terminal keeps it inline until it docks again', async ($, on) => {
  const engine = mockEngine(on)
  await $.session.start({ ...START, isInteractive: false })

  const narrow = { isFullscreen: true, columns: 90 }
  await $.command.run({ command: 'sidebar', args: '', origin: { kind: 'composer' }, presentation: narrow } as any)
  expect(engine.opens).toHaveLength(1)

  const inline = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...INLINE })
  expect(await inline.find({ type: 'Text', text: 'Context' })).toBeDefined()
  await engine.clock.advance(3000)
  await inline.unmount()
  expect(engine.closes).toHaveLength(0)

  // Widened, it docks; narrowed again, it goes.
  const docked = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...DOCKED })
  await engine.clock.advance(1000)
  await docked.unmount()
  const again = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...INLINE })
  await engine.clock.advance(1000)
  await again.unmount()

  expect(engine.closes).toHaveLength(1)
  expect(engine.closes[0].origin.kind).toBe('plugin')
})
