import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function imageResult(type: string, originalSize: number) {
  return {
    type: 'image',
    file: {
      base64: PNG,
      type,
      originalSize,
      dimensions: { originalWidth: 400, originalHeight: 200, displayWidth: 400, displayHeight: 200 },
    },
  } as const
}

const VIEWPORT = { columns: 120, rows: 40 } as const
const NOW = Date.parse('2026-11-11T12:00:00Z')

function resultRow(id: string, output: unknown) {
  return {
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Read', output, isErrored: false },
    viewport: VIEWPORT,
  } as const
}

function mockEngine(on: any, stat: (path: string) => unknown) {
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: NOW })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', ($: any, e: any) => stat(e.path))

  return { runs }
}

const fileStat = (mtimeMs: number) => ({ value: { kind: 'file', size: 2_621_440, mtimeMs, isLink: false } })

test('a read preview carries its format, size and age, and opens the file with xdg-open', async ($, on) => {
  const { runs } = mockEngine(on, () => fileStat(NOW - 3 * 60 * 60 * 1000))
  const result = imageResult('image/png', 2_621_440)
  on('tool.call', () => ({ result }))
  await $.tool.call({ tool: 'Read', file_path: '/work/shot.png', tool_use_id: 'tu-1' } as any)

  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-1', result) })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'PNG · 2.5 MB · 3h ago' })).toBeDefined()
  await row.press({ key: 'open-tu-1' })
  await row.unmount()

  expect(runs).toContainEqual(['xdg-open', '/work/shot.png'])
})

test('a converted read opens the original file, not its cached copy', async ($, on) => {
  const { runs } = mockEngine(on, () => fileStat(NOW - 2 * 24 * 60 * 60 * 1000))
  const result = imageResult('image/jpeg', 70)
  on('tool.call', () => ({ result }))
  await $.tool.call({ tool: 'Read', file_path: '/work/photo.jpg', tool_use_id: 'tu-2' } as any)

  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-2', result) })
  expect(await row.find({ type: 'Text', text: 'JPEG · 70 B · 2d ago' })).toBeDefined()
  await row.press({ key: 'open-tu-2' })
  await row.unmount()

  expect(runs).toContainEqual(['xdg-open', '/work/photo.jpg'])
})

test('a failing stat drops the age but keeps the preview and its label', async ($, on) => {
  mockEngine(on, () => ({ deny: 'ENOENT' }))
  const result = imageResult('image/png', 12_800)
  on('tool.call', () => ({ result }))
  await $.tool.call({ tool: 'Read', file_path: '/work/gone.png', tool_use_id: 'tu-3' } as any)

  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-3', result) })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'PNG · 12.5 KB' })).toBeDefined()
  await row.unmount()
})

test('an inline pasted PNG gets no label and no open button', async ($, on) => {
  mockEngine(on, () => fileStat(NOW))
  await $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'u-1',
    message: {
      type: 'user',
      role: 'user',
      content: [
        { type: 'text', text: 'what is this [Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    },
  } as any).catch(() => undefined)

  const row = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    requestId: 'u-1',
    component: 'UserMessage',
    props: { text: 'what is this [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  } as const)
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ type: 'Button' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /PNG ·/ })).toBeUndefined()
  await row.unmount()
})
