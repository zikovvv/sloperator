import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** Agent pids of a previous server instance. Written on every change so a crash cannot lose it. */
export type RunningRecord = Record<string, number>

export function readRunningRecord(path: string): RunningRecord {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return Object.fromEntries(
      Object.entries(raw).filter(([, pid]) => Number.isInteger(pid) && (pid as number) > 0)) as RunningRecord
  } catch {
    return {}
  }
}

export function writeRunningRecord(path: string, record: RunningRecord) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(record))
  renameSync(tmp, path)
}

/**
 * Decides what to do with agents left behind by a previous instance: an agent whose pid is still
 * alive has nobody reading its output any more, so it is killed and its session told why.
 */
export function reapOrphans(
  record: RunningRecord,
  isAlive: (pid: number) => boolean,
  kill: (pid: number) => void,
): string[] {
  const interrupted: string[] = []
  for (const [sessionID, pid] of Object.entries(record)) {
    if (isAlive(pid)) kill(pid)
    interrupted.push(sessionID)
  }
  return interrupted
}

export function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
