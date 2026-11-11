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

test('pressing an MCP row toggles the server through /mcp', async ($, on) => {
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
  on('session.usage', () => ({
    value: { startedAt: Date.parse('2026-10-20T09:00:00Z'), context: { tokens: 1, window: 200000, percent: 0 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('tool.list', () => ({ value: [{ name: 'mcp__engram__mem_save', description: 'save', mcp: true }] }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))

  const runs: { command: string; args?: string }[] = []
  on('command.run', (_$: unknown, e: { command: string; args?: string }) => {
    runs.push({ command: e.command, args: e.args })
    return { text: '' }
  })

  const ui = await $.ui.mount({ plugin: 'session-sidebar', surface: 'terminal', ...PANE })
  await ui.press({ key: 'mcp-toggle-engram' })
  await ui.unmount()

  expect(runs).toEqual([{ command: 'mcp', args: 'disable engram' }])
})
