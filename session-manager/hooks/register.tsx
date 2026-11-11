import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SessionContext, SessionRow } from '../types'
import { canDelete, formatDate, isSessionId, oneLine, pageAround, projectKey, titleFromTranscript } from './sessions'

type $ = EngineInterface

const PANE = 'session-manager'
const PANE_TITLE = 'Sessions'
// `$.fs.read` refuses files over 4 MiB: bigger transcripts are read in part through `head` and `grep`.
const READ_LIMIT = 4 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024
const READ_BATCH = 8
// Header, hint and feedback lines around the list.
const CHROME_ROWS = 5

// Theme keys, not fixed colors: the active Claude Code theme (built-in or custom) decides each one.
const C = {
  text: 'text',
  dim: 'inactive',
  accent: 'claude',
  warn: 'warning',
  err: 'error',
} as const

const rows = atom({ plugin: 'session-manager', key: 'rows' } as const, null as SessionRow[] | null)
const context = atom({ plugin: 'session-manager', key: 'context' } as const, null as SessionContext | null)
const cursor = atom({ plugin: 'session-manager', key: 'cursor' } as const, null as string | null)
const pending = atom({ plugin: 'session-manager', key: 'pending' } as const, null as string | null)
const notice = atom({ plugin: 'session-manager', key: 'notice' } as const, null as string | null)

// Titles by id, size and time: a transcript that did not change is not read again. Lost on reload, by design.
const titles = new Map<string, string>()

const short = (id: string) => id.slice(0, 8)

/** The running session and the folder its transcript lives in. */
async function locate($: $): Promise<SessionContext> {
  const currentId = await $.session.id()
  const root = await $.session.root()
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const projects = `${configDir.replace(/\/+$/, '')}/projects`
  const guess = `${projects}/${projectKey(root)}`
  if (await $.fs.exists(`${guess}/${currentId}.jsonl`).catch(() => false)) return { dir: guess, root, currentId }
  // Long paths are hashed into the key: find the folder that holds this session's transcript instead.
  const folders = await $.fs.list(projects).catch(() => [])
  for (const folder of folders) {
    if (folder.kind !== 'dir') continue
    const dir = `${projects}/${folder.name}`
    if (await $.fs.exists(`${dir}/${currentId}.jsonl`).catch(() => false)) return { dir, root, currentId }
  }
  // A new session writes its transcript on the first prompt: the computed folder is still the right one.
  return { dir: guess, root, currentId }
}

async function readTitle($: $, path: string, size: number): Promise<string> {
  if (size <= READ_LIMIT) return titleFromTranscript(await $.fs.read(path))
  const head = await $.process.run(['head', '-c', String(HEAD_BYTES), path])
  const named = await $.process.run(['grep', '-E', '"type":"(custom-title|ai-title|summary)"', path])
  // The head first: later title rows (grep keeps file order) win over earlier ones.
  return titleFromTranscript(`${head.stdout}\n${named.stdout}`)
}

