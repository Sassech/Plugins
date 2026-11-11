/** One saved conversation of the current project, as the list draws it. */
export type SessionRow = {
  id: string
  title: string
  mtimeMs: number
  isCurrent: boolean
}

/** Where the list was read from: the project's transcript folder and the running session. */
export type SessionContext = {
  /** The project's transcript folder, `~/.claude/projects/<project-key>`. */
  dir: string
  /** The session's project root, shown in the header. */
  root: string
  currentId: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-manager': {
      /** The listed conversations, newest first; null while loading. */
      rows: SessionRow[] | null
      context: SessionContext | null
      /** The id of the highlighted row. */
      cursor: string | null
      /** The id waiting for delete confirmation, if any. */
      pending: string | null
      /** One line of feedback (an error or a refusal), cleared by the next action. */
      notice: string | null
    }
  }
}
