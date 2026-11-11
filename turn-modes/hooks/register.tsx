import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mode, PendingPrompt } from '../types'

const DEFAULT_CHEAP_MODEL = 'haiku'
// Prefixed prompts whose turn never started (dropped, rewritten past recognition) age out past this many.
const KEPT_PENDING = 10

const pending = atom({ plugin: 'turn-modes', key: 'pending' } as const, [] as PendingPrompt[])
const turns = atom({ plugin: 'turn-modes', key: 'turns' } as const, {} as Record<string, Mode>)
const agents = atom({ plugin: 'turn-modes', key: 'agents' } as const, {} as Record<string, Mode>)
const active = atom({ plugin: 'turn-modes', key: 'active' } as const, null as string | null)

/**
 * The mode a prompt's first character asks for, and the prompt without it. Not a prefix: a doubled
 * one (`__init__.py`, `++`), `+` before a digit (`+1`), or a prefix with nothing after it.
 */
export function parsePrefix(text: string): { mode: Mode; text: string } | null {
  const [first, second] = text
  if ((first !== '_' && first !== '+') || second === undefined) return null
  if (second === '_' || second === '+' || (first === '+' && /\d/.test(second))) return null
  const rest = text.slice(1).trim()
  if (rest === '') return null

  return { mode: first === '_' ? 'cheap' : 'max', text: rest }
}

function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _, ...rest } = record

  return rest
}

export const register: Register = (on, options) => {
  const cheapOption = typeof options.cheapModel === 'string' ? options.cheapModel.trim() : ''
  const cheapModel = cheapOption === '' ? DEFAULT_CHEAP_MODEL : cheapOption
  const footer: Record<Mode, string> = { cheap: `↳ ran on ${cheapModel}`, max: '↳ effort max' }

  // The prefix leaves before the model reads the prompt; the mode waits for the turn that starts with it.
  on('prompt.submit', async ($, e, next) => {
    const parsed = parsePrefix(e.text)
    if (!parsed) return next(e)
    const entry: PendingPrompt = { text: parsed.text, mode: parsed.mode }
    await update($, pending, list => [...list, entry].slice(-KEPT_PENDING))
    const entered = await next({ ...e, text: parsed.text })
    if (entered.drop !== undefined) await update($, pending, list => list.filter(p => p !== entry))

    return entered
  })

  // Matched by text, never by order: a prompt typed during a running turn waits for a turn of its own.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const text = e.text.trim()
    const list = await read($, pending)
    const found = list.find(p => p.text === text) ?? (text === '' ? undefined : list.find(p => text.includes(p.text)))
    if (found) {
      await update($, pending, all => all.filter(p => p !== found))
      await update($, turns, all => ({ ...all, [e.turnId]: found.mode }))
    }
    await update($, active, () => e.turnId)

    return started
  })

  on('turn.step', async function* ($, e, next) {
    const mode = e.agentId === undefined ? (await read($, turns))[e.turnId] : (await read($, agents))[e.agentId]
    if (mode === 'cheap') return yield* next({ ...e, model: cheapModel })
    if (mode === 'max') return yield* next({ ...e, effort: 'max' })

    return yield* next(e)
  })

  // A subagent started inside a moded turn (or by such a subagent) inherits the mode.
  on('agent.spawn', async ($, e, next) => {
    const turnId = await read($, active)
    const mode =
      e.parentAgentId !== undefined
        ? (await read($, agents))[e.parentAgentId]
        : turnId !== null ? (await read($, turns))[turnId] : undefined
    const spawned = await next(mode === 'cheap' && !e.fork ? { ...e, model: cheapModel } : e)
    if (mode && spawned.deny === undefined && spawned.agentId !== undefined) {
      const agentId = spawned.agentId
      await update($, agents, all => ({ ...all, [agentId]: mode }))
    }

    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agents, all => without(all, agentId))
      return done
    }
    const mode = (await read($, turns))[e.turnId]
    await update($, turns, all => without(all, e.turnId))
    await update($, active, current => (current === e.turnId ? null : current))

    return mode ? { ...done, text: footer[mode] } : done
  })
}