async function listSessions($: $, ctx: SessionContext): Promise<SessionRow[]> {
  const entries = await $.fs.list(ctx.dir).catch(() => [])
  const files = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .map(entry => ({ ...entry, id: entry.name.slice(0, -'.jsonl'.length) }))
    .filter(entry => isSessionId(entry.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const found: SessionRow[] = []
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = files.slice(i, i + READ_BATCH)
    const named = await Promise.all(
      batch.map(async file => {
        const cacheKey = `${file.id}:${file.size}:${file.mtimeMs}`
        let title = titles.get(cacheKey)
        if (title === undefined) {
          title = await readTitle($, `${ctx.dir}/${file.name}`, file.size).catch(() => '(unreadable)')
          titles.set(cacheKey, title)
        }
        return { id: file.id, title, mtimeMs: file.mtimeMs, isCurrent: file.id === ctx.currentId }
      }),
    )
    found.push(...named)
  }
  return found
}

async function reload($: $) {
  const ctx = (await read($, context)) ?? (await locate($))
  await update($, context, () => ctx)
  const list = await listSessions($, ctx)
  await update($, rows, () => list)
  // Keep the highlight on the same conversation; else the first.
  await update($, cursor, id => (list.some(row => row.id === id) ? id : (list[0]?.id ?? null)))
}

async function say($: $, text: string | null) {
  await update($, notice, () => text)
}

async function move($: $, delta: number) {
  const list = (await read($, rows)) ?? []
  if (list.length === 0) return
  const cursorId = await read($, cursor)
  const index = Math.max(0, list.findIndex(row => row.id === cursorId))
  const target = list[Math.min(list.length - 1, Math.max(0, index + delta))]
  if (!target) return
  await update($, cursor, () => target.id)
  await update($, pending, () => null)
  await say($, null)
  // Move the focus ring too, so Enter resumes the highlighted row.
  await $.ui.focus({ requestId: PANE, key: `row:${target.id}` }).catch(() => undefined)
}

/** `ctrl+d`'s stand-in (`d`): the first press asks, a second press on the same row confirms. */
async function askDelete($: $) {
  const id = await read($, cursor)
  const ctx = await read($, context)
  if (id === null || ctx === null) return
  const check = canDelete(id, ctx.currentId)
  if (!check.ok) {
    await update($, pending, () => null)
    await say($, check.reason)
    return
  }
  if ((await read($, pending)) === id) {
    await confirmDelete($)
    return
  }
  await say($, null)
  await update($, pending, () => id)
}

async function cancelDelete($: $) {
  await update($, pending, () => null)
  await say($, null)
}

async function confirmDelete($: $) {
  const id = await read($, pending)
  const ctx = await read($, context)
  await update($, pending, () => null)
  if (id === null || ctx === null) return
  const check = canDelete(id, ctx.currentId)
  if (!check.ok) {
    await say($, check.reason)
    return
  }
  const script = `${$.plugin.root}/scripts/delete-session.sh`
  const ran = await $.process
    .run(['bash', script, ctx.dir, id, ctx.currentId], { timeoutMs: 15_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (ran.exitCode !== 0) {
    await say($, oneLine(ran.stderr || ran.stdout || `delete failed (exit ${ran.exitCode})`, 300))
    return
  }
  await say($, null)
  $.ui.toast(`Deleted session ${short(id)}`)
  await reload($)
}

/**
 * Resumes through the built-in `/resume <id>`, the one resume path a plugin has (`$.command.run`).
 * Where that is refused, the shell command is copied and shown instead.
 */
async function resume($: $, id: string, surface: RenderSurface) {
  const ctx = await read($, context)
  if (ctx?.currentId === id) {
    $.ui.toast('That is the current session.')
    return
  }
  await update($, pending, () => null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  const shell = `claude --resume ${id}`
  void $.command.run({ command: 'resume', args: id }).catch(async () => {
    const copied = await $.ui.copy({ text: shell, surface }).catch(() => ({ isCopied: false }))
    $.ui.toast(copied.isCopied ? `Copied: ${shell}` : `Run: ${shell}`)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'List, resume and delete the conversations of this project',
    })
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await update($, context, () => null)
    await update($, pending, () => null)
    await update($, notice, () => null)
    await update($, rows, () => null)
    // A dialog: it takes the keys, the arrows walk the rows, Esc closes it.
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true, holdToasts: true, rows: 20 })
    await reload($).catch(async (error: unknown) => {
      await update($, rows, () => [])
      await say($, `Could not list sessions: ${String(error)}`)
    })
    return {}
  })

  // The highlighted row follows the focus ring (arrows, Tab, a click).
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    const element = e.element ?? ''
    if (moved.deny === undefined && element.startsWith('row:')) {
      const id = element.slice('row:'.length)
      if ((await read($, cursor)) !== id) {
        await update($, cursor, () => id)
        await update($, pending, () => null)
        await say($, null)
      }
    }
    return moved
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, pending, () => null).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const ctx = await read($, context)
    const cursorId = await read($, cursor)
    const pendingId = await read($, pending)
    const feedback = await read($, notice)
    const width = Math.max(40, e.props.bodyColumns)

    const header = (
      <Text bold color={C.text} wrap="truncate-end">
        Conversations{ctx ? <Text color={C.dim}> · {ctx.root}</Text> : null}
        {list ? <Text color={C.dim}> · {list.length}</Text> : null}
      </Text>
    )
    if (list === null) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={C.dim}>Loading…</Text>
        </Box>
      )
    }

    const room = Math.max(3, (e.props.scroll?.bodyRows ?? 20) - CHROME_ROWS)
    const index = Math.max(0, list.findIndex(row => row.id === cursorId))
    const { start, end } = pageAround(index, list.length, room)
    // marker(2) + date(16) + gaps(4) + id(8) + " (current)"(10)
    const titleWidth = Math.max(10, width - 40)
    const pendingRow = list.find(row => row.id === pendingId)

    return (
      <Box flexDirection="column">
        {header}
        {list.length === 0 && <Text color={C.dim}>No saved conversations for this project yet.</Text>}
        {start > 0 && <Text color={C.dim}>  ↑ {start} newer</Text>}
        {list.slice(start, end).map(row => {
          const isCursor = row.id === cursorId
          const title = oneLine(row.title, titleWidth).padEnd(titleWidth)
          const tag = row.isCurrent ? ' (current)' : ''
          return (
            <Box key={`line:${row.id}`} flexDirection="row">
              <Text color={C.accent}>{isCursor ? '› ' : '  '}</Text>
              <Button
                key={`row:${row.id}`}
                plain
                autoFocus={isCursor ? true : undefined}
                dimColor={!isCursor}
                label={`${formatDate(row.mtimeMs)}  ${title}  ${short(row.id)}${tag}`}
                onPress={press => void resume($, row.id, press.surface)}
              />
            </Box>
          )
        })}
        {end < list.length && <Text color={C.dim}>  ↓ {list.length - end} older</Text>}
        {pendingRow ? (
          <Box flexDirection="row" gap={1}>
            <Text color={C.warn}>
              Delete "{oneLine(pendingRow.title, 40)}" ({short(pendingRow.id)})?
            </Text>
            <Button key="confirm-yes" hotkey="y" plain variant="primary" label="yes, delete" onPress={() => void confirmDelete($)} />
            <Button key="delete" hotkey="d" plain label="confirm" onPress={() => void askDelete($)} />
            <Button key="confirm-no" hotkey="n" plain label="cancel" onPress={() => void cancelDelete($)} />
          </Box>
        ) : (
          <Box flexDirection="row" gap={2}>
            <Text color={C.dim}>↑/↓ move · enter resume · esc close</Text>
            <Button key="up" hotkey="k" plain dimColor label="up" onPress={() => void move($, -1)} />
            <Button key="down" hotkey="j" plain dimColor label="down" onPress={() => void move($, 1)} />
            <Button key="delete" hotkey="d" plain dimColor label="delete" onPress={() => void askDelete($)} />
            <Button key="refresh" hotkey="r" plain dimColor label="refresh" onPress={() => void reload($)} />
          </Box>
        )}
        {feedback !== null && (
          <Text color={C.err} wrap="wrap">
            {feedback}
          </Text>
        )}
      </Box>
    )
  })
}
