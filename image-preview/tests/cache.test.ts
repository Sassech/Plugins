import { expect, mock, test } from 'claude-code/testing'

import { staleCacheEntries } from '../hooks/register'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const DAY_MS = 24 * 60 * 60 * 1000

const entry = (name: string, mtimeMs: number, kind: 'file' | 'dir' | 'other' = 'file', isLink = false) => ({
  name,
  kind,
  size: 10,
  mtimeMs,
  isLink,
})

test('staleCacheEntries drops converted files past the TTL and keeps the rest', async () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  const entries = [
    entry('eight-days.png', now - 8 * DAY_MS),
    entry('seven-days.png', now - 7 * DAY_MS),
    entry('fresh.png', now - 1000),
    entry('notes.txt', now - 8 * DAY_MS),
    entry('folder.png', now - 8 * DAY_MS, 'dir'),
    entry('linked.png', now - 8 * DAY_MS, 'file', true),
  ]

  // Only a plain converted file strictly older than the TTL goes.
  expect(staleCacheEntries(entries, now, 7 * DAY_MS)).toEqual(['eight-days.png'])
})

function mockEngine(on: any) {
  mock.env(on, { HOME: '/home/test' })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const runs: string[][] = []
  on('process.run', ($: any, e: any) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))

  return { runs }
}

test('the first converted image prunes cache files older than a week', async ($, on) => {
  const engine = mockEngine(on)
  const old = Date.now() - 8 * DAY_MS
  on('fs.list', () => ({
    value: [
      entry('tu-old.png', old),
      entry('tu-fresh.png', Date.now() - 1000),
      entry('notes.txt', old),
    ],
  }))
  const jpeg = {
    type: 'image',
    file: { base64: '/9j/4AAQ', type: 'image/jpeg', originalSize: 70, dimensions: { originalWidth: 40, originalHeight: 20 } },
  }
  on('tool.call', () => ({ result: jpeg }))
  await $.tool.call({ tool: 'Read', file_path: '/work/photo.jpg', tool_use_id: 'tu-new' } as any)

  const removals = engine.runs.filter(argv => argv[0] === 'rm')
  expect(removals).toEqual([['rm', '-f', '--', '/home/test/.cache/claude-image-preview/tu-old.png']])
})
