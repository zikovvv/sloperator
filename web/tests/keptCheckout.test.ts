import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'
import { checkoutOf } from '../server/worktrees.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => response.json()
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await json(await h.get('/api/state'))).projects[0].id
})
afterAll(async () => { await h.stop() })

describe('a pull request checkout that was removed from the app but kept on disk', () => {
  it('is taken back when the pull request is opened again, and brought up to the head', async () => {
    const first = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 7, branch: 'feature/widgets' }))).worktree
    expect(first.branch).toBe('orch/pr-7')
    expect(realpathSync((await checkoutOf(h.repo, 'orch/pr-7'))!)).toBe(realpathSync(first.path))
    expect(await checkoutOf(h.repo, 'nowhere')).toBeNull()
    expect((await h.del(`/api/worktree/${first.id}?keepOnDisk=1`)).status).toBe(200)
    expect(existsSync(first.path)).toBe(true)
    // Meanwhile the pull request moved on.
    const scratch = join(h.repo, '..', `orch-head-${Date.now()}`)
    git(h.repo, 'fetch', '-q', 'origin', 'refs/pull/7/head'); git(h.repo, 'worktree', 'add', '-q', '--detach', scratch, 'FETCH_HEAD')
    writeFileSync(join(scratch, 'more.py'), 'print(8)\n'); git(scratch, 'add', '-A'); git(scratch, 'commit', '-qm', 'more')
    git(scratch, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head'); git(h.repo, 'worktree', 'remove', '--force', scratch)

    const again = await json(await h.post('/api/pr/worktree', { projectID, prNumber: 7, branch: 'feature/widgets' }))
    expect(again.ok).toBe(true)
    expect(again.worktree.path).toBe(first.path); expect(again.worktree.branch).toBe('orch/pr-7')
    expect(existsSync(join(first.path, 'more.py'))).toBe(true)
    // A review of the same pull request lands in that checkout too.
    const review = await json(await h.post('/api/pr/review', { projectID, prNumber: 7 }))
    expect(review.worktree.id).toBe(again.worktree.id)
  })

  it('keeps whatever the checkout has when it cannot simply be moved forward', async () => {
    const record = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.branch === 'orch/pr-7')
    await h.del(`/api/worktree/${record.id}?keepOnDisk=1`)
    writeFileSync(join(record.path, 'local.py'), 'print(9)\n'); git(record.path, 'add', '-A'); git(record.path, 'commit', '-qm', 'local work')
    const local = git(record.path, 'rev-parse', 'HEAD')
    const back = await json(await h.post('/api/pr/worktree', { projectID, prNumber: 7, branch: 'feature/widgets' }))
    expect(back.worktree.path).toBe(record.path)
    expect(git(record.path, 'rev-parse', 'HEAD')).toBe(local)
  })

  it('takes back a checkout of the pull request\'s own branch too', async () => {
    git(h.repo, 'push', '-q', 'origin', 'feature/one:refs/pull/10/head')
    const first = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 10, branch: 'feature/one' }))).worktree
    expect(first.branch).toBe('feature/one')
    await h.del(`/api/worktree/${first.id}?keepOnDisk=1`)
    const again = await json(await h.post('/api/pr/worktree', { projectID, prNumber: 10, branch: 'feature/one' }))
    expect(again.worktree.path).toBe(first.path); expect(again.worktree.branch).toBe('feature/one'); expect(again.copied).toBe(false)
    await h.del(`/api/worktree/${again.worktree.id}`)
  })

  it('leaves a checkout outside the app\'s root alone, and says why the branch cannot be checked out again', async () => {
    const { createPRWorktree } = await import('../server/worktrees.ts')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    git(h.repo, 'fetch', '-q', 'origin', 'refs/pull/8/head:orch/pr-8')
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'orch-elsewhere-')), 'pr-8')
    git(h.repo, 'worktree', 'add', '-q', elsewhere, 'orch/pr-8')
    await expect(createPRWorktree({ projectPath: h.repo, projectName: 'probe', prNumber: 8 })).rejects.toThrow(/git worktree add/)
  })
})
