import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, PluginOptions, Register } from 'claude-code'

import type { PastedPrompt, Preview, PreviewOrigin, PreviewSource } from '../types'

// The box a preview may take in the transcript, in terminal cells.
const MAX_COLUMNS = 60
const MAX_ROWS = 16
// A terminal cell is about twice as tall as it is wide; these fill one cell until the options say otherwise.
const DEFAULT_CELL_WIDTH_PX = 10
const DEFAULT_CELL_HEIGHT_PX = 20
// Larger files fall back to the engine's text row.
const MAX_FILE_BYTES = 5 * 1024 * 1024
// The most an inline `{ png }` source may carry, decoded.
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const KEPT_PASTED = 10
const KEPT_READS = 50
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i
// Converted pictures are scaled down to this box before the terminal reads them.
const CONVERT_BOX = '1024x1024>'
// Converted pictures older than this are pruned from the cache folder.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// The dim label under a read preview: the theme's own key, not a fixed color.
const META_COLOR = 'inactive'
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const pasted = atom({ plugin: 'image-preview', key: 'pasted' } as const, [] as PastedPrompt[])
const reads = atom({ plugin: 'image-preview', key: 'reads' } as const, {} as Record<string, Preview>)

type ImageFile = {
  base64: string
  type: string
  originalSize?: number
  dimensions?: { originalWidth?: number; originalHeight?: number; displayWidth?: number; displayHeight?: number }
}

/** The image a Read returned, or null for any other result. */
function imageOf(output: unknown): ImageFile | null {
  const o = output as { type?: unknown; file?: Partial<ImageFile> } | null | undefined
  if (o?.type !== 'image' || typeof o.file?.base64 !== 'string' || typeof o.file.type !== 'string') return null

  return o.file as ImageFile
}

function decodedBytes(base64: string): number {
  return Math.floor((base64.replace(/=+$/, '').length * 3) / 4)
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are no PNG. */
function pngSize(base64: string): { width: number; height: number } | null {
  try {
    const head = atob(base64.slice(0, 32))
    if (head.slice(1, 4) !== 'PNG') return null
    const at = (i: number) =>
      ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0

    return { width: at(16), height: at(20) }
  } catch {
    return null
  }
}

function sizeOf(file: ImageFile): { width: number; height: number } | null {
  const d = file.dimensions
  const width = d?.originalWidth ?? d?.displayWidth
  const height = d?.originalHeight ?? d?.displayHeight
  if (width && height) return { width, height }

  return file.type === 'image/png' ? pngSize(file.base64) : null
}

/** One terminal cell in pixels, from the plugin options; a value that is not a positive number keeps the default. */
type CellMetrics = { widthPx: number; heightPx: number }

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function cellMetrics(options: PluginOptions): CellMetrics {
  return {
    widthPx: positiveOr(options.cellWidthPx, DEFAULT_CELL_WIDTH_PX),
    heightPx: positiveOr(options.cellHeightPx, DEFAULT_CELL_HEIGHT_PX),
  }
}

/** The cells a picture takes: as wide as it fits, its aspect kept, never larger than its own pixels. */
function fitCells(width: number, height: number, maxColumns: number, maxRows: number, cell: CellMetrics) {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  let columns = Math.min(maxColumns, Math.ceil(w / cell.widthPx))
  let rows = Math.round((columns * (h / w) * cell.widthPx) / cell.heightPx)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.round((rows * (w / h) * cell.heightPx) / cell.widthPx)
  }
  const clamp = (n: number) => Math.min(255, Math.max(1, n))

  return { columns: clamp(columns), rows: clamp(rows) }
}

/** `image/jpeg` → `JPEG`. */
function formatOf(mediaType: string): string {
  return (mediaType.split('/')[1] ?? mediaType).toUpperCase()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatAge(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))}m ago`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`

  return `${Math.floor(ms / DAY_MS)}d ago`
}

