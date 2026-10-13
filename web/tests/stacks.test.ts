import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => response.json()
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string, text: string, message = `edit ${file}`) => {
  writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message)
}
const stateOf = async () => json(await h.get('/api/state'))
const stackByID = async (id: string) => (await stateOf()).stacks.find((stack: any) => stack.id === id)
const worktreeOf = async (id: string) => (await stateOf()).worktrees.find((worktree: any) => worktree.id === id)
let ghLog = ''
const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : [])

/** A stack with `count` layers; each layer's commit is made before the next layer is added on top. */
const newStack = async (count: number) => {
  const made = await json(await h.post(`/api/project/${projectID}/stack`))
  const layers = [made.worktree]
  commit(made.worktree.path, `layer1-${made.stack.id.slice(0, 6)}.txt`, 'one\n')
  for (let index = 1; index < count; index += 1) {
    const added = await json(await h.post(`/api/stack/${made.stack.id}/layer`))
    layers.push(added.worktree)
    commit(added.worktree.path, `layer${index + 1}-${made.stack.id.slice(0, 6)}.txt`, `layer ${index + 1}\n`)
  }
  return { stack: made.stack, layers, session: made.session }
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await stateOf()).projects[0].id
})
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-gh-'))
  process.env.FAKE_GH_STATE = dir; ghLog = join(dir, '..', `${dir.split('/').pop()}.log`); process.env.FAKE_GH_LOG = ghLog
  delete process.env.FAKE_GH_MODE
})
afterAll(async () => { await h.stop(); delete process.env.FAKE_GH_STATE; delete process.env.FAKE_GH_LOG; delete process.env.FAKE_GH_MODE })

