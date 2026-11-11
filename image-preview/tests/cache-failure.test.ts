import { expect, mock, test } from 'claude-code/testing'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// A cache folder the plugin cannot list: pruning is best effort, so the picture still draws.
test('an unreadable cache folder leaves the preview intact', async ($, on) => {
  mock.env(on, { HOME: '/home/test' })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.list', () => ({ deny: 'outside the project' }))
  const jpeg = {
    type: 'image',
    file: { base64: '/9j/4AAQ', type: 'image/jpeg', originalSize: 70, dimensions: { originalWidth: 40, originalHeight: 20 } },
  }
  on('tool.call', () => ({ result: jpeg }))
  await $.tool.call({ tool: 'Read', file_path: '/work/photo.jpg', tool_use_id: 'tu-1' } as any)

  expect(runs.some(argv => argv[0] === 'rm')).toBe(false)
  const row = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'tu-1',
    props: { tool_use_id: 'tu-1', tool: 'Read', output: jpeg, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })
  const image = await row.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: '/home/test/.cache/claude-image-preview/tu-1.png', format: 'png' })
  await row.unmount()
})
