import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentRow, AgentTranscript } from '../shared/types.ts'
import { parseClaudeLine } from './engines.ts'

/** Claude Code keeps each project under its path with every character that is not a letter or digit made a dash. */
export function claudeProjectDir(worktreePath: string): string {
  const root = process.env.ORCHESTRATOR_CLAUDE_PROJECTS ?? join(homedir(), '.claude/projects')
  return join(root, worktreePath.replace(/[^A-Za-z0-9]/g, '-'))
}

const HEAD_BYTES = 16 * 1024
const TAIL_BYTES = 64 * 1024
const ROW_LIMIT = 40

/**
 * What each subagent of a Claude session has done, from the transcript Claude Code writes for it
 * as it goes: the prompt it was given and the last things it said and ran.
 */
export function subagentTranscripts(worktreePath: string, claudeSessionID: string | null | undefined, now = Date.now()): AgentTranscript[] {
  if (!claudeSessionID) return []
  const directory = join(claudeProjectDir(worktreePath), claudeSessionID, 'subagents')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => /^agent-.+\.jsonl$/.test(name))
    .map((name) => readTranscript(join(directory, name), name.replace(/^agent-|\.jsonl$/g, ''), now))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function readTranscript(file: string, id: string, now: number): AgentTranscript {
  const { size, mtimeMs } = statSync(file)
  // Only the ends of a long transcript are read: the prompt is on the first line, the rest is the tail.
  const whole = size <= TAIL_BYTES
  const head = slice(file, 0, whole ? size : HEAD_BYTES)
  const tail = whole ? head : slice(file, size - TAIL_BYTES, TAIL_BYTES)
  // The first tail line is the prompt when the file is whole, a torn line otherwise: not a row either way.
  const rows = rowsOf(tail.split('\n').filter(Boolean).slice(1))
  return {
    id, updatedAt: mtimeMs, idleMS: Math.max(0, now - mtimeMs),
    prompt: promptOf(head.split('\n')[0]),
    rows: rows.slice(-ROW_LIMIT), truncated: !whole || rows.length > ROW_LIMIT,
  }
}

function slice(file: string, offset: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf8', 0, read)
  } finally { closeSync(fd) }
}

/** The first line of a subagent transcript is the prompt it was given, as a plain string. */
function promptOf(line: string): string {
  try {
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
    return typeof content === 'string' ? content : ''
  } catch { return '' }
}

function rowsOf(lines: string[]): AgentRow[] {
  const rows: AgentRow[] = []
  for (const line of lines) {
    for (const event of parseClaudeLine(line)) {
      if (event.type === 'assistant') rows.push({ role: 'assistant', text: event.text })
      else if (event.type === 'toolStart') rows.push({ role: 'tool', text: `${event.name} ${event.detail}`.trim() })
      else if (event.type === 'info') rows.push({ role: 'info', text: event.text })
    }
  }
  return rows
}
