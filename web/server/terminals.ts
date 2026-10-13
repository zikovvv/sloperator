import * as pty from 'node-pty'
import { agentEnv } from './engines.ts'

export interface TerminalHandle {
  id: string
  worktreeID: string
  title: string
  process: pty.IPty
  /** Recent output, so reopening a terminal shows what it already printed. */
  scrollback: string
}

const SCROLLBACK_LIMIT = 200_000
const terminals = new Map<string, TerminalHandle>()

/** Terminals belong to a worktree, not a session: the shell is about the checkout. */
/** A shell in the worktree; `command`, when given, is typed into it as if by the person. */
export function openTerminal(worktreeID: string, cwd: string, title: string, command?: string): TerminalHandle {
  const shell = process.env.SHELL || '/bin/zsh'
  // An empty LC_* makes every shell start with "cannot change locale" warnings.
  const env: Record<string, string> = {}
  // Only truthy values are copied, so there is never an empty LC_* left to strip.
  for (const [key, value] of Object.entries(agentEnv())) if (value) env[key] = value
  env.TERM = 'xterm-256color'
  env.LANG ||= 'en_US.UTF-8'
  const child = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
  const handle: TerminalHandle = { id: crypto.randomUUID(), worktreeID, title, process: child, scrollback: '' }
  child.onData((chunk) => {
    handle.scrollback = (handle.scrollback + chunk).slice(-SCROLLBACK_LIMIT)
  })
  child.onExit(() => terminals.delete(handle.id))
  terminals.set(handle.id, handle)
  if (command) child.write(`${command}\r`)
  return handle
}

export function getTerminal(id: string): TerminalHandle | undefined {
  return terminals.get(id)
}

export function listTerminals(worktreeID?: string) {
  return [...terminals.values()]
    .filter((handle) => !worktreeID || handle.worktreeID === worktreeID)
    .map((handle) => ({
      id: handle.id, worktreeID: handle.worktreeID, title: handle.title, pid: handle.process.pid,
    }))
}

export function closeTerminal(id: string): boolean {
  const handle = terminals.get(id)
  if (!handle) return false
  try { handle.process.kill() } catch { /* already gone */ }
  terminals.delete(id)
  return true
}

/** Quitting must not leave a shell (or anything it started) behind. */
export function closeAllTerminals() {
  for (const id of [...terminals.keys()]) closeTerminal(id)
}
