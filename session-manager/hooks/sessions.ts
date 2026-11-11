// Pure helpers: no `$`, so the tests call them directly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TITLE_CHARS = 80
export const NO_PROMPT = '(no prompt)'

/** The folder name Claude Code keeps a project's transcripts under: every non-alphanumeric becomes `-`. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Whether `id` is a session id (a UUID): the only names the mod ever lists or deletes. */
export function isSessionId(id: string): boolean {
  return UUID.test(id)
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

type Entry = {
  type?: unknown
  isMeta?: unknown
  customTitle?: unknown
  aiTitle?: unknown
  summary?: unknown
  message?: { content?: unknown }
}

/** A user row's own words, or null for injected blocks (`<command-name>`, ...) and tool results. */
function promptOf(entry: Entry): string | null {
  if (entry.isMeta === true) return null
  const content = entry.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text = block.text
        break
      }
    }
  }
  const trimmed = text.trim()
  return trimmed === '' || trimmed.startsWith('<') ? null : trimmed
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : null)

/**
 * The title a transcript (`<id>.jsonl` text) is listed under: its last custom title, else its last
 * AI title, else its last summary, else its first real prompt; `(no prompt)` when it has none.
 */
export function titleFromTranscript(text: string): string {
  let custom: string | null = null
  let ai: string | null = null
  let summary: string | null = null
  let prompt: string | null = null
  for (const raw of text.split('\n')) {
    // Cheap filter first: most rows are assistant turns and attachments.
    const isTitle = raw.includes('-title"') || raw.includes('"summary"')
    if (!isTitle && (prompt !== null || !raw.includes('"user"'))) continue
    let entry: Entry
    try {
      entry = JSON.parse(raw) as Entry
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'custom-title') custom = nonEmpty(entry.customTitle) ?? custom
    else if (entry.type === 'ai-title') ai = nonEmpty(entry.aiTitle) ?? ai
    else if (entry.type === 'summary') summary = nonEmpty(entry.summary) ?? summary
    else if (entry.type === 'user' && prompt === null) prompt = promptOf(entry)
  }
  const title = custom ?? ai ?? summary ?? prompt
  return title === null ? NO_PROMPT : oneLine(title, TITLE_CHARS)
}

export type DeleteCheck = { ok: true } | { ok: false; reason: string }

/** The mod's own guard before it runs the delete script (which checks again). */
export function canDelete(id: string, currentId: string): DeleteCheck {
  if (!isSessionId(id)) return { ok: false, reason: `Not a session id: ${id}` }
  if (id === currentId) return { ok: false, reason: 'This is the current session: it cannot be deleted.' }
  return { ok: true }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD HH:MM`. */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The slice `[start, end)` of `total` rows that shows `size` rows with `cursor` kept in view, centred when it can be. */
export function pageAround(cursor: number, total: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total }
  const start = Math.min(Math.max(0, cursor - Math.floor(size / 2)), total - size)
  return { start, end: start + size }
}