/** `{FORMAT} · {size}`, plus `· {age}` when the file still stats; the age is dropped, never the label. */
async function metaLabel($: EngineInterface, origin: PreviewOrigin): Promise<string> {
  const label = `${origin.format} · ${formatBytes(origin.bytes)}`
  const age = async () => {
    const [stat, now] = await Promise.all([$.fs.stat(origin.path), $.clock.now()])
    return formatAge(Math.max(0, now - stat.mtimeMs))
  }
  const shown = await age().catch(() => null)

  return shown ? `${label} · ${shown}` : label
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

async function cacheDir($: EngineInterface): Promise<string | null> {
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`
  if (cache.startsWith('undefined')) return null
  const dir = `${cache}/claude-image-preview`
  await pruneCache($, dir)

  return dir
}

/** The converted files in a cache listing that outlived the TTL, by name; dirs and links never go. */
export function staleCacheEntries(
  entries: ReadonlyArray<Pick<FsEntry, 'name' | 'kind' | 'mtimeMs' | 'isLink'>>,
  now: number,
  ttlMs: number,
): string[] {
  return entries
    .filter(entry => entry.kind === 'file' && !entry.isLink && entry.name.endsWith('.png') && now - entry.mtimeMs > ttlMs)
    .map(entry => entry.name)
}

// The one prune this process runs, from its first use of the cache.
let pruning: Promise<void> | null = null

/** Deletes the cache files past the TTL; best effort, never a reason to fail a conversion. */
function pruneCache($: EngineInterface, dir: string): Promise<void> {
  if (!pruning) {
    pruning = (async () => {
      const stale = staleCacheEntries(await $.fs.list(dir), Date.now(), CACHE_TTL_MS)
      if (stale.length > 0) await $.process.run(['rm', '-f', '--', ...stale.map(name => `${dir}/${name}`)])
    })().catch(() => undefined)
  }

  return pruning
}

/** Runs the first ImageMagick entry point found; false when none ran cleanly. */
async function magick($: EngineInterface, args: string[], stdin?: string): Promise<boolean> {
  for (const tool of ['magick', 'convert']) {
    try {
      const ran = await $.process.run([tool, ...args], stdin === undefined ? undefined : { stdin })
      if (ran.exitCode === 0) return true
    } catch {
      // Not installed under this name: try the next.
    }
  }

  return false
}

/** Converts an image file (JPEG, GIF, WebP) to a scaled PNG the terminal reads; its path, or null. */
async function convertFile($: EngineInterface, path: string, name: string): Promise<string | null> {
  const dir = await cacheDir($)
  if (!dir) return null
  const out = `${dir}/${name}.png`
  await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)

  return (await magick($, [`${path}[0]`, '-resize', CONVERT_BOX, `png:${out}`])) ? out : null
}

/** The preview of an image the Read tool returned: the PNG itself, or a converted copy of any other kind. */
async function readPreview($: EngineInterface, path: string, id: string, file: ImageFile): Promise<Preview | null> {
  if ((file.originalSize ?? 0) > MAX_FILE_BYTES) return null
  const size = sizeOf(file)
  if (!size) return null
  const alt = `[${basename(path)} ${size.width}×${size.height}]`
  // The person's own file: what the label describes and what Open opens, even when a converted copy is drawn.
  const origin: PreviewOrigin = { path, format: formatOf(file.type), bytes: file.originalSize ?? decodedBytes(file.base64) }
  if (file.type === 'image/png') return { source: { file: path, format: 'png' }, ...size, alt, origin }
  const out = await convertFile($, path, id)

  return out ? { source: { file: out, format: 'png' }, ...size, alt, origin } : null
}

/** The preview of a pasted image block: inline when it is a small PNG, a converted file otherwise. */
async function pastedPreview($: EngineInterface, uuid: string, index: number, mediaType: string, data: string) {
  const alt = `[Image #${index + 1}]`
  if (decodedBytes(data) > MAX_FILE_BYTES) return null
  const own = mediaType === 'image/png' ? pngSize(data) : null
  if (own && decodedBytes(data) <= MAX_INLINE_BYTES) return { source: { png: data }, ...own, alt } as Preview

  const dir = await cacheDir($)
  if (!dir) return null
  const out = `${dir}/${uuid}-${index}.png`
  await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
  // The bytes reach the converter as base64 text on stdin; the shell decodes them.
  const script = `base64 -d | { magick -[0] -resize '${CONVERT_BOX}' "png:$0" || convert -[0] -resize '${CONVERT_BOX}' "png:$0"; }`
  const ran = await $.process.run(['sh', '-c', script, out], { stdin: data }).catch(() => undefined)
  if (ran?.exitCode !== 0) return null
  const head = await $.fs.read(out, { as: 'bytes' }).catch(() => undefined)
  const size = head ? pngSize(head.base64) : null

  return size ? ({ source: { file: out, format: 'png' }, ...size, alt } as Preview) : null
}

function textOf(content: ReadonlyArray<Record<string, unknown>>): string {
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

/** Records the images of a prompt row, before the row is stored, so its drawing finds them. */
async function recordPasted($: EngineInterface, uuid: string, content: ReadonlyArray<Record<string, unknown>>) {
  const blocks = content.filter(b => b.type === 'image')
  if (blocks.length === 0) return
  const previews: Preview[] = []
  for (const [i, block] of blocks.entries()) {
    const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue
    const preview = await pastedPreview($, uuid, i, source.media_type ?? '', source.data)
    if (preview) previews.push(preview)
  }
  if (previews.length === 0) return
  const entry: PastedPrompt = { uuid, text: textOf(content), previews }
  await update($, pasted, list => [...list.filter(p => p.uuid !== uuid), entry].slice(-KEPT_PASTED))
}

async function recordRead($: EngineInterface, path: string, id: string, output: unknown) {
  const file = imageOf(output)
  if (!file) return
  const preview = await readPreview($, path, id, file)
  if (!preview) return
  await update($, reads, all => {
    const kept = Object.entries(all).slice(-(KEPT_READS - 1))
    return { ...Object.fromEntries(kept), [id]: preview }
  })
}

/** The preview of a Read result: what its call recorded, or its own PNG bytes when nothing was. */
async function previewOfResult($: EngineInterface, id: string, output: unknown): Promise<Preview | null> {
  const file = imageOf(output)
  if (!file || (file.originalSize ?? 0) > MAX_FILE_BYTES) return null
  const recorded = (await read($, reads))[id]
  if (recorded) return recorded
  const size = sizeOf(file)
  if (file.type !== 'image/png' || !size || decodedBytes(file.base64) > MAX_INLINE_BYTES) return null

  return { source: { png: file.base64 } as PreviewSource, ...size, alt: `[image ${size.width}×${size.height}]` }
}

/** Hands the file to the desktop's default viewer; a missing xdg-open leaves the preview as it is. */
async function openFile($: EngineInterface, path: string): Promise<void> {
  await $.process.run(['xdg-open', path]).catch(() => undefined)
}

function maxColumnsFor(viewport: { columns: number } | undefined): number {
  return Math.max(1, Math.min(MAX_COLUMNS, (viewport?.columns ?? MAX_COLUMNS + 4) - 4))
}

export const register: Register = (on, options) => {
  const cell = cellMetrics(options)

  // Image reads: a preview is prepared once the tool has answered, PNGs as they are and other kinds converted.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (!IMAGE_FILE.test(e.file_path) || !('result' in ran) || ran.result === undefined) return ran
    try {
      await recordRead($, e.file_path, e.tool_use_id ?? e.file_path, ran.result)
    } catch {
      // A preview that cannot be prepared leaves the engine's row as it is.
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Pasted images: the prompt row carries them as image blocks, recorded before the row is stored.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.message.role === 'user' && e.agentId === undefined) {
      try {
        await recordPasted($, e.uuid, e.message.content)
      } catch {
        // The prompt is stored either way.
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const text = e.props.text.trim()
    const list = await read($, pasted)
    // The row's id names its prompt; the text only when one stored prompt carries it alone.
    const sameText = text === '' ? [] : list.filter(p => p.text === text)
    const entry = list.find(p => p.uuid === e.requestId) ?? (sameText.length === 1 ? sameText[0] : undefined)
    if (!entry) return next(e)
    const { Box, Image } = $.ui.resolve(e)
    const maxColumns = maxColumnsFor(e.viewport)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {entry.previews.map((p, i) => (
          <Box key={`pasted-${i}`} marginLeft={2}>
            <Image source={p.source} {...fitCells(p.width, p.height, maxColumns, MAX_ROWS, cell)} alt={p.alt} />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored) return next(e)
    const preview = await previewOfResult($, e.props.tool_use_id, e.props.output)
    if (!preview) return next(e)
    const { Box, Image, Text, Button } = $.ui.resolve(e)
    const cells = fitCells(preview.width, preview.height, maxColumnsFor(e.viewport), MAX_ROWS, cell)
    const origin = preview.origin
    const label = origin ? await metaLabel($, origin) : null

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box marginLeft={2} flexDirection="column">
          <Image source={preview.source} {...cells} alt={preview.alt} />
          {origin && label && (
            <Box flexDirection="row" gap={1}>
              <Text color={META_COLOR}>{label}</Text>
              <Button key={`open-${e.props.tool_use_id}`} label="Open" plain onPress={() => openFile($, origin.path)} />
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  // A folded run of reads ("Read 2 files") draws the pictures among them under its count line.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)
    const previews: { id: string; preview: Preview; label: string | null }[] = []
    for (const call of e.props.calls) {
      if (call.tool !== 'Read' || call.isErrored || !call.tool_use_id) continue
      const preview = await previewOfResult($, call.tool_use_id, call.output)
      if (!preview) continue
      const label = preview.origin ? await metaLabel($, preview.origin) : null
      previews.push({ id: call.tool_use_id, preview, label })
    }
    if (previews.length === 0) return next(e)
    const { Box, Image, Text, Button } = $.ui.resolve(e)
    const maxColumns = maxColumnsFor(e.viewport)

    return (
      <Box flexDirection="column">
        {await next(e)}
        {previews.map(({ id, preview: p, label }, i) => (
          <Box key={`read-${i}`} marginLeft={2} flexDirection="column">
            <Image source={p.source} {...fitCells(p.width, p.height, maxColumns, MAX_ROWS, cell)} alt={p.alt} />
            {p.origin && label && (
              <Box flexDirection="row" gap={1}>
                <Text color={META_COLOR}>{label}</Text>
                <Button key={`open-${id}`} label="Open" plain onPress={() => openFile($, p.origin!.path)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
