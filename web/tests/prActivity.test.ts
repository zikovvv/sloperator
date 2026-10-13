import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resetGitHubCaches } from '../server/github.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const prs = async () => (await json(await h.get(`/api/prs?project=${projectID}`))).body.prs

beforeAll(async () => {
  process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await json(await h.get('/api/state'))).body.projects[0].id
})
afterAll(async () => { await h.stop() })

const details = async () => (await json(await h.get(`/api/prs/details?project=${projectID}`))).body.prs

describe('the first tier: everything a row needs, straight from one GraphQL call', () => {
  it('reports draft state, author with avatar, assignees, requested reviewers, ages, commits, sizes, CI, unread and the ticket key', async () => {
    const first = (await json(await h.get(`/api/prs?project=${projectID}&refresh=1`))).body
    expect(first.ok).toBe(true); expect(first.viewer).toBe('octo'); expect(typeof first.fetchedAt).toBe('number')
    const seven = first.prs.find((pr: any) => pr.number === 7)
    expect(seven).toMatchObject({
      title: '[WID-7] Add widgets', isDraft: false, author: 'alice', authorAvatar: 'https://example.com/alice.png',
      assignees: [{ login: 'octo', avatarUrl: 'https://example.com/octo.png' }],
      reviewers: ['octo', 'core'], reviewRequested: true, isMine: false,
      createdAt: '2026-08-20T00:00:00Z', lastCommitAt: '2026-08-31T12:00:00Z', commitCount: 6,
      additions: 40, deletions: 2, changedFiles: 2, checks: 'pass', unread: 2, linearKey: 'WID-7',
    })
    const eight = first.prs.find((pr: any) => pr.number === 8)
    expect(eight).toMatchObject({ isDraft: true, isMine: true, checks: 'pending', reviewRequested: false, unread: 0, linearKey: 'WID-8', assignees: [] })
    const nine = first.prs.find((pr: any) => pr.number === 9)
    expect(nine).toMatchObject({ checks: '', lastCommitAt: null, commitCount: 0, linearKey: null, authorAvatar: '', checkRuns: [] })
    expect(first.prs.map((pr: any) => pr.number)).toEqual([7, 8, 9, 6, 5])
    // GitHub's states, and every check on the head commit by name.
    expect(first.prs.map((pr: any) => pr.state)).toEqual(['open', 'draft', 'open', 'merged', 'closed'])
    expect(seven.checkRuns).toEqual([
      { name: 'test', result: 'pass', url: 'https://example.com/run/1' },
      { name: 'lint', result: 'skipped', url: null },
      { name: 'coverage/report', result: 'pass', url: 'https://example.com/cov' },
    ])
    expect(eight.checkRuns).toEqual([{ name: 'test', result: 'pending', url: null }])
    const six = first.prs.find((pr: any) => pr.number === 6)
    expect(six).toMatchObject({ state: 'merged', mergedAt: '2026-08-28T00:00:00Z', checks: 'fail' })
    expect(six.checkRuns).toEqual([
      { name: 'test', result: 'fail', url: 'https://example.com/run/6' },
      { name: 'deploy', result: 'pending', url: null },
    ])
  })

  it('serves the same listing from cache at once, and a forced refresh asks again', async () => {
    const cached = (await json(await h.get(`/api/prs?project=${projectID}`))).body
    expect(cached.ok).toBe(true); expect(cached.prs).toHaveLength(5)
    expect((await h.get('/api/prs?project=nope')).status).toBe(404)
    expect((await h.get('/api/prs/details?project=nope')).status).toBe(404)
  })
})

