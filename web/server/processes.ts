import { execFileSync } from 'node:child_process'
import type { ActiveProcess } from '../shared/types.ts'

export interface ProcessRow { ppid: number; command: string; elapsed: number; cpu: number }

/** ps prints elapsed time as [[dd-]hh:]mm:ss. */
export function parseElapsed(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = clock.split(':').map(Number)
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts]
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds
}

export function parseRow(row: string): [number, ProcessRow] | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(row)
  if (!match) return null
  return [Number(match[1]), { ppid: Number(match[2]), elapsed: parseElapsed(match[3]), cpu: Number(match[4]) || 0, command: match[5] }]
}

export function processTable(): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>()
  try {
    const listing = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,%cpu=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    for (const row of listing.split('\n')) {
      const parsed = parseRow(row)
      if (parsed) table.set(parsed[0], parsed[1])
    }
  } catch { /* ps unavailable */ }
  return table
}

/** Everything under a process, depth-first, with how deep each one sits. */
export function descendantsOf(pid: number, table: Map<number, ProcessRow>): ActiveProcess[] {
  const children = new Map<number, Array<[number, ProcessRow]>>()
  for (const [child, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), [child, row]])
  const out: ActiveProcess[] = []
  const walk = (parent: number, depth: number) => {
    for (const [child, row] of children.get(parent) ?? []) {
      out.push({ pid: child, ppid: parent, command: row.command, elapsed: row.elapsed, cpu: row.cpu, depth })
      walk(child, depth + 1)
    }
  }
  walk(pid, 1)
  return out
}
