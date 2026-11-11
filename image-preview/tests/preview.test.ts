import { expect, mock, test } from 'claude-code/testing'

// A real 1x1 PNG: the header parse reads its size, the terminal would draw it.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const IMAGE_RESULT = {
  type: 'image',
  file: {
    base64: PNG,
    type: 'image/png',
    originalSize: 70,
    dimensions: { originalWidth: 400, originalHeight: 200, displayWidth: 400, displayHeight: 200 },
  },
} as const

const TEXT_RESULT = {
  type: 'text',
  file: { filePath: '/work/notes.md', content: '# notes', numLines: 1, startLine: 1, totalLines: 1 },
} as const

const VIEWPORT = { columns: 120, rows: 40 } as const

function resultRow(id: string, output: unknown) {
  return {
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Read', output, isErrored: false },
    viewport: VIEWPORT,
  } as const
}

// The engine beneath the plugin: its own rows and host commands. The kit has no store beneath
// `session.append` (a test hook there is skipped), so a test's append rejects after the plugin ran.
function mockEngine(on: any) {
  mock.env(on, { HOME: '/home/test' })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.list', () => ({ value: [] }))

  return { runs }
}

test('a Read of a PNG draws the picture under the engine row, keeping its aspect', async ($, on) => {
  mockEngine(on)
  on('tool.call', () => ({ result: IMAGE_RESULT }))
  await $.tool.call({ tool: 'Read', file_path: '/work/shot.png', tool_use_id: 'tu-1' } as any)

  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-1', IMAGE_RESULT) })
  expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  const image = await row.find({ type: 'Image' })
  expect(image).toBeDefined()
  expect(image?.props.source).toEqual({ file: '/work/shot.png', format: 'png' })
  // 400x200 px in cells about twice as tall as wide: 40 columns by 10 rows.
  expect(image?.props.columns).toBe(40)
  expect(image?.props.rows).toBe(10)
  await row.unmount()
})

test(
  'cell metrics from the plugin options shape the preview',
  { options: { cellWidthPx: 20, cellHeightPx: 10 } },
  async ($, on) => {
    mockEngine(on)
    on('tool.call', () => ({ result: IMAGE_RESULT }))
    await $.tool.call({ tool: 'Read', file_path: '/work/shot.png', tool_use_id: 'tu-7' } as any)

    const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-7', IMAGE_RESULT) })
    const image = await row.find({ type: 'Image' })
    // 400x200 px at 20x10 px cells: 20 columns by 20 rows, the row cap bringing it to 16x16.
    expect(image?.props.columns).toBe(16)
    expect(image?.props.rows).toBe(16)
    await row.unmount()
  },
)

test(
  'a cell metric that is not a positive number falls back to the default',
  { options: { cellWidthPx: 0, cellHeightPx: -20 } },
  async ($, on) => {
    mockEngine(on)
    on('tool.call', () => ({ result: IMAGE_RESULT }))
    await $.tool.call({ tool: 'Read', file_path: '/work/shot.png', tool_use_id: 'tu-8' } as any)

    const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-8', IMAGE_RESULT) })
    const image = await row.find({ type: 'Image' })
    expect(image?.props.columns).toBe(40)
    expect(image?.props.rows).toBe(10)
    await row.unmount()
  },
)

test('an image result with nothing recorded still draws from its own bytes', async ($, on) => {
  mockEngine(on)
  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-2', IMAGE_RESULT) })
  const image = await row.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ png: PNG })
  await row.unmount()
})

test('a JPEG read is converted to a PNG file the terminal reads', async ($, on) => {
  const engine = mockEngine(on)
  const jpeg = { ...IMAGE_RESULT, file: { ...IMAGE_RESULT.file, base64: '/9j/4AAQ', type: 'image/jpeg' } }
  on('tool.call', () => ({ result: jpeg }))
  await $.tool.call({ tool: 'Read', file_path: '/work/photo.jpg', tool_use_id: 'tu-3' } as any)

  expect(engine.runs.some(argv => argv[0] === 'magick' && argv[1] === '/work/photo.jpg[0]')).toBe(true)
  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-3', jpeg) })
  const image = await row.find({ type: 'Image' })
  expect(image?.props.source).toEqual({
    file: '/home/test/.cache/claude-image-preview/tu-3.png',
    format: 'png',
  })
  await row.unmount()
})

test('a Read of a text file is left to the engine', async ($, on) => {
  mockEngine(on)
  on('tool.call', () => ({ result: TEXT_RESULT }))
  await $.tool.call({ tool: 'Read', file_path: '/work/notes.md', tool_use_id: 'tu-4' } as any)

  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-4', TEXT_RESULT) })
  expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  await row.unmount()
})

test('an image over 5 MB falls back to the engine row', async ($, on) => {
  mockEngine(on)
  const huge = { ...IMAGE_RESULT, file: { ...IMAGE_RESULT.file, originalSize: 6 * 1024 * 1024 } }
  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', ...resultRow('tu-5', huge) })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
  await row.unmount()
})

test('a pasted image is drawn under the prompt that carried it', async ($, on) => {
  mockEngine(on)
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

  const message = {
    component: 'UserMessage',
    props: { text: 'what is this [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  } as const
  // Matched by the row's id, or by its text when the transcript names the row otherwise.
  for (const requestId of ['u-1', 'msg-elsewhere']) {
    const row = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', requestId, ...message })
    expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    const image = await row.find({ type: 'Image' })
    expect(image?.props.source).toEqual({ png: PNG })
    expect(image?.props.alt).toMatch(/Image #1/)
    await row.unmount()
  }

  const plain = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    requestId: 'u-2',
    ...message,
    props: { ...message.props, text: 'no pictures here' },
  })
  expect(await plain.find({ type: 'Image' })).toBeUndefined()
  await plain.unmount()
})

test('two prompts with the same text draw nothing when the row id matches neither', async ($, on) => {
  mockEngine(on)
  const append = (uuid: string) =>
    $.session.append({
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid,
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'text', text: 'same words [Image #1]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ],
      },
    } as any).catch(() => undefined)
  await append('u-a')
  await append('u-b')

  const message = {
    component: 'UserMessage',
    props: { text: 'same words [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
    viewport: VIEWPORT,
  } as const
  // An id that is neither stored prompt's: the shared text is not enough to pick one.
  const ambiguous = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', requestId: 'msg-other', ...message })
  expect(await ambiguous.find({ type: 'Image' })).toBeUndefined()
  await ambiguous.unmount()

  // The row's own uuid still draws its picture.
  const own = await $.ui.mount({ plugin: 'image-preview', surface: 'terminal', requestId: 'u-b', ...message })
  expect(await own.find({ type: 'Image' })).toBeDefined()
  await own.unmount()
})

test('other surfaces get the engine row alone', async ($, on) => {
  mockEngine(on)
  const row = await $.ui.mount({ plugin: 'image-preview', surface: 'desktop', ...resultRow('tu-6', IMAGE_RESULT) })
  expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await row.unmount()
})
