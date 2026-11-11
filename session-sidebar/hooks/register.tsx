import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { ContextReading, Limit, Tokens } from '../types'

const PANE = 'session-sidebar'
const PANE_TITLE = 'Session'
const REFRESH_MS = 3000
// How often a sidebar the terminal seated inline is looked for: soon after a resize, cheap otherwise.
const PLACEMENT_CHECK_MS = 500
// The fullscreen layout docks a pane beside the transcript from this many columns.
export const DOCK_COLUMNS = 110

// Theme keys, not fixed colors: the active Claude Code theme (built-in or custom) decides each one.
const C = {
  title: 'text',
  text: 'text',
  dim: 'inactive',
  muted: 'subtle',
  accent: 'claude',
  ok: 'success',
  warn: 'warning',
  err: 'error',
  info: 'suggestion',
} as const

const title = atom({ plugin: 'session-sidebar', key: 'title' } as const, null)
const tick = atom({ plugin: 'session-sidebar', key: 'tick' } as const, 0)
const limits = atom({ plugin: 'session-sidebar', key: 'limits' } as const, [] as Limit[])
const lastTurn = atom({ plugin: 'session-sidebar', key: 'lastTurn' } as const, null as Tokens | null)
const ZERO: Tokens = { input: 0, output: 0, cached: 0 }
const totals = atom({ plugin: 'session-sidebar', key: 'totals' } as const, ZERO)
// True while the person asked for the sidebar where it cannot dock (/sidebar on a narrow or main screen):
// it may sit inline until it docks again.
const inlineAllowed = atom({ plugin: 'session-sidebar', key: 'inlineAllowed' } as const, false)
// The last live context fill the engine reported: drawn as an estimate (~) while it reports none (after a
// resume or a compaction).
const lastContext = atom({ plugin: 'session-sidebar', key: 'lastContext' } as const, null as ContextReading | null)
const LIMIT_STORE_KEY = 'limits'
const TITLE_STORE_KEY = 'titles'
const DEFAULT_TITLE_MODEL = 'haiku'
const PROMPT_CHARS = 2000
const KEPT_TITLES = 100
const TITLE_WAIT_MS = 6000
const TITLE_SYSTEM =
  'You name coding sessions. Reply with a 3 to 6 word title for the task the user describes, ' +
  'in the same language as the task. Reply with the title only: no quotes, no trailing period.'

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Seat = { placement: 'dock' | 'inline'; isFullscreen: boolean | undefined }

// Where the terminal last seated the sidebar, as its drawing saw it. A drawing never writes state, so this
// plain note is how the placement check learns of it; a reload loses it and the next drawing notes it again.
let seenSeat: Seat | null = null
let isFitting = false
// The running session's timers, so a second session.start in one process replaces them instead of stacking.
let refreshTimer: Timer | null = null
let placementTimer: Timer | null = null

/** Notes where the terminal seated the sidebar; true when it sits inline above the prompt. */
function noteSeat(e: { surface: string; props: { placement: 'dock' | 'inline' }; viewport?: { isFullscreen?: boolean } }): boolean {
  if (e.surface !== 'terminal') return false
  seenSeat = { placement: e.props.placement, isFullscreen: e.viewport?.isFullscreen }

  return e.props.placement === 'inline'
}

/**
 * Keeps the sidebar a sidebar: one the terminal seated inline (a narrowed window) is closed, and on a
 * fullscreen terminal opened again unasked, so the engine holds it undrawn until the terminal is wide
 * enough to dock it. One the person asked for where it cannot dock stays until it docks once.
 */
