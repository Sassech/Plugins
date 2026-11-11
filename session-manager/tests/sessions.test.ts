import { describe, expect, test } from 'claude-code/testing'

import {
  canDelete,
  formatDate,
  isSessionId,
  pageAround,
  projectKey,
  titleFromTranscript,
} from '../hooks/sessions'

const line = (entry: unknown) => JSON.stringify(entry)

describe('projectKey', () => {
  test('replaces slashes and dots with dashes, as ~/.claude/projects names folders', async () => {
    expect(projectKey('/home/sassech')).toBe('-home-sassech')
    expect(projectKey('/home/sassech/.config/opencode')).toBe('-home-sassech--config-opencode')
    expect(projectKey('/home/u/my_app v2')).toBe('-home-u-my-app-v2')
  })
})

describe('isSessionId', () => {
  test('accepts a UUID and nothing else', async () => {
    expect(isSessionId('15248dd7-1dc9-436b-b9fb-bb0411fb5576')).toBe(true)
    expect(isSessionId('15248dd7')).toBe(false)
    expect(isSessionId('../15248dd7-1dc9-436b-b9fb-bb0411fb5576')).toBe(false)
    expect(isSessionId('15248dd7-1dc9-436b-b9fb-bb0411fb5576.jsonl')).toBe(false)
  })
})

describe('titleFromTranscript', () => {
  test('uses the first real prompt, skipping meta rows and injected blocks', async () => {
    const text = [
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta caveat' } }),
      line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '  Fix   the\nlogin bug  ' }] },
      }),
      line({ type: 'user', message: { role: 'user', content: 'Second prompt' } }),
    ].join('\n')
    expect(titleFromTranscript(text)).toBe('Fix the login bug')
  })

  test('prefers a custom title, then an AI title, then a summary, the last one of each kind', async () => {
    const prompt = line({ type: 'user', message: { role: 'user', content: 'Prompt text' } })
    const summary = line({ type: 'summary', summary: 'A summary' })
    const ai = line({ type: 'ai-title', aiTitle: 'AI title' })
    const custom1 = line({ type: 'custom-title', customTitle: 'Old name' })
    const custom2 = line({ type: 'custom-title', customTitle: 'Renamed' })

    expect(titleFromTranscript([prompt, summary].join('\n'))).toBe('A summary')
    expect(titleFromTranscript([prompt, summary, ai].join('\n'))).toBe('AI title')
    expect(titleFromTranscript([custom1, prompt, ai, custom2].join('\n'))).toBe('Renamed')
  })

  test('ignores broken lines and a cut last line, and says when there is no prompt', async () => {
    const text = ['{not json', line({ type: 'mode', mode: 'x' }), '{"type":"user","mess'].join('\n')
    expect(titleFromTranscript(text)).toBe('(no prompt)')
  })

  test('truncates a long prompt', async () => {
    const long = 'word '.repeat(60)
    const title = titleFromTranscript(line({ type: 'user', message: { role: 'user', content: long } }))
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('canDelete', () => {
  test('refuses the current session and anything that is not a session id', async () => {
    const current = '15248dd7-1dc9-436b-b9fb-bb0411fb5576'
    const other = '30825fe3-4ee6-44a1-8be9-04e444e81bbf'
    expect(canDelete(other, current)).toEqual({ ok: true })
    expect(canDelete(current, current)).toEqual({ ok: false, reason: 'This is the current session: it cannot be deleted.' })
    expect(canDelete('nope', current).ok).toBe(false)
  })
})

describe('formatDate and pageAround', () => {
  test('formats a local date as YYYY-MM-DD HH:MM', async () => {
    expect(formatDate(new Date(2026, 9, 5, 7, 3).getTime())).toBe('2026-10-05 07:03')
  })

  test('keeps the cursor inside the window', async () => {
    expect(pageAround(0, 50, 10)).toEqual({ start: 0, end: 10 })
    expect(pageAround(25, 50, 10)).toEqual({ start: 20, end: 30 })
    expect(pageAround(49, 50, 10)).toEqual({ start: 40, end: 50 })
    expect(pageAround(3, 4, 10)).toEqual({ start: 0, end: 4 })
  })
})
