import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

describe('worktree names at startup', () => {
  it('names each worktree not named by hand after its first session, and saves it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-naming-state-'))
    mkdirSync(join(dir, 'state'))
    process.env.ORCHESTRATOR_STATE_DIR = join(dir, 'state')
    process.env.ORCHESTRATOR_WORKTREE_ROOT = join(dir, 'worktrees')
    const base = { engine: 'claude', accessMode: 'edits', steeringMode: 'queue', totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    writeFileSync(join(dir, 'state', 'state.json'), JSON.stringify({
      projects: [{ id: 'p', name: 'acme', path: dir, isGit: false, worktreeGroups: ['main'] }],
      worktrees: [
        { id: 'main', projectID: 'p', name: 'acme', path: dir, isMain: true },
        { id: 'w1', projectID: 'p', name: 'swift-quartz', path: join(dir, 'w1'), isMain: false },
        { id: 'w2', projectID: 'p', name: 'Chosen', path: join(dir, 'w2'), isMain: false, nameIsManual: true },
        { id: 'w3', projectID: 'p', name: 'pr-7', path: join(dir, 'w3'), isMain: false },
      ],
      sessions: [
        { ...base, id: 's0', worktreeID: 'main', title: 'Main work' },
        { ...base, id: 's1', worktreeID: 'w1', title: 'Fix the parser' },
        { ...base, id: 's1b', worktreeID: 'w1', title: 'Later session' },
        { ...base, id: 's2', worktreeID: 'w2', title: 'Something else' },
        { ...base, id: 's3', worktreeID: 'w3', title: 'New session' },
        { ...base, id: 'orphan', worktreeID: 'gone', title: 'Lost' },
      ],
    }))
    vi.resetModules()
    const { startServer } = await import('../server/app.ts')
    const started = await startServer({ port: 0, background: false, signals: false })
    try {
      const origin = `http://127.0.0.1:${started.port}`
      const state = await (await fetch(`${origin}/api/state`, { headers: { Origin: origin } })).json()
      expect(Object.fromEntries(state.worktrees.map((entry: any) => [entry.id, entry.name])))
        .toEqual({ main: 'acme', w1: 'Fix the parser', w2: 'Chosen', w3: 'pr-7' })
      const saved = JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf8'))
      expect(saved.worktrees.find((entry: any) => entry.id === 'w1').name).toBe('Fix the parser')
    } finally {
      await started.stop()
    }
  })
})