async function fitSidebar($: EngineInterface) {
  const seat = seenSeat
  if (!seat || isFitting) return
  seenSeat = null
  isFitting = true
  try {
    const isAllowed = await read($, inlineAllowed)
    if (seat.placement === 'dock') {
      if (isAllowed) await update($, inlineAllowed, () => false)
      return
    }
    if (isAllowed) return
    // A pane the person closed meanwhile is gone from the list: nothing to do.
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (!pane?.isPlaced) return
    await $.ui.close({ id: PANE })
    if (seat.isFullscreen === true) await $.ui.open({ id: PANE, title: PANE_TITLE })
  } finally {
    isFitting = false
  }
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function shortTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

/** Keeps the latest rate-limit reading, also for the next session until a response reports again. */
async function rememberLimits($: EngineInterface, found: readonly SessionRateLimit[]) {
  if (found.length === 0) return
  const kept: Limit[] = found.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  await update($, limits, () => kept)
  await $.store.set(LIMIT_STORE_KEY, kept)
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`

  return `${s}s`
}

/** A prompt's own words: injected blocks (`<command-name>`, `<system-reminder>`, ...) and slash commands carry none. */
function promptOf(text: string): string | null {
  const plain = text
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z][\w-]*[^>]*>/gi, ' ')
    .trim()
  if (plain === '' || plain.startsWith('/')) return null

  return plain.slice(0, PROMPT_CHARS)
}

/** A model reply as a title: one line, no quotes, labels or trailing period. */
function cleanTitle(reply: string): string | null {
  const line = (reply.trim().split('\n')[0] ?? '')
    .replace(/^(title|t[ií]tulo)\s*:\s*/i, '')
    .replace(/^["'`*#\s]+|["'`*.\s]+$/g, '')
  return line === '' ? null : oneLine(line, 60)
}

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '━'.repeat(filled)
}

function rest(percent: number, width: number): string {
  return '─'.repeat(width - bar(percent, width).length)
}

function levelColor(percent: number) {
  if (percent >= 85) return C.err
  if (percent >= 60) return C.warn

  return C.ok
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h window',
  seven_day: 'Week',
  spend_limit: 'Spend limit',
}

type McpRow = { name: string; isConnected: boolean }

async function readJson($: any, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

async function mcpServers($: any): Promise<McpRow[]> {
  const connected = new Set<string>()
  for (const t of await $.tool.list()) {
    if (!t.mcp) continue
    const parts = String(t.name).split('__')
    const server = parts[1]
    if (parts.length >= 3 && server) connected.add(server)
  }

  const configured = new Set<string>()
  const disabled = new Set<string>()
  const home = await $.env.get('HOME')
  const root: string = await $.session.root()
  const userConfig = home ? await readJson($, `${home}/.claude.json`) : null
  for (const name of Object.keys(userConfig?.mcpServers ?? {})) configured.add(name)
  const project = userConfig?.projects?.[root]
  for (const name of Object.keys(project?.mcpServers ?? {})) configured.add(name)
  for (const name of project?.disabledMcpServers ?? []) disabled.add(name)
  const projectMcp = await readJson($, `${root}/.mcp.json`)
  for (const name of Object.keys(projectMcp?.mcpServers ?? {})) configured.add(name)

  const normalize = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')
  const rows = new Map<string, McpRow>()
  for (const name of connected) rows.set(name, { name, isConnected: true })
  for (const name of configured) {
    const key = normalize(name)
    if (!rows.has(key)) rows.set(key, { name, isConnected: false })
  }
  for (const name of disabled) {
    const key = normalize(name)
    if (!connected.has(key)) rows.set(key, { name, isConnected: false })
  }

  return [...rows.values()].sort((a, b) =>
    a.isConnected === b.isConnected ? a.name.localeCompare(b.name) : a.isConnected ? -1 : 1,
  )
}

/** Toggles one MCP server through `/mcp enable|disable <server>`, as if the person typed it. */
async function toggleMcp($: any, row: McpRow): Promise<void> {
  const verb = row.isConnected ? 'disable' : 'enable'
  try {
    await $.command.run({ command: 'mcp', args: `${verb} ${row.name}` })
    $.ui.toast(`MCP ${displayMcpName(row.name)}: ${verb}d`)
  } catch {
    $.ui.toast(`MCP ${displayMcpName(row.name)}: could not ${verb}`)
  }
}

function displayMcpName(name: string): string {
  return name.replace(/^plugin_([^_]+)_\1$/, '$1').replace(/^claude_ai_/, 'claude.ai ')
}

// Each session's title request, so each asks the model once.
const pendingTitles = new Map<string, Promise<string | null>>()
// Titles generated while this module is loaded, ahead of the store's write.
const generatedTitles = new Map<string, string>()

/** Asks the title model for a short title; null when it fails, and the prompt stays the title. */
async function generateTitle($: EngineInterface, sessionId: string, prompt: string, model: string): Promise<string | null> {
  const reply = await $.model.complete({ model, system: TITLE_SYSTEM, prompt, maxTokens: 30 })
  if (!reply.isAnswered) return null
  const generated = cleanTitle(reply.text)
  if (!generated) return null
  generatedTitles.set(sessionId, generated)
  if ((await $.session.id()) === sessionId) await update($, title, () => generated)
  const saved = await $.store.get(TITLE_STORE_KEY)
  const titles = saved && typeof saved === 'object' ? (saved as Record<string, string>) : {}
  const kept = Object.entries({ ...titles, [sessionId]: generated }).slice(-KEPT_TITLES)
  await $.store.set(TITLE_STORE_KEY, Object.fromEntries(kept))

  return generated
}

function titleSession($: EngineInterface, sessionId: string, prompt: string, model: string): Promise<string | null> {
  const pending = pendingTitles.get(sessionId)
  if (pending) return pending
  const started = generateTitle($, sessionId, prompt, model).catch(() => null)
  pendingTitles.set(sessionId, started)

  return started
}

/** The title generated for a session, in this load or an earlier one. */
async function knownTitle($: EngineInterface, sessionId: string): Promise<string | null> {
  const generated = generatedTitles.get(sessionId)
  if (generated) return generated
  const saved = await $.store.get(TITLE_STORE_KEY)
  const stored = saved && typeof saved === 'object' ? (saved as Record<string, string>)[sessionId] : undefined

  return typeof stored === 'string' ? stored : null
}

/** Waits for a session's title up to TITLE_WAIT_MS; null past it. */
async function titleWithin($: EngineInterface, sessionId: string, prompt: string, model: string): Promise<string | null> {
  const timeout = $.clock.sleep(TITLE_WAIT_MS).then(() => null)

  return Promise.race([titleSession($, sessionId, prompt, model), timeout])
}

const HEX = /^#[0-9a-f]{6}$/i
const KITTY_DEPTH = 3

/** The `background` a kitty config sets, following its `include`s; the last one read wins. */
async function kittyBackground($: EngineInterface, path: string, depth: number): Promise<string | undefined> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return undefined
  }
  const dir = path.slice(0, path.lastIndexOf('/'))
  let found: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const color = /^background\s+(#[0-9a-f]{6})\b/i.exec(line)
    if (color) found = color[1]
    const include = /^include\s+(.+)$/.exec(line)
    if (include?.[1] && depth > 0) {
      const target = include[1].trim()
      const nested = await kittyBackground($, target.startsWith('/') ? target : `${dir}/${target}`, depth - 1)
      if (nested) found = nested
    }
  }

  return found
}

