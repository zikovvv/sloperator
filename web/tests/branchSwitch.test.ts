import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeRepo } from './helpers/server.ts'
import { switchBranch, createWorktree } from '../server/worktrees.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

describe('switchBranch, directly', () => {
  it('refuses to name a detached worktree after a branch that exists, and re-forks one with no recorded base', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'orch-switch-'))
    const created = await createWorktree({ projectPath: repo, projectName: 'acme', name: '', group: 'main', rootOverride: root })
    git(created.path, 'checkout', '-q', '--detach', 'HEAD')
    await expect(switchBranch(repo, created.path, { rename: 'main' })).rejects.toThrow(/git switch -c failed/)

    // Nothing recorded as a base means nothing of its own can be counted, so the re-fork proceeds.
    git(created.path, 'checkout', '-q', created.branch)
    const result = await switchBranch(repo, created.path, { base: 'feature/one' })
    expect(result.base).toBe('feature/one')
    expect(git(created.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'feature/one'))
  })
})

describe('the state directory outside a test run', () => {
  it('falls back to Application Support when nothing points it elsewhere', async () => {
    vi.resetModules()
    vi.stubEnv('VITEST', '')
    const saved = process.env.ORCHESTRATOR_STATE_DIR
    delete process.env.ORCHESTRATOR_STATE_DIR
    try {
      // Importing only computes the paths; nothing is read or written until a call is made.
      const state = await import('../server/state.ts')
      expect(state.RUNNING_RECORD).toContain('Library/Application Support/ClaudeOrchestrator')
    } finally {
      process.env.ORCHESTRATOR_STATE_DIR = saved
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
