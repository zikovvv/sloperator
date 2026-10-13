// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Worktree } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true }
const worktree: Worktree = {
  id: 'w', projectID: 'p', name: 'feature-one', path: '/w', branch: 'feature/one', baseBranch: 'main',
  isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main',
}
const session: Session = {
  id: 's1', worktreeID: 'w', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'steer',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
}

const activity = {
  inlineComments: 2, discussionComments: 0, commits: 4, reviews: 2, reviewState: 'CHANGES_REQUESTED',
  threadsOpen: 3, threadsResolved: 5, threadsForMe: 1,
}
const pr = (over: Record<string, unknown> = {}) => ({
  number: 7, title: 'Add widgets', url: 'https://example.com/7', headRefName: 'feature/one', baseRefName: 'main',
  state: 'open', mergedAt: null, closedAt: null, checkRuns: [], participants: null,
  author: 'alice', authorAvatar: 'https://example.com/alice.png', isMine: false, isDraft: false, checks: 'pass',
  assignees: [{ login: 'octo', avatarUrl: '' }], reviewers: ['octo', 'core'], reviewRequested: true,
  createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastCommitAt: '2026-08-31T00:00:00Z',
  commitCount: 6, additions: 40, deletions: 2, changedFiles: 2, unread: 2,
  linearKey: 'WID-7', linearURL: 'https://linear.app/acme-co/issue/WID-7',
  totals: null, worktreeID: null, activity, ...over,
})

