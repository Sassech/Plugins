/** What a prompt prefix asks of its turn: `_` the cheap model, `+` maximum effort. */
export type Mode = 'cheap' | 'max'

/** A prefixed prompt waiting for its turn, known by the text the turn will start with. */
export type PendingPrompt = { text: string; mode: Mode }

declare module 'claude-code' {
  interface PluginState {
    'turn-modes': {
      /** Prefixed prompts not yet matched to a turn, oldest first. */
      pending: PendingPrompt[]
      /** Main turns running under a mode, by turnId. */
      turns: Record<string, Mode>
      /** Subagents started inside a moded turn, by agentId. */
      agents: Record<string, Mode>
      /** The main turn running now, or null between turns. */
      active: string | null
    }
  }
}