describe('a stack of worktrees', () => {
  it('starts with a layer and its session; each new layer branches from the top one and is measured against it', async () => {
    const { stack, layers, session } = await newStack(3)
    expect(stack).toMatchObject({ projectID, name: expect.stringMatching(/^Stack \d+$/), base: 'main' })
    expect(session.worktreeID).toBe(layers[0].id)
    expect(layers[1].baseBranch).toBe(layers[0].branch)
    expect(layers[2].baseBranch).toBe(layers[1].branch)
    // Layer 3 holds layer 1's and 2's work: it was branched from 2, which was branched from 1.
    expect(existsSync(join(layers[2].path, `layer1-${stack.id.slice(0, 6)}.txt`))).toBe(true)
    expect(await stackByID(stack.id)).toMatchObject({ layers: layers.map((layer: any) => layer.id), prs: [null, null, null] })
    const second = await json(await h.post(`/api/project/${projectID}/stack`))
    expect(second.stack.name).not.toBe(stack.name)   // names are not reused within a project
  })

  it('brings each layer up to date with the one below, bottom to top, and pushes the ones that track a remote', async () => {
    const { stack, layers } = await newStack(3)
    commit(layers[0].path, 'late.txt', 'added to layer 1 later\n')
    git(layers[1].path, 'push', '-q', '-u', 'origin', layers[1].branch)
    const updated = await json(await h.post(`/api/stack/${stack.id}/update`))
    expect(updated.results.map((result: any) => result.status)).toEqual(['merged', 'merged'])
    expect(updated.results[0].message).toMatch(/, pushed$/)
    expect(existsSync(join(layers[2].path, 'late.txt'))).toBe(true)
    expect(git(h.repo, 'ls-tree', '--name-only', `origin/${layers[1].branch}`)).toContain('late.txt')
    const again = await json(await h.post(`/api/stack/${stack.id}/update`))
    expect(again.results.map((result: any) => result.status)).toEqual(['up-to-date', 'up-to-date'])
  })

  it('stops at a conflict and leaves that layer, and every one above it, as they were', async () => {
    const { stack, layers } = await newStack(3)
    commit(layers[0].path, 'shared.txt', 'from layer 1\n')
    commit(layers[1].path, 'shared.txt', 'from layer 2\n')
    const head3 = git(layers[2].path, 'rev-parse', 'HEAD')
    const updated = await json(await h.post(`/api/stack/${stack.id}/update`))
    expect(updated.results).toHaveLength(1)
    expect(updated.results[0]).toMatchObject({ worktreeID: layers[1].id, status: 'conflict', message: expect.stringMatching(/conflicts in shared\.txt; left as it was/) })
    expect(git(layers[1].path, 'status', '--porcelain')).toBe('')           // the merge was abandoned
    expect(existsSync(join(layers[1].path, '.git'))).toBe(true)
    expect(git(layers[2].path, 'rev-parse', 'HEAD')).toBe(head3)
  })

  it('reports a merge git refuses for another reason, and a push that failed', async () => {
    const { stack, layers } = await newStack(2)
    commit(layers[0].path, 'touched.txt', 'from layer 1\n')
    writeFileSync(join(layers[1].path, 'touched.txt'), 'uncommitted in layer 2\n')
    const refused = await json(await h.post(`/api/stack/${stack.id}/update`))
    expect(refused.results[0]).toMatchObject({ status: 'failed', message: expect.stringMatching(/untracked working tree files would be overwritten|would be overwritten/) })
    git(layers[1].path, 'clean', '-fq')
    git(layers[1].path, 'push', '-q', '-u', 'origin', layers[1].branch)
    git(h.repo, 'remote', 'set-url', '--push', 'origin', '/nonexistent/remote')
    try {
      const pushed = await json(await h.post(`/api/stack/${stack.id}/update`))
      expect(pushed.results[0]).toMatchObject({ status: 'merged', message: expect.stringMatching(/but the push failed/) })
    } finally { git(h.repo, 'config', '--unset', 'remote.origin.pushurl') }
  })

  it('will not work on a layer that is not on a branch', async () => {
    const { stack, layers } = await newStack(2)
    git(layers[1].path, 'checkout', '-q', '--detach')
    expect((await h.post(`/api/stack/${stack.id}/update`)).status).toBe(500)
    const added = await h.post(`/api/stack/${stack.id}/layer`)
    expect(added.status).toBe(400)
    expect((await added.json()).error).toBe('The top layer is not on a branch')
  })

  it('renames, lets a layer go, forgets a deleted one, and dissolves without touching the worktrees', async () => {
    const { stack, layers } = await newStack(3)
    expect((await h.patch(`/api/stack/${stack.id}`, { name: '  Payments  ' })).status).toBe(200)
    expect((await stackByID(stack.id)).name).toBe('Payments')
    expect((await h.patch(`/api/stack/${stack.id}`, { name: ' ' })).status).toBe(400)
    expect((await h.patch(`/api/stack/${stack.id}`, {})).status).toBe(400)
    expect((await h.del(`/api/stack/${stack.id}/layer/${layers[1].id}`)).status).toBe(200)
    expect((await stackByID(stack.id)).layers).toEqual([layers[0].id, layers[2].id])
    expect(await worktreeOf(layers[1].id)).toBeTruthy()
    expect((await h.del(`/api/stack/${stack.id}/layer/${layers[1].id}`)).status).toBe(404)
    expect((await h.del(`/api/worktree/${layers[2].id}`)).status).toBe(200)
    expect((await stackByID(stack.id)).layers).toEqual([layers[0].id])
    expect((await h.del(`/api/stack/${stack.id}`)).status).toBe(200)
    expect(await stackByID(stack.id)).toBeUndefined()
    expect(await worktreeOf(layers[0].id)).toBeTruthy()
  })

  it('answers 404 for a stack that does not exist, whatever is asked of it', async () => {
    for (const [method, path] of [['post', 'layer'], ['patch', ''], ['del', ''], ['post', 'update'], ['post', 'prs'], ['post', 'land']] as const) {
      const response = await (h as any)[method](`/api/stack/nope${path ? `/${path}` : ''}`, { name: 'x' })
      expect(response.status).toBe(404)
    }
    expect((await h.post('/api/project/nope/stack')).status).toBe(404)
  })

  it('reports a stack or a layer that could not be made, and a top layer whose repository is gone', async () => {
    const { stack } = await newStack(1)
    // A worktree root that is a file: no worktree can be made under it.
    const file = join(mkdtempSync(join(tmpdir(), 'orch-root-')), 'a-file'); writeFileSync(file, '')
    await h.put('/api/settings', { worktreeRoot: file })
    try {
      expect((await h.post(`/api/project/${projectID}/stack`)).status).toBe(500)
      expect((await h.post(`/api/stack/${stack.id}/layer`)).status).toBe(500)
    } finally { await h.put('/api/settings', { worktreeRoot: null }) }
    const plain = mkdtempSync(join(tmpdir(), 'orch-gone-'))
    await h.post('/api/project', { path: plain })   // made a repository with a first commit
    const project = (await stateOf()).projects.find((entry: any) => entry.path === plain)
    const orphan = (await json(await h.post(`/api/project/${project.id}/stack`))).stack
    rmSync(plain, { recursive: true, force: true })
    expect((await h.post(`/api/stack/${orphan.id}/layer`)).status).toBe(400)
  })
})