describe('the second tier: what you yourself did on a pull request', () => {
  it('counts your inline comments, notes, commits, reviews, verdict and conversations; splits tests; links Linear', async () => {
    const seven = (await details()).find((pr: any) => pr.number === 7)
    // Someone else's PR: only the conversations you are actually in are yours to handle.
    expect(seven.activity).toEqual({
      inlineComments: 3, discussionComments: 2, commits: 2, reviews: 2, reviewState: 'APPROVED',
      threadsOpen: 4, threadsResolved: 1, threadsForMe: 1,
    })
    // Teammates: latest decisive verdict each, dismissed ones ignored, and how much they said.
    expect(seven.participants).toEqual([
      { login: 'bob', avatarUrl: 'https://example.com/bob.png', verdict: 'CHANGES_REQUESTED', inlineComments: 4, discussionComments: 0 },
      { login: 'carol', avatarUrl: '', verdict: 'APPROVED', inlineComments: 0, discussionComments: 0 },
      { login: 'alice', avatarUrl: '', verdict: null, inlineComments: 0, discussionComments: 1 },
    ])
    expect(seven.totals.source).toEqual({ files: 1, added: 10, removed: 2 })
    expect(seven.totals.tests).toEqual({ files: 1, added: 30, removed: 0 })
    expect(seven.linearURL).toBe('https://linear.app/acme-co/issue/WID-7')
  })

  it('counts every open conversation on your own PR as yours, links a bare key through the learned workspace, and leaves an omitted PR bare', async () => {
    const list = await details()
    const eight = list.find((pr: any) => pr.number === 8)
    expect(eight.activity).toMatchObject({ inlineComments: 0, reviewState: null, threadsOpen: 1, threadsForMe: 1 })
    expect(eight.linearURL).toBe('https://linear.app/acme-co/issue/WID-8')
    expect((await json(await h.get('/api/settings'))).body.linearWorkspace).toBe('acme-co')
    const nine = list.find((pr: any) => pr.number === 9)
    expect(nine.activity).toBeNull(); expect(nine.totals).toBeNull(); expect(nine.linearURL).toBeNull()
  })

  it('still lists the PRs when the token cannot read notifications or the detailed query fails', async () => {
    resetGitHubCaches()
    process.env.FAKE_GH_MODE = 'no-notifications'
    try {
      const first = (await json(await h.get(`/api/prs?project=${projectID}&refresh=1`))).body
      expect(first.prs.find((pr: any) => pr.number === 7).unread).toBe(0)
      await details()
      process.env.FAKE_GH_MODE = 'no-details'
      const light = (await json(await h.get(`/api/prs?project=${projectID}&refresh=1`))).body
      expect(light.ok).toBe(true); expect(light.pending).toBe(true)
      // The previous details are carried on the rows until a refresh manages to replace them.
      expect(light.prs.find((pr: any) => pr.number === 7).activity).not.toBeNull()
      const after = (await json(await h.get(`/api/prs/details?project=${projectID}`))).body
      expect(after.ok).toBe(true); expect(after.pending).toBe(false)
    } finally {
      delete process.env.FAKE_GH_MODE
      resetGitHubCaches()
    }
  })
})

describe('every pull request can reach a worktree', () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim()
  // GitHub's head for a PR is what decides: a same-named local branch that is a different commit
  // belongs to somebody else's work and must never be opened as that pull request.
  const publishAsPR = (branch: string, prNumber: number) =>
    git('push', '-q', 'origin', `${branch}:refs/pull/${prNumber}/head`, '--force')

  it('checks out the branch when it really is the pull request head, and reuses that worktree next time', async () => {
    publishAsPR('feature/one', 9)
    const created = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 9, branch: 'feature/one' }))).body
    expect(created.copied).toBe(false)
    expect(created.reused).toBe(false)
    expect(created.worktree.branch).toBe('feature/one')
    expect(existsSync(created.worktree.path)).toBe(true)

    const again = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 9, branch: 'feature/one' }))).body
    expect(again.reused).toBe(true)
    expect(again.worktree.id).toBe(created.worktree.id)
  })

  it('checks out a branch that exists only on the remote', async () => {
    git('branch', 'remote-only', 'main')
    git('push', '-q', 'origin', 'remote-only')
    publishAsPR('remote-only', 11)
    git('branch', '-q', '-D', 'remote-only')
    const created = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 11, branch: 'remote-only' }))).body
    expect(created.copied).toBe(false)
    expect(created.worktree.branch).toBe('remote-only')
  })

  it('copies the head when a same-named local branch is not the pull request head', async () => {
    // A local branch of the same name that is a different commit: a fork's PR, or a stale copy.
    git('branch', 'shared-name', 'main')
    const copy = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 7, branch: 'shared-name' }))).body
    expect(copy.copied).toBe(true)
    expect(copy.worktree.branch).toBe('orch/pr-7')
    expect(existsSync(join(copy.worktree.path, 'src.py'))).toBe(true)
    // The local branch was left exactly where it was.
    expect(git('rev-parse', 'shared-name')).toBe(git('rev-parse', 'main'))
  })

  it('copies the head when the branch is held by a worktree outside the app', async () => {
    git('branch', 'held', 'main')
    publishAsPR('held', 12)
    git('worktree', 'add', '-q', join(h.stateDir, 'held-elsewhere'), 'held')
    const copy = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 12, branch: 'held' }))).body
    expect(copy.copied).toBe(true)
    expect(copy.worktree.branch).toBe('orch/pr-12')
  })

  it('copies the head when the branch lives on a fork', async () => {
    const copy = (await json(await h.post('/api/pr/worktree', { projectID, prNumber: 8, branch: 'someone:their-work' }))).body
    expect(copy.copied).toBe(true)
    expect(copy.worktree.branch).toBe('orch/pr-8')
  })

  it('refuses an unknown project and reports git\u2019s reason for an impossible pull request', async () => {
    expect((await h.post('/api/pr/worktree', { projectID: 'nope', prNumber: 7, branch: 'x' })).status).toBe(404)
    const failed = await json(await h.post('/api/pr/worktree', { projectID, prNumber: 404, branch: 'no/such' }))
    expect(failed.status).toBe(500)
    expect(failed.body.error).toMatch(/Could not fetch PR #404/)
  })
})
