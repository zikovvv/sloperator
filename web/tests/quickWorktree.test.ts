import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let mainID = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const worktree = async (id: string) => (await json(await h.get('/api/state'))).body.worktrees.find((entry: any) => entry.id === id)

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = (await json(await h.get('/api/state'))).body
  projectID = state.projects[0].id
  mainID = state.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { await h.stop() })

describe('the + button: a worktree with no questions', () => {
  it('forks a freshly generated branch from the latest origin main and opens a session in it', async () => {
    // origin/main is ahead of the local main: the new worktree must start from origin's commit.
    const scratch = join(h.stateDir, 'scratch')
    execFileSync('git', ['clone', '-q', git(h.repo, 'remote', 'get-url', 'origin'), scratch])
    execFileSync('git', ['-C', scratch, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', scratch, 'config', 'user.name', 'Test'])
    writeFileSync(join(scratch, 'newer.txt'), 'from origin\n')
    git(scratch, 'add', '-A'); git(scratch, 'commit', '-qm', 'newer on origin'); git(scratch, 'push', '-q', 'origin', 'main')

    const created = (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).body
    expect(created.worktree.branch).toMatch(/^orch\/[a-z]+-[a-z]+$/)
    expect(created.worktree.name).toBe(created.worktree.branch.replace('orch/', ''))
    expect(created.worktree.group).toBe('main')
    expect(created.worktree.baseBranch).toBe('origin/main')
    expect(created.session.worktreeID).toBe(created.worktree.id)
    expect(git(created.worktree.path, 'log', '-1', '--format=%s')).toBe('newer on origin')
  })
})

describe('changing what a worktree is on', () => {
  let id = ''
  let path = ''
  beforeAll(async () => {
    const created = (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).body
    id = created.worktree.id; path = created.worktree.path
  })

  it('renames the branch, and the auto-named worktree follows', async () => {
    const renamed = (await json(await h.post(`/api/worktree/${id}/branch`, { rename: 'orch/real-work' }))).body
    expect(renamed.worktree.branch).toBe('orch/real-work')
    expect(renamed.worktree.name).toBe('real-work')
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('orch/real-work')
    expect((await h.post(`/api/worktree/${id}/branch`, { rename: 'main' })).status).toBe(500)   // exists
  })

  it('re-forks an untouched worktree from another base, but never one with its own work', async () => {
    const ok = (await json(await h.post(`/api/worktree/${id}/branch`, { base: 'feature/one' }))).body
    expect(ok.worktree.baseBranch).toBe('feature/one')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(h.repo, 'rev-parse', 'feature/one'))
    writeFileSync(join(path, 'own.txt'), 'mine\n')
    const dirty = await json(await h.post(`/api/worktree/${id}/branch`, { base: 'main' }))
    expect(dirty.status).toBe(500); expect(dirty.body.error).toMatch(/work of its own/)
    git(path, 'add', '-A'); git(path, 'commit', '-qm', 'own commit')
    const ahead = await json(await h.post(`/api/worktree/${id}/branch`, { base: 'main' }))
    expect(ahead.status).toBe(500); expect(ahead.body.error).toMatch(/work of its own/)
  })

  it('checks out an existing local branch, a remote-only one, and refuses one held elsewhere', async () => {
    git(h.repo, 'branch', 'spare', 'main')
    const local = (await json(await h.post(`/api/worktree/${id}/branch`, { branch: 'spare' }))).body
    expect(local.worktree.branch).toBe('spare')
    git(h.repo, 'branch', 'remote-only', 'main'); git(h.repo, 'push', '-q', 'origin', 'remote-only'); git(h.repo, 'branch', '-D', 'remote-only')
    const remote = (await json(await h.post(`/api/worktree/${id}/branch`, { branch: 'origin/remote-only' }))).body
    expect(remote.worktree.branch).toBe('remote-only')
    const held = await json(await h.post(`/api/worktree/${id}/branch`, { branch: 'main' }))   // main is the project's own checkout
    expect(held.status).toBe(500); expect(held.body.error).toMatch(/git checkout failed/)
  })

  it('renames a detached HEAD, and reports a base that does not exist', async () => {
    const created = (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).body.worktree
    git(created.path, 'checkout', '-q', '--detach', 'HEAD')
    const named = (await json(await h.post(`/api/worktree/${created.id}/branch`, { rename: 'orch/was-detached' }))).body
    expect(named.worktree.branch).toBe('orch/was-detached')
    const nowhere = await json(await h.post(`/api/worktree/${created.id}/branch`, { base: 'refs/heads/no-such-base' }))
    expect(nowhere.status).toBe(500)
    expect(nowhere.body.error).toMatch(/git reset --hard failed/)
  })

  it('refuses the main checkout and unknown worktrees', async () => {
    expect((await h.post(`/api/worktree/${mainID}/branch`, { rename: 'x' })).status).toBe(400)
    expect((await h.post('/api/worktree/nope/branch', { rename: 'x' })).status).toBe(404)
    expect((await json(await h.post(`/api/worktree/${id}/branch`, {}))).status).toBe(200)   // nothing asked, nothing changed
  })
})
