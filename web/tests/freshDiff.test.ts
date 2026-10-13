import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchBranch } from '../server/git.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const json = async (response: Response) => response.json()
const git = (...args: string[]) => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim()
const files = async (fresh: boolean) =>
  (await json(await h.get(`/api/diff?path=${encodeURIComponent(join(h.repo, 'tests'))}&scope=branch&base=feature/one${fresh ? '&fresh=1' : ''}`))).files.map((file: any) => file.path)   // a plain path: the base named here

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
})
afterAll(async () => { await h.stop() })

describe('the refresh button and what origin has since', () => {
  it('fetches the branch compared against, so a base that moved on GitHub stops counting as this branch', async () => {
    // The base gains a commit that is pushed; this branch merges it; then the remote-tracking ref is
    // wound back, which is what a machine that has not fetched sees.
    git('checkout', '-q', 'feature/one'); writeFileSync(join(h.repo, 'base2.py'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base moved')
    git('push', '-q', 'origin', 'feature/one')
    const moved = git('rev-parse', 'feature/one')
    git('checkout', '-q', '-b', 'stack'); writeFileSync(join(h.repo, 'top.py'), 'top\n'); git('add', '-A'); git('commit', '-qm', 'top')
    git('update-ref', 'refs/remotes/origin/feature/one', git('rev-parse', 'main'))
    expect(await files(false)).toEqual(['base2.py', 'top.py'])   // stale: the base's own commit shows up
    expect(await files(true)).toEqual(['top.py'])               // fetched: origin/feature/one is where it is
    expect(git('rev-parse', 'origin/feature/one')).toBe(moved)
  })

  it('keeps what it has when origin has no such branch, and fetches the current branch for the remote view', async () => {
    await fetchBranch(h.repo, 'no-such-branch')
    const remote = await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=remote&fresh=1`)
    expect(remote.status).toBe(200)
  })
})