/** The pane's background: the option's color, none, or (auto) the terminal's own where it can be read. */
async function paneBackground($: EngineInterface, option: string): Promise<string | undefined> {
  if (HEX.test(option)) return option
  if (option !== 'auto') return undefined
  const home = await $.env.get('HOME')
  if (!home || (await $.env.get('TERM')) !== 'xterm-kitty') return undefined

  return kittyBackground($, `${home}/.config/kitty/kitty.conf`, KITTY_DEPTH)
}

/** Keeps a live context fill for the moments the engine has none to report. */
async function rememberContext($: EngineInterface, context: { tokens?: number; percent?: number }) {
  if (context.percent === undefined) return
  const reading: ContextReading = { tokens: context.tokens, percent: context.percent }
  await update($, lastContext, () => reading)
}

/** One rate-limit window on one line: label, bar, percent and the reset countdown. */
function limitBarWidth(width: number, label: string, percent: string, countdown: string): number {
  return Math.max(4, Math.min(24, width - label.length - percent.length - countdown.length - 1))
}

export const register: Register = (on, options) => {
  const backgroundOption = String(options.background ?? 'auto').trim()
  const titleModelOption = typeof options.titleModel === 'string' ? options.titleModel.trim() : ''
  const titleModel = titleModelOption === '' ? DEFAULT_TITLE_MODEL : titleModelOption
  let background: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sidebar',
      description: 'Open the session sidebar (model, context, limits, MCP)',
    })
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: PANE_TITLE }).then(opened => {
        if (!opened.isPlaced) $.ui.toast(`Sidebar waits for a wider terminal (${DOCK_COLUMNS} cols) · /sidebar opens it now`)
      }).catch(() => undefined)
    }
    const loadLimits = async () => {
      const saved = await $.store.get(LIMIT_STORE_KEY)
      if (Array.isArray(saved)) await update($, limits, () => saved as Limit[])
      const usage = await $.session.usage()
      await rememberLimits($, usage.rateLimits)
      await rememberContext($, usage.context)
    }
    await loadLimits().catch(() => undefined)
    background = await paneBackground($, backgroundOption).catch(() => undefined)
    // Subagent history this plugin once kept: dropped, so it does not linger in the store.
    await $.store.delete('agentSessions').catch(() => undefined)
    refreshTimer?.cancel()
    placementTimer?.cancel()
    refreshTimer = $.clock.every(REFRESH_MS, () => {
      void update($, tick, n => (n + 1) % 1_000_000)
    })
    placementTimer = $.clock.every(PLACEMENT_CHECK_MS, () => {
      void fitSidebar($).catch(() => undefined)
    })

    const findTitle = async () => {
      const sessionId = await $.session.id()
      const generated = await knownTitle($, sessionId)
      if (generated) {
        await update($, title, () => generated)
        return
      }
      let prompt: string | null = null
      for (const m of await $.session.messages()) {
        if (m.role !== 'user') continue
        prompt = promptOf(m.text ?? '')
        if (prompt) break
      }
      // A title generated meanwhile wins over the prompt.
      await update($, title, () => generatedTitles.get(sessionId) ?? (prompt ? oneLine(prompt, 80) : null))
      if (prompt) void titleSession($, sessionId, prompt, titleModel)
    }
    // Also after /clear and reloads: a saved title, else the first real prompt while one is generated.
    await findTitle().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'sidebar' }, async ($, e) => {
    // Asked for, it shows even where it cannot dock; a later narrowing hides it again once it docked.
    const canDock = e.presentation.isFullscreen && e.presentation.columns >= DOCK_COLUMNS
    await update($, inlineAllowed, () => !canDock).catch(() => undefined)
    await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: 'Sidebar opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    seenSeat = null

    return closed
  })

  // Claude Code's own session title (the /resume list, the exit line): kept when one exists,
  // else the generated one, waited for up to TITLE_WAIT_MS on the first prompt.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const known = async () => {
      if (e.session_title) {
        await update($, title, () => e.session_title ?? null)
        return null
      }
      return knownTitle($, await $.session.id())
    }
    const sessionTitle = await known().catch(() => null)

    return sessionTitle ? { ...result, sessionTitle } : result
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    const find = async () => {
      if (e.session_title) {
        await update($, title, () => e.session_title ?? null)
        return null
      }
      const sessionId = await $.session.id()
      const known = await knownTitle($, sessionId)
      if (known) return known
      const prompt = promptOf(e.prompt)

      return prompt ? titleWithin($, sessionId, prompt, titleModel) : null
    }
    const sessionTitle = await find().catch(() => null)

    return sessionTitle ? { ...result, sessionTitle } : result
  })

  on('session.measure', async ($, e, next) => {
    await rememberLimits($, e.rateLimits).catch(() => undefined)
    await rememberContext($, e.context).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (e.agentId === undefined && usage) {
      const turn: Tokens = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cached: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      }
      const record = async () => {
        await update($, lastTurn, () => turn)
        await update($, totals, t => ({
          input: t.input + turn.input,
          output: t.output + turn.output,
          cached: t.cached + turn.cached,
        }))
      }
      await record().catch(() => undefined)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const setTitle = async () => {
      const prompt = promptOf(e.text)
      if ((await read($, title)) !== null || !prompt) return
      await update($, title, () => oneLine(prompt, 80))
      void titleSession($, await $.session.id(), prompt, titleModel)
    }
    await setTitle().catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Seated inline unasked, it draws nothing (the frame shrinks to its border) until the check closes it.
    if (noteSeat(e) && !(await read($, inlineAllowed))) return <Box />
    await read($, tick)

    const width = Math.max(20, (e.props as { bodyColumns?: number }).bodyColumns ?? 36)
    const barWidth = Math.max(8, Math.min(24, width - 8))
    const now = await $.clock.now()

    const [shownLimits, turnTokens, sessionTokens, storedContext] = await Promise.all([
      read($, limits),
      read($, lastTurn),
      read($, totals),
      read($, lastContext),
    ])
    const [sessionTitle, model, usage, turns, repo, version, servers] = await Promise.all([
      read($, title),
      $.session.model(),
      $.session.usage(),
      $.session.turns(),
      $.session.repo().catch(() => null),
      $.session.version(),
      mcpServers($).catch(() => [] as McpRow[]),
    ])

    const ctx = usage.context
    // No live fill: the last one observed, marked as an estimate; none ever observed keeps the dash.
    const estimate = ctx.percent === undefined ? storedContext : null
    const mark = estimate ? '~' : ''
    const ctxPercent = ctx.percent ?? estimate?.percent ?? 0
    const ctxTokens = estimate ? estimate.tokens : ctx.tokens
    const liveLimits: Limit[] = usage.rateLimits.length > 0 ? usage.rateLimits : shownLimits
    const repoLabel = repo?.name ?? ''

    const heading = (label: string) => (
      <Text bold color={C.title}>
        {label}
      </Text>
    )

    const rows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows

    return (
      <Box flexDirection="column" gap={1} backgroundColor={background} width={width} minHeight={rows}>
        <Box flexDirection="column">
          <Text bold color={C.title} wrap="wrap">
            {sessionTitle ?? 'New session'}
          </Text>
          <Text color={C.accent} wrap="truncate-end">
            ◆ {model}
          </Text>
          <Text color={C.dim} wrap="truncate-end">
            v{version.version} · {turns} prompts · {formatDuration(now - usage.startedAt)}
          </Text>
          {repoLabel !== '' && (
            <Text color={C.dim} wrap="truncate-end">
              ⎇ {repoLabel}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {heading('Context')}
          <Text color={C.text}>
            {ctxTokens !== undefined ? `${mark}${formatTokens(ctxTokens)}` : '—'} / {formatTokens(ctx.window)} tokens
          </Text>
          <Text>
            <Text color={levelColor(ctxPercent)}>{bar(ctxPercent, barWidth)}</Text>
            <Text color={C.dim}>{rest(ctxPercent, barWidth)}</Text>
            <Text color={C.text}> {mark}{ctxPercent}%</Text>
          </Text>
          <Text color={C.text}>${(usage.cost?.usd ?? 0).toFixed(2)} spent</Text>
          {turnTokens && (
            <Text color={C.dim} wrap="truncate-end">
              last ↑ {shortTokens(turnTokens.input)} ↓ {shortTokens(turnTokens.output)} cache {shortTokens(turnTokens.cached)}
            </Text>
          )}
          {turnTokens && (
            <Text color={C.dim} wrap="truncate-end">
              total ↑ {shortTokens(sessionTokens.input)} ↓ {shortTokens(sessionTokens.output)}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {heading('Usage limits')}
          {liveLimits.length === 0 && <Text color={C.dim}>No reading yet (after first reply).</Text>}
          {liveLimits.map(limit => {
            const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
            const hasReset = Number.isFinite(resetIn) && resetIn <= 0
            const used = hasReset ? 0 : limit.percentUsed
            const label = LIMIT_LABELS[limit.kind] ?? limit.kind
            const percent = ` ${used}%`
            const countdown = Number.isFinite(resetIn) && !hasReset ? ` · ${formatDuration(resetIn)}` : ''
            const limitWidth = limitBarWidth(width, `${label} `, percent, countdown)

            return (
              <Text key={`limit-${limit.kind}`} wrap="truncate-end">
                <Text color={C.text}>{label} </Text>
                <Text color={levelColor(used)}>{bar(used, limitWidth)}</Text>
                <Text color={C.dim}>{rest(used, limitWidth)}</Text>
                <Text color={C.text}>{percent}</Text>
                <Text color={C.dim}>{countdown}</Text>
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="column">
          {heading('MCP')}
          {servers.length === 0 && <Text color={C.dim}>No MCP servers.</Text>}
          {servers.map(s => (
            <Box key={`mcp-${s.name}`} flexDirection="row">
              <Button
                key={`mcp-toggle-${s.name}`}
                label={s.isConnected ? '●' : '○'}
                plain
                onPress={() => toggleMcp($, s)}
              />
              <Text wrap="truncate-end">
                <Text color={C.text}> {displayMcpName(s.name)} </Text>
                <Text color={s.isConnected ? C.ok : C.dim}>{s.isConnected ? 'Connected' : 'Inactive'}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
