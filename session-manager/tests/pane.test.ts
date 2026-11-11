import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'session-manager',
  props: {
    title: 'Sessions',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const CURRENT = '15248dd7-1dc9-436b-b9fb-bb0411fb5576'
const OLDER = '30825fe3-4ee6-44a1-8be9-04e444e81bbf'
const OLDEST = '49fafc51-fb44-4276-93cb-5f67635795ba'
const DIR = '/home/test/.claude/projects/-work'

const line = (entry: unknown) => JSON.stringify(entry)
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })

const TRANSCRIPTS: Record<string, string> = {
  [CURRENT]: prompt('Build the session manager'),
  [OLDER]: [prompt('Fix the login bug'), line({ type: 'custom-title', customTitle: 'Login fix' })].join('\n'),
  [OLDEST]: [line({ type: 'user', isMeta: true, message: { content: 'meta' } }), prompt('Write the README')].join('\n'),
}

type Run = { argv: readonly string[] }

// A project with three saved conversations, the newest being the running one.
function mockProject(on: any, deleteFails = false) {
  const files = new Map<string, number>([
    [CURRENT, Date.parse('2026-10-20T11:00:00Z')],
    [OLDER, Date.parse('2026-10-19T11:00:00Z')],
    [OLDEST, Date.parse('2026-10-18T11:00:00Z')],
  ])
  const runs: Run[] = []
  const toasts: string[] = []
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.id', () => ({ value: CURRENT }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path === `${DIR}/${CURRENT}.jsonl` }))
  on('fs.list', (_$: any, e: any) => {
    if (e.path !== DIR) return { deny: 'missing' }
    const entries = [...files].map(([id, mtimeMs]) => ({
      name: `${id}.jsonl`,
      kind: 'file',
      size: 100,
      mtimeMs,
      isLink: false,
    }))
    entries.push({ name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false })
    entries.push({ name: OLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    return { value: entries }
  })
  on('fs.read', (_$: any, e: any) => {
    const id = String(e.path).slice(DIR.length + 1, -'.jsonl'.length)
    const text = TRANSCRIPTS[id]
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: e.argv })
    if (deleteFails) {
      return { value: { exitCode: 6, stdout: '', stderr: 'delete-session: refusing a folder outside /x\n', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const id = e.argv[3]
    files.delete(id)
    return { value: { exitCode: 0, stdout: `deleted session ${id}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, toasts }
}

async function openList($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sessions' } as any)
  return $.ui.mount({ plugin: 'session-manager', surface: 'terminal', ...PANE })
}

test('a session whose computed project folder is missing uses the sibling that holds it', async ($, on) => {
  const LONG_ROOT = '/nix/store/9f2a-claude-plugins'
  const files = new Map<string, number>([
    [CURRENT, Date.parse('2026-10-20T11:00:00Z')],
    [OLDER, Date.parse('2026-10-19T11:00:00Z')],
  ])
  const probed: string[] = []
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('session.id', () => ({ value: CURRENT }))
  // A path whose computed key names a folder that does not exist.
  on('session.root', () => ({ value: LONG_ROOT }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_$: any, e: any) => {
    probed.push(e.path)
    return { value: e.path === `${DIR}/${CURRENT}.jsonl` }
  })
  on('fs.list', (_$: any, e: any) => {
    if (e.path === '/home/test/.claude/projects') {
      return {
        value: [
          { name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'stray.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
        ],
      }
    }
    if (e.path !== DIR) return { deny: 'missing' }
    return {
      value: [...files].map(([id, mtimeMs]) => ({ name: `${id}.jsonl`, kind: 'file', size: 100, mtimeMs, isLink: false })),
    }
  })
  on('fs.read', (_$: any, e: any) => {
    const id = String(e.path).slice(DIR.length + 1, -'.jsonl'.length)
    const text = TRANSCRIPTS[id]
    return text === undefined ? { deny: 'missing' } : { value: text }
  })

  await $.session.start({ cwd: LONG_ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sessions' } as any)
  const ui = await $.ui.mount({ plugin: 'session-manager', surface: 'terminal', ...PANE })
  // The computed folder was tried first, then the sibling that holds the transcript.
  expect(probed[0]).toBe(`/home/test/.claude/projects/-nix-store-9f2a-claude-plugins/${CURRENT}.jsonl`)
  expect(await ui.find({ type: 'Button', key: `row:${CURRENT}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `row:${OLDER}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(LONG_ROOT.replace(/[/.]/g, '\\$&')) })).toBeDefined()
  await ui.unmount()
})

test('/sessions lists the project conversations newest first, marking the current one', async ($, on) => {
  mockProject(on)
  const ui = await openList($)
  const buttons = await ui.findAll({ type: 'Button' })
  const keys = buttons.map((button: any) => String(button.key ?? button.props?.key))
  expect(keys.filter((key: string) => key.startsWith('row:'))).toEqual([`row:${CURRENT}`, `row:${OLDER}`, `row:${OLDEST}`])
  expect(await ui.find({ type: 'Button', text: /Build the session manager .*15248dd7 \(current\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /2026-10-19 .*Login fix .*30825fe3/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Write the README .*49fafc51/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /notes/ })).toBeUndefined()
  await ui.unmount()
})

test('the current session is refused for deletion and the script never runs', async ($, on) => {
  const { runs } = mockProject(on)
  const ui = await openList($)
  await ui.press({ key: 'delete' })
  expect(await ui.find({ type: 'Text', text: /current session: it cannot be deleted/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'confirm-yes' })).toBeUndefined()
  await ui.press({ key: 'delete' })
  expect(runs).toEqual([])
  await ui.unmount()
})

test('delete asks first: cancel keeps the row, confirm runs the script and refreshes the list', async ($, on) => {
  const { runs } = mockProject(on)
  const ui = await openList($)
  await ui.press({ key: 'down' })

  await ui.press({ key: 'delete' })
  expect(await ui.find({ type: 'Text', text: /Delete "Login fix" \(30825fe3\)\?/ })).toBeDefined()
  expect(runs).toEqual([])
  await ui.press({ key: 'confirm-no' })
  expect(await ui.find({ type: 'Button', key: 'confirm-yes' })).toBeUndefined()
  expect(runs).toEqual([])

  await ui.press({ key: 'delete' })
  await ui.press({ key: 'confirm-yes' })
  expect(runs.length).toBe(1)
  const argv = runs[0]?.argv ?? []
  expect(argv[0]).toBe('bash')
  expect(String(argv[1]).endsWith('/scripts/delete-session.sh')).toBe(true)
  expect(argv.slice(2)).toEqual([DIR, OLDER, CURRENT])
  expect(await ui.find({ type: 'Button', key: `row:${OLDER}` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `row:${OLDEST}` })).toBeDefined()
  await ui.unmount()
})

test('pressing delete twice on the same row confirms, as ctrl+d twice would', async ($, on) => {
  const { runs } = mockProject(on)
  const ui = await openList($)
  await ui.press({ key: 'down' })
  await ui.press({ key: 'down' })
  await ui.press({ key: 'delete' })
  await ui.press({ key: 'delete' })
  expect(runs.map(run => run.argv[3])).toEqual([OLDEST])
  await ui.unmount()
})

test('a failing delete script shows its message and keeps the row', async ($, on) => {
  mockProject(on, true)
  const ui = await openList($)
  await ui.press({ key: 'down' })
  await ui.press({ key: 'delete' })
  await ui.press({ key: 'confirm-yes' })
  expect(await ui.find({ type: 'Text', text: /refusing a folder outside/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `row:${OLDER}` })).toBeDefined()
  await ui.unmount()
})
