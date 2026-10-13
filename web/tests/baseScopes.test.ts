import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let mainID = ''
const json = async (response: Response) => response.json()
const git = (...args: string[]) => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' })
const diffOf = async (path: string, scope: string, base?: string) =>
  json(await h.get(`/api/diff?path=${encodeURIComponent(path)}&scope=${scope}${base ? `&base=${encodeURIComponent(base)}` : ''}`))

beforeAll(async () => {
  h = await startHarness()
  // A stack: feature/one gains one.py, and "stack" is opened against feature/one with top.py. It is PR #9.
  git('checkout', '-q', 'feature/one'); writeFileSync(join(h.repo, 'one.py'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'one')
  git('checkout', '-q', '-b', 'stack'); writeFileSync(join(h.repo, 'top.py'), 'top\n'); git('add', '-A'); git('commit', '-qm', 'top')
  git('push', '-q', 'origin', 'feature/one', 'stack:refs/pull/9/head'); git('checkout', '-q', 'main')
  await h.post('/api/project', { path: h.repo })
  const state = await json(await h.get('/api/state'))
  projectID = state.projects[0].id
  mainID = state.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { await h.stop() })

describe('a branch measured against its base, or against main', () => {
  it('records the base a pull request was opened on, and shows only what the branch adds over it', async () => {
    // "broken" is what GitHub's list calls the head of #9, but there is no such branch to fetch, so
    // the checkout is a copy of the pull request's head on orch/pr-9.
    const created = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 9, branch: 'broken' }))).worktree
    expect(created.branch).toBe('orch/pr-9')
    expect(created.baseBranch).toBe('feature/one')
    const overBase = await diffOf(created.path, 'branch')
    expect(overBase.base).toBe('feature/one')
    expect(overBase.files.map((file: any) => file.path)).toEqual(['top.py'])
    const overMain = await diffOf(created.path, 'main')
    expect(overMain.base).toBe('main')
    expect(overMain.files.map((file: any) => file.path)).toEqual(['one.py', 'top.py'])
    // The sidebar's count uses the same base as the review.
    expect((await json(await h.get(`/api/worktree/${created.id}/info`))).changedFiles).toBe(1)
    // Once the pull request list has been fetched, what GitHub says now outranks what was recorded:
    // the list has #9 opened against main.
    expect((await h.get(`/api/prs?project=${projectID}`)).status).toBe(200)
    const retargeted = await diffOf(created.path, 'branch')
    expect(retargeted.base).toBe('main')
    expect(retargeted.files.map((file: any) => file.path)).toEqual(['one.py', 'top.py'])
    // The branch that counts is the one checked out now, not the one the record last saw: moved
    // off the pull request's branch, the checkout is back to what it forked from.
    execFileSync('git', ['-C', created.path, 'checkout', '-q', '-b', 'elsewhere'])
    const moved = await diffOf(created.path, 'branch')
    expect(moved.base).toBe('feature/one')
    expect(moved.files.map((file: any) => file.path)).toEqual(['top.py'])
    await h.del(`/api/worktree/${created.id}`)
  })

  it('falls back to what the worktree forked from, and to the default branch, when GitHub is not available', async () => {
    process.env.FAKE_GH_MODE = 'unauth'
    try {
      const created = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 9, branch: 'broken' }))).worktree
      expect(created.baseBranch).toBe('main')
      await h.del(`/api/worktree/${created.id}`)
      // The same when a review opens the checkout itself.
      const review = await json(await h.post('/api/pr/review', { projectID, prNumber: 8 }))
      expect(review.worktree.branch).toBe('orch/pr-8'); expect(review.worktree.baseBranch).toBe('main')
    } finally { delete process.env.FAKE_GH_MODE }
    // The main checkout is measured against the default branch, which is itself: the working tree.
    const own = await diffOf(h.repo, 'branch')
    expect(own.base).toBe('main'); expect(own.files).toEqual([])
    // A plain repository path with no worktree record is measured against whatever the caller names.
    expect((await diffOf(join(h.repo, 'tests'), 'branch', 'main')).base).toBe('main')
    expect((await diffOf(join(h.repo, 'tests'), 'branch')).base).toBeNull()
    expect((await diffOf(h.repo, 'main')).base).toBe('main')
    expect((await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=nope`)).status).toBe(400)
  })
})