describe("a stack's pull requests", () => {
  it('pushes every layer and opens a draft PR for each on the layer below, once', async () => {
    const { stack, layers } = await newStack(3)
    const opened = await json(await h.post(`/api/stack/${stack.id}/prs`))
    expect(opened.results.map((result: any) => result.status)).toEqual(['created', 'created', 'created'])
    const creates = ghCalls().filter((call) => call.startsWith('pr create'))
    expect(creates.map((call) => /--base (\S+) --head (\S+)/.exec(call)!.slice(1)))
      .toEqual([['main', layers[0].branch], [layers[0].branch, layers[1].branch], [layers[1].branch, layers[2].branch]])
    expect(creates[1]).toMatch(/--draft/); expect(creates[1]).toMatch(/Layer 2 of 3 in a stack/)
    expect(git(h.repo, 'ls-remote', 'origin', layers[2].branch)).not.toBe('')
    const again = await json(await h.post(`/api/stack/${stack.id}/prs`))
    expect(again.results.map((result: any) => result.status)).toEqual(['exists', 'exists', 'exists'])
  })

  it('stops at the first layer it cannot push or open, since the ones above build on it', async () => {
    const { stack } = await newStack(2)
    process.env.FAKE_GH_MODE = 'create-fail'
    const failed = await json(await h.post(`/api/stack/${stack.id}/prs`))
    expect(failed.results).toHaveLength(1)
    expect(failed.results[0]).toMatchObject({ status: 'failed', message: expect.stringMatching(/already exists/) })
    delete process.env.FAKE_GH_MODE
    git(h.repo, 'remote', 'set-url', '--push', 'origin', '/nonexistent/remote')
    try {
      const unpushed = await json(await h.post(`/api/stack/${stack.id}/prs`))
      expect(unpushed.results[0]).toMatchObject({ status: 'failed' })
    } finally { git(h.repo, 'config', '--unset', 'remote.origin.pushurl') }
    const { stack: detached, layers } = await newStack(1)
    git(layers[0].path, 'checkout', '-q', '--detach')
    expect((await h.post(`/api/stack/${detached.id}/prs`)).status).toBe(500)
  })

  it('lands the bottom layer: merges its PR the preferred way, points the next PR at the base, and updates the rest', async () => {
    const { stack, layers } = await newStack(3)
    await h.post(`/api/stack/${stack.id}/prs`)
    const landed = await json(await h.post(`/api/stack/${stack.id}/land`))
    expect(landed.results[0]).toMatchObject({ worktreeID: layers[0].id, status: 'landed', message: '#40 merged (squash)' })
    expect(landed.results.slice(1).map((result: any) => result.worktreeID)).toEqual([layers[1].id, layers[2].id])
    expect(ghCalls()).toEqual(expect.arrayContaining(['pr merge 40 --squash', 'pr edit 41 --base main']))
    expect((await stackByID(stack.id)).layers).toEqual([layers[1].id, layers[2].id])
    expect(await worktreeOf(layers[0].id)).toBeTruthy()   // its worktree and branch stay
    expect((await worktreeOf(layers[1].id)).baseBranch).toBe('main')   // the new bottom is measured against the base now
    expect((await worktreeOf(layers[2].id)).baseBranch).toBe(layers[1].branch)
  })

  it('merges the way the repository allows, and lands a last layer by ending the stack', async () => {
    process.env.FAKE_GH_MODE = 'merge-only'
    const first = await newStack(1)
    await h.post(`/api/stack/${first.stack.id}/prs`)
    expect((await json(await h.post(`/api/stack/${first.stack.id}/land`))).results[0].message).toMatch(/merged \(merge\)$/)
    expect(await stackByID(first.stack.id)).toBeUndefined()
    process.env.FAKE_GH_MODE = 'rebase-only'
    const second = await newStack(2)
    await h.post(`/api/stack/${second.stack.id}/prs`)
    // Layer 2 has lost its pull request: nothing to point elsewhere, the rest still updates.
    const statePath = process.env.FAKE_GH_STATE!
    writeFileSync(join(statePath, second.layers[1].branch.replace(/\//g, '_')), '[]')
    const landed = await json(await h.post(`/api/stack/${second.stack.id}/land`))
    expect(landed.results[0].message).toMatch(/merged \(rebase\)$/)
    expect(ghCalls().some((call) => call.startsWith('pr edit'))).toBe(false)
  })

  it('refuses to land without a pull request, and says what GitHub said when the merge is refused', async () => {
    const { stack } = await newStack(2)
    const none = await h.post(`/api/stack/${stack.id}/land`)
    expect(none.status).toBe(400)
    expect((await none.json()).error).toMatch(/has no open pull request: open the stack's PRs first/)
    await h.post(`/api/stack/${stack.id}/prs`)
    process.env.FAKE_GH_MODE = 'merge-fail'
    const refused = await h.post(`/api/stack/${stack.id}/land`)
    expect(refused.status).toBe(500)
    expect((await refused.json()).error).toMatch(/base branch policy prohibits the merge/)
    expect((await stackByID(stack.id)).layers).toHaveLength(2)   // nothing landed, nothing dropped
    process.env.FAKE_GH_MODE = 'missing'   // gh gone: its failure has no words of its own
    const missing = await h.post(`/api/stack/${stack.id}/land`)
    expect(missing.status).toBe(500)
    expect((await missing.json()).error).toMatch(/Command failed/)
  })

  it('treats a layer whose folder is gone as having no pull request, and says so when the rest cannot be updated', async () => {
    const gone = await newStack(1)
    rmSync(gone.layers[0].path, { recursive: true, force: true })
    expect((await h.post(`/api/stack/${gone.stack.id}/land`)).status).toBe(400)
    const { stack, layers } = await newStack(2)
    await h.post(`/api/stack/${stack.id}/prs`)
    rmSync(layers[1].path, { recursive: true, force: true })
    const landed = await h.post(`/api/stack/${stack.id}/land`)
    expect(landed.status).toBe(500)   // the bottom landed; the one above could not be read
    expect(ghCalls()).toContain('pr merge 40 --squash')
    expect(ghCalls().some((call) => call.startsWith('pr edit'))).toBe(false)
    expect((await stackByID(stack.id)).layers).toEqual([layers[1].id])
  })

  it('measures the next layer against the stack\'s base as soon as the bottom has landed, even if GitHub then refuses the retarget', async () => {
    const { stack, layers } = await newStack(2)
    await h.post(`/api/stack/${stack.id}/prs`)
    process.env.FAKE_GH_MODE = 'edit-fail'
    expect((await h.post(`/api/stack/${stack.id}/land`)).status).toBe(500)
    expect(ghCalls().some((call) => call.startsWith('pr merge'))).toBe(true)
    expect((await worktreeOf(layers[1].id)).baseBranch).toBe('main')
  })

  it('shows each layer\'s open pull request once the PR list knows it', async () => {
    const { stack, layers } = await newStack(1)
    git(layers[0].path, 'branch', '-m', 'broken')   // #9 in the fake PR list has "broken" as its head
    await h.get(`/api/prs?project=${projectID}`)
    await h.get('/api/state')   // refreshes branches from git
    expect((await stackByID(stack.id)).prs).toEqual([{ number: 9, url: 'https://example.com/pr/9', state: 'open' }])
    git(layers[0].path, 'branch', '-m', 'broken', 'orch/after-broken')
  })
})

describe('pull requests built on each other', () => {
  it('stack themselves when opened: on a branch checked out here, then on a review checkout of its base', async () => {
    const featureOne = (await json(await h.post(`/api/project/${projectID}/worktree`, { branch: 'feature/one', checkoutExisting: true }))).worktree
    // #9 is opened on feature/one: the two become a stack, feature/one at the bottom.
    git(h.repo, 'fetch', '-q', 'origin', 'refs/pull/7/head'); git(h.repo, 'push', '-q', 'origin', 'FETCH_HEAD:refs/pull/9/head', 'FETCH_HEAD:refs/pull/11/head')
    const nine = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 9, branch: 'broken' }))).worktree
    const stacked = (await stateOf()).stacks.find((stack: any) => stack.layers.includes(nine.id))
    expect(stacked.layers).toEqual([featureOne.id, nine.id])
    expect(stacked.base).toBe('main')
    // #11 is opened on "broken", #9's head, which is checked out here as orch/pr-9: it goes right above it.
    await h.get(`/api/prs?project=${projectID}`)
    const review = await json(await h.post('/api/pr/review', { projectID, prNumber: 11 }))
    expect((await stackByID(stacked.id)).layers).toEqual([featureOne.id, nine.id, review.worktree.id])
  })
})
