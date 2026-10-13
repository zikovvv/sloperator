import { describe, expect, it, vi } from 'vitest'
import { descendantsOf, parseElapsed, parseRow, processTable } from '../server/processes.ts'

describe('processes', () => {
  it('reads ps elapsed times in every shape it prints', () => {
    expect(parseElapsed('01:05')).toBe(65)
    expect(parseElapsed('02:01:05')).toBe(7265)
    expect(parseElapsed('3-02:01:05')).toBe(3 * 86400 + 7265)
  })

  it('parses a ps row, with a zero share of the cpu when ps prints none, and skips what is not a row', () => {
    expect(parseRow('  42   1 01:05 12.5 /bin/bash -c "npm test"')).toEqual([42, { ppid: 1, elapsed: 65, cpu: 12.5, command: '/bin/bash -c "npm test"' }])
    expect(parseRow('  43  42 00:02 0.0 sleep 30')).toEqual([43, { ppid: 42, elapsed: 2, cpu: 0, command: 'sleep 30' }])
    expect(parseRow('')).toBeNull()
  })

  it('walks the tree under a process, depth first, carrying elapsed and cpu', () => {
    const table = new Map([
      [10, { ppid: 1, command: 'agent', elapsed: 100, cpu: 1 }],
      [11, { ppid: 10, command: 'bash -c x', elapsed: 50, cpu: 2 }],
      [12, { ppid: 11, command: 'python x', elapsed: 40, cpu: 90 }],
      [13, { ppid: 10, command: 'git status', elapsed: 1, cpu: 0 }],
      [99, { ppid: 1, command: 'unrelated', elapsed: 5, cpu: 0 }],
    ])
    expect(descendantsOf(10, table)).toEqual([
      { pid: 11, ppid: 10, command: 'bash -c x', elapsed: 50, cpu: 2, depth: 1 },
      { pid: 12, ppid: 11, command: 'python x', elapsed: 40, cpu: 90, depth: 2 },
      { pid: 13, ppid: 10, command: 'git status', elapsed: 1, cpu: 0, depth: 1 },
    ])
  })

  it('lists the live processes, this one among them', () => {
    const table = processTable()
    expect(table.get(process.pid)).toMatchObject({ ppid: process.ppid, cpu: expect.any(Number) })
    expect(table.get(process.pid)!.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('is empty when ps cannot be run', async () => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({ execFileSync: () => { throw new Error('no ps') } }))
    const fresh = await import('../server/processes.ts')
    expect(fresh.processTable().size).toBe(0)
    vi.doUnmock('node:child_process')
  })
})