beforeEach(() => {
  vi.resetModules()
  vi.doMock('../../src/lib/toast.ts', () => ({ toast: vi.fn(), reportError: vi.fn() }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (prs: any[], impl: Record<string, any> = {}, worktrees: Worktree[] = []) => {
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, {
    get: (_t, key: string) => impl[key] ?? ((...args: any[]) => {
      calls.push([key, args]); return Promise.resolve({ ok: true })
    }),
  })
  ;(impl as any).prs ??= async () => ({ ok: true, viewer: 'octo', prs, fetchedAt: Date.now(), pending: false })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
  const onOpenSession = vi.fn(); const onChanged = vi.fn()
  render(<PullRequestsTab projects={[project]} worktrees={worktrees} sessions={[session]}
                          defaultProjectID="p" onOpenSession={onOpenSession} onChanged={onChanged} />)
  await waitFor(() => expect(screen.getByText(/Add widgets/)).toBeTruthy())
  return { calls, onOpenSession, onChanged }
}

describe('a pull request shows what you did on it', () => {
  it('lists your comments, commits, reviews, review verdict, unread notices and conversations', async () => {
    await mount([pr()])
    expect(screen.getByText('2 inline')).toBeTruthy()
    expect(screen.queryByText('0 notes')).toBeNull()
    expect(screen.getByText('4 commits')).toBeTruthy()
    expect(screen.getByText('2 reviews')).toBeTruthy()
    expect(screen.getByText('you requested changes').className).toContain('text-bad')
    // Once on the row, once as the page total.
    expect(screen.getAllByText('2 unread')).toHaveLength(2)
    expect(screen.getByText('1 to handle')).toBeTruthy()
    expect(screen.getByText('3 open')).toBeTruthy()
    expect(screen.getByText('5 handled')).toBeTruthy()
  })

  it('shows an approval, and nothing at all when GitHub gave no activity', async () => {
    await mount([pr({ unread: 0, activity: { ...activity, reviewState: 'APPROVED', threadsForMe: 0, threadsOpen: 0, threadsResolved: 0 } })])
    expect(screen.getByText('you approved').className).toContain('text-ok')
    expect(screen.queryByText(/to handle/)).toBeNull()
    cleanup(); vi.resetModules()
    await mount([pr({ activity: null })])
    expect(screen.queryByText(/inline/)).toBeNull()
  })

  it('shows a commented verdict', async () => {
    await mount([pr({ activity: { ...activity, reviewState: 'COMMENTED' } })])
    expect(screen.getByText('you commented').className).toContain('text-warn')
  })
})

describe('every pull request can reach a worktree', () => {
  it('creates one, opens the session it lands in, and says when it had to copy the head', async () => {
    const created = { ok: true, worktree: { id: 'w2', branch: 'orch/pr-7' }, copied: true }
    const newSession = vi.fn(async () => ({ id: 'fresh' }))
    const { onOpenSession, onChanged } = await mount([pr()], {
      prWorktree: async () => created, newSession,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Worktree' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    await waitFor(() => expect(newSession).toHaveBeenCalledWith('w2'))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('fresh'))
    const { toast } = await import('../../src/lib/toast.ts')
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/orch\/pr-7 holds a copy of the pull request head/), 'info')
  })

  it('opens the existing session when a worktree already holds the branch', async () => {
    const { onOpenSession } = await mount([pr({ worktreeID: 'w' })], {}, [worktree])
    expect(screen.getByText(/worktree feature-one/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open worktree' }))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
  })

  it('reports why a worktree could not be made', async () => {
    await mount([pr()], { prWorktree: async () => { throw new Error('git said no') } })
    fireEvent.click(screen.getByRole('button', { name: 'Worktree' }))
    await waitFor(() => expect(screen.getByText('git said no')).toBeTruthy())
  })

  it('offers Review beside Worktree for a foreign PR, and not for your own', async () => {
    const { onOpenSession } = await mount([pr()], {
      reviewPR: async () => ({ session: { id: 'rev' } }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('rev'))
    cleanup(); vi.resetModules()
    await mount([pr({ isMine: true })])
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Worktree' })).toBeTruthy()
  })
})

describe('before GitHub has answered', () => {
  it('shows no counts and says it is asking, rather than reading as "you have none"', async () => {
    let land: (value: any) => void = () => {}
    const pending = new Promise((resolve) => { land = resolve })
    const api = { prs: () => pending, prDetails: async () => ({ ok: false, message: 'x' }),
                  prComments: async () => ({ ok: false, message: 'x' }) }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[session]}
                            defaultProjectID="p" onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    // No "Open 0" while the answer is still outstanding — a zero would read as an answer.
    const open = () => screen.getByRole('button', { name: /Open/ })
    await waitFor(() => expect(screen.getByText(/Asking GitHub for this project/)).toBeTruthy())
    expect(open().textContent).not.toMatch(/\d/)
    land({ ok: true, viewer: 'octo', prs: [], fetchedAt: 123, pending: false })
    // Once it has answered, an empty result really does mean none.
    await waitFor(() => expect(open().textContent).toMatch(/0/))
    expect(screen.getByText('No pull requests.')).toBeTruthy()
  })

  it('still shows the reason when the answer is a refusal', async () => {
    const api = { prs: async () => ({ ok: false, message: 'gh: not logged in' }),
                  prDetails: async () => ({ ok: false, message: 'x' }), prComments: async () => ({ ok: false, message: 'x' }) }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[session]}
                            defaultProjectID="p" onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/not logged in/)).toBeTruthy())
  })
})

describe('when the tab is on screen before the projects have arrived', () => {
  it('fetches as soon as they do, instead of sitting on an empty list forever', async () => {
    const calls: string[] = []
    const api = {
      prs: async (id: string) => { calls.push(id); return { ok: true, viewer: 'octo', prs: [pr()], fetchedAt: 1, pending: false } },
      prDetails: async () => ({ ok: false, message: 'x' }), prComments: async () => ({ ok: false, message: 'x' }),
    }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    // This is the mount the socket loses to: no projects yet, and no default to fall back on.
    const { rerender } = render(<PullRequestsTab projects={[]} worktrees={[]} sessions={[session]}
                                                 defaultProjectID={null} onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    expect(calls).toEqual([])
    rerender(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[session]}
                              defaultProjectID={null} onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(calls).toEqual(['p']))
    await waitFor(() => expect(screen.getByText(/Add widgets/)).toBeTruthy())
  })

  it('still lets you pick a different project by hand', async () => {
    const other: Project = { id: 'p2', name: 'other', path: '/o', isGit: true, isExpanded: true }
    const calls: string[] = []
    const api = {
      prs: async (id: string) => { calls.push(id); return { ok: true, viewer: 'octo', prs: [], fetchedAt: 1, pending: false } },
      prDetails: async () => ({ ok: false, message: 'x' }), prComments: async () => ({ ok: false, message: 'x' }),
    }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    render(<PullRequestsTab projects={[project, other]} worktrees={[]} sessions={[session]}
                            defaultProjectID="p" onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(calls).toEqual(['p']))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p2' } })
    await waitFor(() => expect(calls).toEqual(['p', 'p2']))
  })
})
