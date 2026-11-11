/** What an `Image` draws: inline PNG bytes (base64) or a PNG file the terminal reads itself. */
export type PreviewSource = { png: string } | { file: string; format: 'png' }

/** The person's own file behind a read preview: what its label describes and what Open opens. */
export type PreviewOrigin = { path: string; format: string; bytes: number }

/** One picture ready to draw, with its size in pixels so the box keeps its aspect. */
export type Preview = {
  source: PreviewSource
  width: number
  height: number
  alt: string
  /** Set for read previews only; pasted pictures have no file of their own. */
  origin?: PreviewOrigin
}

/** The pictures pasted into one prompt: the row is matched by its id, else by its text when one stored prompt carries it. */
export type PastedPrompt = {
  uuid: string
  text: string
  previews: Preview[]
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': {
      /** The latest prompts that carried pasted images, oldest first. */
      pasted: PastedPrompt[]
      /** Previews of image reads, by tool_use_id. */
      reads: Record<string, Preview>
    }
  }
}
