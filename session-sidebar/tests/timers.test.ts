import { expect, mock, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

// A session started twice in one process registers its timers again: the first pair must not keep running.
test('a second session.start leaves one refresh timer running', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.id', () => ({ value: 'session-a' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  // The refresh timer's only write: its tick. Two live timers tick twice per period.
  let ticks = 0
  on('state.set', ($: any, e: any, next: any) => {
    if (e.plugin === 'session-sidebar' && e.key === 'tick') ticks += 1
    return next(e)
  })

  await $.session.start(START)
  await $.session.start(START)

  const before = ticks
  await clock.advance(3000)
  expect(ticks - before).toBe(1)
})
