/** One rate-limit window, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Token counts of a turn or of the whole session. */
export type Tokens = { input: number; output: number; cached: number }

/** A live context fill, kept to draw as an estimate while the engine reports none. */
export type ContextReading = { tokens?: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'session-sidebar': {
      title: string | null
      tick: number
      limits: Limit[]
      lastTurn: Tokens | null
      totals: Tokens
      /** The person asked for the sidebar where it cannot dock: it may sit inline until it docks again. */
      inlineAllowed: boolean
      lastContext: ContextReading | null
    }
  }
}
