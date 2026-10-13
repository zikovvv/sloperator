import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRunningRecord, reapOrphans, writeRunningRecord } from '../server/orphans.ts'

describe('orphan reaping', () => {
  it('kills every recorded pid that is still alive and names every session as interrupted', () => {
    const killed: number[] = []
    const interrupted = reapOrphans({ a: 100, b: 200, c: 300 }, (pid) => pid !== 200, (pid) => killed.push(pid))
    expect(killed).toEqual([100, 300])
    expect(interrupted.sort()).toEqual(['a', 'b', 'c'])
  })

  it('round-trips through disk and ignores junk entries', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orph-')), 'running.json')
    writeRunningRecord(path, { s1: 42 })
    expect(readRunningRecord(path)).toEqual({ s1: 42 })
    writeRunningRecord(path, { s1: 42, bad: -1 as number, worse: 'x' as unknown as number })
    expect(readRunningRecord(path)).toEqual({ s1: 42 })
    expect(readRunningRecord(join(tmpdir(), 'does-not-exist.json'))).toEqual({})
  })
})
