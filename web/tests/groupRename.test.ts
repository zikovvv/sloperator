import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await json(await h.get('/api/state'))).body.projects[0].id
})
afterAll(async () => { await h.stop() })

describe('renaming a group directory', () => {
  it('moves every worktree in it on disk, keeps folder order, and refuses the impossible', async () => {
    await h.post(`/api/project/${projectID}/group`, { name: 'review' })
    await h.post(`/api/project/${projectID}/group`, { name: 'later' })
    const one = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'one', branch: 'orch/one', group: 'review' }))).body.worktree
    const two = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'two', branch: 'orch/two', group: 'review' }))).body.worktree
    expect(one.path).toContain('/review/')

    expect((await h.patch(`/api/project/${projectID}/group/main`, { name: 'primary' })).status).toBe(400)
    expect((await h.patch(`/api/project/${projectID}/group/review`, { name: '  ' })).status).toBe(400)
    expect((await h.patch(`/api/project/${projectID}/group/review`, { name: 'a/b' })).status).toBe(400)
    expect((await h.patch(`/api/project/${projectID}/group/review`, { name: 'later' })).status).toBe(400)
    expect((await h.patch(`/api/project/${projectID}/group/review`, { name: 'main' })).status).toBe(400)
    expect((await h.patch(`/api/project/${projectID}/group/nope`, { name: 'x' })).status).toBe(404)
    expect((await h.patch(`/api/project/nope/group/review`, { name: 'x' })).status).toBe(404)

    const renamed = (await json(await h.patch(`/api/project/${projectID}/group/review`, { name: 'reviews' }))).body
    expect(renamed.groups).toEqual(['main', 'reviews', 'later'])
    const state = (await json(await h.get('/api/state'))).body
    for (const id of [one.id, two.id]) {
      const moved = state.worktrees.find((entry: any) => entry.id === id)
      expect(moved.group).toBe('reviews')
      expect(moved.path).toContain('/reviews/')
      expect(existsSync(moved.path)).toBe(true)
    }
    expect(existsSync(one.path)).toBe(false)
  })

  it('reports git’s reason when a worktree cannot be moved, keeping what did move', async () => {
    await h.post(`/api/project/${projectID}/group`, { name: 'stuck' })
    const wt = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'stuck-one', branch: 'orch/stuck', group: 'stuck' }))).body.worktree
    // A file where the new group directory must go: nothing can be moved under it.
    const { writeFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    writeFileSync(join(dirname(dirname(wt.path)), 'blocked'), 'in the way')
    const failed = await json(await h.patch(`/api/project/${projectID}/group/stuck`, { name: 'blocked' }))
    expect(failed.status).toBe(500)
    expect(failed.body.error).toMatch(/blocked/)
    const state = (await json(await h.get('/api/state'))).body
    expect(state.worktrees.find((entry: any) => entry.id === wt.id).group).toBe('stuck')
  })
})
