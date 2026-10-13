import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorktree, gitFailure, moveCurrentWork, worktreeRoot } from '../server/worktrees.ts'

const repo = () => {
  const path = mkdtempSync(join(tmpdir(), 'orch-sweep-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'E2E')
  writeFileSync(join(path, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'one')
  return { path, git }
}

describe('gitFailure', () => {
  it('quotes stderr, then stdout, then admits it has nothing', () => {
    expect(gitFailure('git x', { ok: false, stdout: 'out', stderr: ' err \n' })).toBe('git x failed: err')
    expect(gitFailure('git x', { ok: false, stdout: 'out\n', stderr: '' })).toBe('git x failed: out')
    expect(gitFailure('git x', { ok: false, stdout: '', stderr: '' })).toBe('git x failed: unknown error')
  })
})

describe('worktreeRoot', () => {
  it('prefers the setting (with ~ expanded), then the test seam, then ~/.orchestrator/worktrees', () => {
    expect(worktreeRoot('~/trees')).toBe(join(homedir(), 'trees'))
    expect(worktreeRoot(null)).toBe(process.env.ORCHESTRATOR_WORKTREE_ROOT)
    const saved = process.env.ORCHESTRATOR_WORKTREE_ROOT
    delete process.env.ORCHESTRATOR_WORKTREE_ROOT
    try { expect(worktreeRoot()).toBe(join(homedir(), '.orchestrator/worktrees')) } finally { process.env.ORCHESTRATOR_WORKTREE_ROOT = saved }
  })
})

describe('createWorktree for an existing branch', () => {
  it('steps around a folder that is already there, and reports a branch git will not check out twice', async () => {
    const { path, git } = repo()
    git('branch', 'feature/login')
    const rootOverride = mkdtempSync(join(tmpdir(), 'orch-sweep-root-'))
    const taken = join(rootOverride, 'proj', 'feature-login')
    mkdirSync(taken, { recursive: true })
    const first = await createWorktree({ projectPath: path, projectName: 'proj', name: '', branch: 'feature/login', base: null, checkoutExisting: true, rootOverride })
    expect(basename(first.path)).toBe('feature-login-2')
    expect(existsSync(first.path)).toBe(true)
    await expect(createWorktree({ projectPath: path, projectName: 'proj', name: '', branch: 'feature/login', base: null, checkoutExisting: true, rootOverride }))
      .rejects.toThrow(/git worktree add failed: [\s\S]*already checked out/)
    // A new branch from a fork point git does not know fails the same way.
    await expect(createWorktree({ projectPath: path, projectName: 'proj', name: 'fresh', branch: null, base: 'no-such-branch', checkoutExisting: false, rootOverride }))
      .rejects.toThrow(/git worktree add failed: [\s\S]*(invalid reference|not a valid)/)
  })
})

describe('moveCurrentWork', () => {
  const worktreeOn = ({ path, git }: ReturnType<typeof repo>, branch: string) => {
    const target = join(mkdtempSync(join(tmpdir(), 'orch-sweep-wt-')), 'wt')
    git('worktree', 'add', '-q', target, branch)
    return target
  }

  it('moves the work and drops the stash it came from', async () => {
    const project = repo()
    project.git('branch', 'other')
    const target = worktreeOn(project, 'other')
    writeFileSync(join(project.path, 'a.txt'), 'changed\n')
    expect(await moveCurrentWork(project.path, target)).toBeNull()
    expect(project.git('stash', 'list')).toBe('')
    expect(project.git('status', '--porcelain')).toBe('')
    expect(execFileSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8' })).toMatch(/a\.txt/)
    expect(await moveCurrentWork(project.path, target)).toBeNull()   // nothing to move: nothing said
  })

  it('leaves the stash in place when the work applies with conflicts, or cannot apply at all', async () => {
    const conflicting = repo()
    conflicting.git('checkout', '-q', '-b', 'other'); writeFileSync(join(conflicting.path, 'a.txt'), 'theirs\n')
    conflicting.git('commit', '-qam', 'theirs'); conflicting.git('checkout', '-q', 'main')
    const target = worktreeOn(conflicting, 'other')
    writeFileSync(join(conflicting.path, 'a.txt'), 'mine\n')
    expect(await moveCurrentWork(conflicting.path, target)).toMatch(/applied with conflicts/)
    expect(conflicting.git('stash', 'list')).toMatch(/orchestrator-move/)

    const blocked = repo()
    blocked.git('checkout', '-q', '-b', 'other'); writeFileSync(join(blocked.path, 'n.txt'), 'committed there\n')
    blocked.git('add', '-A'); blocked.git('commit', '-qm', 'n'); blocked.git('checkout', '-q', 'main')
    const wt = worktreeOn(blocked, 'other')
    writeFileSync(join(blocked.path, 'n.txt'), 'untracked here\n')
    expect(await moveCurrentWork(blocked.path, wt)).toMatch(/Could not apply your work in the new worktree; it is preserved/)
    expect(blocked.git('stash', 'list')).toMatch(/orchestrator-move/)
  })

  it('says so when git cannot stash at all', async () => {
    const project = repo()
    project.git('branch', 'other')
    const target = worktreeOn(project, 'other')
    writeFileSync(join(project.path, 'a.txt'), 'changed\n')
    chmodSync(join(project.path, '.git'), 0o555)
    try {
      expect(await moveCurrentWork(project.path, target)).toMatch(/^Nothing was moved: git could not stash your work/)
    } finally { chmodSync(join(project.path, '.git'), 0o755) }
  })
})
