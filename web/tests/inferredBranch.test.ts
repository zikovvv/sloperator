import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git } from '../server/git.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID: string

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = await (await h.get('/api/state')).json()
  projectID = state.projects.find((entry: any) => entry.path === h.repo).id
})
afterAll(async () => { await h.stop() })

const body = async (response: Response) => response.json()
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
const worktree = async (id: string) =>
  (await body(await h.get('/api/state'))).worktrees.find((entry: any) => entry.id === id)

describe('the branch of a worktree is git’s answer, not ours', () => {
  it('follows a rename made behind the app and renames a worktree that never got its own name', async () => {
    const created = await body(await h.post(`/api/project/${projectID}/worktree`, {
      name: 'amber-otter', branch: 'orch/amber-otter', group: 'main',
    }))
    expect(created.worktree.branch).toBe('orch/amber-otter')

    await git(created.worktree.path, ['branch', '-m', 'orch/real-work'])
    await h.get(`/api/worktree/${created.worktree.id}/info`)
    await settle()

    const after = await worktree(created.worktree.id)
    expect(after.branch).toBe('orch/real-work')
    expect(after.name).toBe('real-work')
  })

  it('leaves a hand-named worktree named when the agent checks out something else', async () => {
    const created = await body(await h.post(`/api/project/${projectID}/worktree`, {
      name: 'Release prep', branch: 'orch/release', group: 'main',
    }))
    await git(created.worktree.path, ['checkout', '-q', '-b', 'orch/release-cut'])
    await h.get('/api/state')
    await settle()

    const after = await worktree(created.worktree.id)
    expect(after.branch).toBe('orch/release-cut')
    expect(after.name).toBe('Release prep')
  })

  it('never writes a branch into state.json', async () => {
    const stored = JSON.parse(readFileSync(join(h.stateDir, 'state.json'), 'utf8'))
    expect(stored.worktrees.length).toBeGreaterThan(0)
    expect(stored.worktrees.some((entry: Record<string, unknown>) => 'branch' in entry)).toBe(false)
  })

  it('reports no branch once the folder is gone, and forgets it on delete', async () => {
    const created = await body(await h.post(`/api/project/${projectID}/worktree`, {
      name: 'doomed', branch: 'orch/doomed', group: 'main',
    }))
    expect((await h.del(`/api/worktree/${created.worktree.id}`)).status).toBe(200)
    expect(await worktree(created.worktree.id)).toBeUndefined()
  })

  it('offers the repository’s default branch as the fork point', async () => {
    const result = await body(await h.get(`/api/branches?path=${encodeURIComponent(h.repo)}`))
    expect(result.defaultBranch).toBe('main')
    expect(result.branches).toContain('main')
  })
})
