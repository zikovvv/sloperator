import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRepo } from './helpers/server.ts'
import { createWorktree, moveCurrentWork, deleteWorktree, moveWorktree, createPRWorktree, branchesInUse, describeProject } from '../server/worktrees.ts'

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

describe('worktrees: remote branches, collisions, fallbacks', () => {
  let repo: string; let root: string
  beforeEach(() => { repo = makeRepo(); root = mkdtempSync(join(tmpdir(), 'wt-root-')); process.env.ORCHESTRATOR_WORKTREE_ROOT = root })

  it('checks out a remote-tracking branch under a local name and keeps the path after the remote name', async () => {
    git(repo, 'branch', '-D', 'feature/one')   // only origin/feature/one remains
    const created = await createWorktree({ projectPath: repo, projectName: 'p', name: '', branch: 'origin/feature/one', checkoutExisting: true })
    expect(created.branch).toBe('feature/one')
    expect(existsSync(created.path)).toBe(true)
    expect(git(created.path, 'branch', '--show-current').trim()).toBe('feature/one')
    // The branch is local now and checked out here: asking again must fail with git's reason.
    await expect(createWorktree({ projectPath: repo, projectName: 'p', name: '', branch: 'feature/one', checkoutExisting: true }))
      .rejects.toThrow(/worktree add failed/)
  })

  it('suffixes a new branch whose name or folder already exists, and forks from a base', async () => {
    const first = await createWorktree({ projectPath: repo, projectName: 'p', name: 'thing', branch: 'orch/thing' })
    const second = await createWorktree({ projectPath: repo, projectName: 'p', name: 'thing', branch: 'orch/thing', base: 'main' })
    expect(first.branch).toBe('orch/thing'); expect(second.branch).toBe('orch/thing-2')
    expect(second.path).toMatch(/thing-2$/)
  })

  it('moveCurrentWork: nothing to move, and the stash-identification fallback', async () => {
    const target = await createWorktree({ projectPath: repo, projectName: 'p', name: 'target' })
    expect(await moveCurrentWork(repo, target.path)).toBeNull()
    writeFileSync(join(repo, 'README.md'), '# moved\n')
    expect(await moveCurrentWork(repo, target.path)).toBeNull()
    expect(existsSync(join(target.path, 'README.md'))).toBe(true)
  })

  it('deleteWorktree falls back to rm when git refuses, and reports a folder that will not go', async () => {
    const created = await createWorktree({ projectPath: repo, projectName: 'p', name: 'gone' })
    git(repo, 'worktree', 'remove', '--force', created.path)   // git no longer knows it…
    mkdirSync(created.path, { recursive: true }); writeFileSync(join(created.path, 'junk'), 'x')   // …but the folder is back
    await deleteWorktree(repo, created.path)
    expect(existsSync(created.path)).toBe(false)
  })

  it('moveWorktree suffixes when the destination exists; PR worktree suffixes too; branchesInUse strips refs/heads', async () => {
    const created = await createWorktree({ projectPath: repo, projectName: 'p', name: 'mover' })
    mkdirSync(join(root, 'p', 'box', 'mover'), { recursive: true })
    const moved = await moveWorktree(repo, 'p', created.path, 'box')
    expect(moved).toMatch(/mover-2$/)
    const pr = await createPRWorktree({ projectPath: repo, projectName: 'p', prNumber: 7, group: 'PR Reviews' })
    expect(pr.branch).toBe('orch/pr-7')
    // Asked again, the checkout that already holds the branch is the answer, not a failure.
    expect(await createPRWorktree({ projectPath: repo, projectName: 'p', prNumber: 7, group: 'PR Reviews' })).toEqual(pr)
    // A directory in the way that is not a checkout gets a suffix.
    mkdirSync(join(root, 'p', 'PR Reviews', 'pr-8'), { recursive: true })
    expect((await createPRWorktree({ projectPath: repo, projectName: 'p', prNumber: 8, group: 'PR Reviews' })).path).toMatch(/pr-8-2$/)
    await expect(createPRWorktree({ projectPath: repo, projectName: 'p', prNumber: 999 })).rejects.toThrow(/Could not fetch/)
    const inUse = await branchesInUse(repo)
    expect(inUse).toContain('main'); expect(inUse).toContain('orch/pr-7'); expect(inUse.every((name) => !name.startsWith('refs/'))).toBe(true)
    expect(await describeProject(repo)).toMatchObject({ branch: 'main', base: expect.any(String) })
    expect(await moveWorktree(repo, 'p', '/nowhere/at/all', 'box').catch((error) => error.message)).toMatch(/move failed/)
  })
})

describe('state normalisation of sparse and Swift-era records', () => {
  it('fills ids and names, maps unknown engines to claude, converts old timestamps, survives junk transcripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-')); process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      projects: [{ path: '/x' }], worktrees: [{ projectID: 'p', path: '/x' }], sessions: [{ worktreeID: 'w', engine: 'gemini' }],
    }))
    mkdirSync(join(dir, 'transcripts'))
    writeFileSync(join(dir, 'transcripts', 'a.json'), JSON.stringify([{ role: 'user' }, { role: 'assistant', timestamp: 1e12, text: 't' }]))
    writeFileSync(join(dir, 'transcripts', 'bad.json'), '{not json')
    writeFileSync(join(dir, 'transcripts', 'obj.json'), '{"role":"user"}')
    const { loadState, loadTranscript, saveTranscript } = await import('../server/state.ts')
    const state = loadState()
    expect(state.projects[0]).toMatchObject({ name: 'Project', isGit: true }); expect(state.projects[0].id).toBeTruthy()
    expect(state.worktrees[0]).toMatchObject({ name: 'worktree', branch: null })
    expect(state.sessions[0]).toMatchObject({ title: 'Session', engine: 'claude', accessMode: 'edits' })
    const items = loadTranscript('a')
    expect(items[0].id).toBeTruthy(); expect(items[0].text).toBe(''); expect(typeof items[0].timestamp).toBe('number')
    expect(items[1].timestamp).toBe(1e12)
    expect(loadTranscript('bad')).toEqual([])
    expect(loadTranscript('obj')).toEqual([])
    saveTranscript('c', [{ id: '1', role: 'user', text: 'x', timestamp: 1 }])
    expect(loadTranscript('c')).toHaveLength(1)
  })
})
