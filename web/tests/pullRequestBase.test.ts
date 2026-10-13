import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { pullRequestBase, pullRequestBaseFor, type PullRequest } from '../server/github.ts'

const pr = (over: Partial<PullRequest>): PullRequest => ({
  number: 1, title: 't', url: 'u', headRefName: 'h', baseRefName: 'main', state: 'open', isDraft: false,
  author: 'a', isMine: false, checks: 'pass', assignees: [], reviewers: [], checkRuns: [], participants: null,
  mergedAt: null, closedAt: null, createdAt: '', updatedAt: '', lastCommitAt: null, commitCount: 0,
  additions: 0, deletions: 0, changedFiles: 0, unread: 0, linearKey: null, linearURL: null, totals: null,
  worktreeID: null, activity: null, authorAvatar: null, reviewRequested: false, ...over,
} as PullRequest)

describe('pullRequestBaseFor', () => {
  it('finds the open pull request a branch belongs to, by its head or its review checkout, and reads its base', () => {
    const prs = [
      pr({ number: 7, headRefName: 'feature/widgets', baseRefName: 'main' }),
      pr({ number: 9, headRefName: 'stack', baseRefName: 'feature/one', state: 'draft' }),
      pr({ number: 3, headRefName: 'old', baseRefName: 'release', state: 'merged' }),
      pr({ number: 4, headRefName: 'blank', baseRefName: '' }),
    ]
    expect(pullRequestBaseFor('stack', prs)).toBe('feature/one')          // by head, a draft counts
    expect(pullRequestBaseFor('orch/pr-9', prs)).toBe('feature/one')      // the review checkout of the same PR
    expect(pullRequestBaseFor('feature/widgets', prs)).toBe('main')
    expect(pullRequestBaseFor('old', prs)).toBeNull()                    // merged: no longer measured against anything
    expect(pullRequestBaseFor('blank', prs)).toBeNull()                  // GitHub said nothing useful
    expect(pullRequestBaseFor('nobody', prs)).toBeNull()
    expect(pullRequestBaseFor(null, prs)).toBeNull()
  })

  it('asks GitHub for the base of one pull request, and has no answer when it says nothing or is not there', async () => {
    expect(await pullRequestBase(tmpdir(), 9)).toBe('feature/one')
    expect(await pullRequestBase(tmpdir(), 0)).toBeNull()
    process.env.FAKE_GH_MODE = 'unauth'
    try { expect(await pullRequestBase(tmpdir(), 9)).toBeNull() } finally { delete process.env.FAKE_GH_MODE }
  })
})
