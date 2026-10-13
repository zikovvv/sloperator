// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true }
const base = {
  url: 'https://example.com/7', headRefName: 'feature/one', baseRefName: 'main', state: 'open', mergedAt: null, closedAt: null,
  checkRuns: [], participants: null,
  author: 'alice', authorAvatar: 'https://example.com/alice.png', isMine: false, isDraft: false, checks: 'pass',
  assignees: [], reviewers: [], reviewRequested: false,
  createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastCommitAt: '2026-08-31T00:00:00Z',
  commitCount: 6, additions: 40, deletions: 2, changedFiles: 2, unread: 0,
  linearKey: null, linearURL: null, totals: null, worktreeID: null, activity: null,
}
const pr = (number: number, over: Record<string, unknown> = {}) => ({ ...base, number, title: `PR ${number}`, ...over })

beforeEach(() => {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../../src/lib/toast.ts', () => ({ toast: vi.fn(), reportError: vi.fn() }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const mount = async (impl: Record<string, any>) => {
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? (() => Promise.resolve({ ok: true })) })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
  render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[]} defaultProjectID="p"
                          onOpenSession={() => {}} onChanged={() => {}} />)
}
const rows = () => screen.queryAllByTestId(/^pr-/).map((row) => Number(row.dataset.testid!.slice(3)))
const listing = (prs: any[], extra: Record<string, unknown> = {}) =>
  ({ ok: true, viewer: 'octo', prs, fetchedAt: Date.now(), pending: false, ...extra })

describe('the row', () => {
  it('shows avatar, assignees, reviewers, requested review, draft or ready, ages, commits and a Linear link', async () => {
    await mount({ prs: async () => listing([pr(7, {
      assignees: [{ login: 'octo', avatarUrl: '' }], reviewers: ['octo', 'core'], reviewRequested: true,
      linearKey: 'WID-7', linearURL: 'https://linear.app/acme-co/issue/WID-7', isDraft: true, state: 'draft',
    })]) })
    await waitFor(() => expect(screen.getByText('PR 7')).toBeTruthy())
    expect((screen.getByAltText('alice') as HTMLImageElement).src).toBe('https://example.com/alice.png')
    expect(screen.getAllByTitle('octo').some((el) => el.textContent === 'oc')).toBe(true)   // no avatar: initials
    expect(screen.getByText('review requested')).toBeTruthy()
    expect(screen.getByText('draft')).toBeTruthy()
    expect(screen.getByText(/reviewers octo, core/)).toBeTruthy()
    expect(screen.getByText('6 commits')).toBeTruthy()
    expect(screen.getByText(/opened .* ago/)).toBeTruthy()
    const linear = screen.getByRole('link', { name: 'WID-7' }) as HTMLAnchorElement
    expect(linear.href).toBe('https://linear.app/acme-co/issue/WID-7')
    expect(screen.getByText('+40')).toBeTruthy()   // first-tier sizes until details land
  })

  it('shows a bare key when the workspace is unknown, "ready" for non-drafts, and hides an empty activity line', async () => {
    await mount({ prs: async () => listing([pr(7, {
      linearKey: 'WID-7', linearURL: null, lastCommitAt: null,
      activity: { inlineComments: 0, discussionComments: 0, commits: 0, reviews: 0, reviewState: null, threadsOpen: 0, threadsResolved: 0, threadsForMe: 0 },
      totals: { source: { added: 1, removed: 0, files: 1 }, tests: { added: 0, removed: 0, files: 0 } },
    })]) })
    await waitFor(() => expect(screen.getByText('PR 7')).toBeTruthy())
    expect(screen.queryByRole('link', { name: 'WID-7' })).toBeNull()
    expect(screen.getByText('WID-7').title).toMatch(/Settings/)
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.queryByText('you:')).toBeNull()
    expect(screen.getByText(/last commit —/)).toBeTruthy()
  })

  it('caps your commits at 100+ since only the last hundred are inspected', async () => {
    await mount({ prs: async () => listing([pr(7, {
      activity: { inlineComments: 0, discussionComments: 0, commits: 100, reviews: 0, reviewState: null, threadsOpen: 0, threadsResolved: 0, threadsForMe: 0 },
    })]) })
    await waitFor(() => expect(screen.getByText('100+ commits')).toBeTruthy())
  })
})

describe('loading in two tiers', () => {
  it('paints the first tier, then swaps in the detailed rows, and says how fresh they are', async () => {
    let release!: (value: any) => void
    const prDetails = vi.fn(() => new Promise((resolve) => { release = resolve }))
    await mount({
      prs: async () => listing([pr(7)], { pending: true }),
      prDetails,
    })
    await waitFor(() => expect(screen.getByText('PR 7')).toBeTruthy())
    expect(screen.queryByText('you:')).toBeNull()
    expect(prDetails).toHaveBeenCalledWith('p')
    await act(async () => { release(listing([pr(7, {
      activity: { inlineComments: 1, discussionComments: 0, commits: 0, reviews: 0, reviewState: null, threadsOpen: 0, threadsResolved: 0, threadsForMe: 0 },
      totals: { source: { added: 9, removed: 1, files: 1 }, tests: { added: 0, removed: 0, files: 0 } },
    })])) })
    expect(screen.getByText('1 inline')).toBeTruthy()
    expect(screen.getByText('+9')).toBeTruthy()
    expect(screen.getByText(/as of just now/)).toBeTruthy()
  })

  it('refreshes on demand, drops a stale answer that arrives after a newer request, and reports a failure', async () => {
    let calls = 0
    const answers: Array<(value: any) => void> = []
    await mount({
      prs: () => new Promise((resolve) => { calls += 1; answers.push(resolve) }),
    })
    expect(calls).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(calls).toBe(2)
    await act(async () => { answers[1](listing([pr(2)])) })
    await act(async () => { answers[0](listing([pr(1)])) })   // late: ignored
    expect(rows()).toEqual([2])
    expect(screen.queryByText('Asking GitHub…')).toBeNull()
    cleanup(); vi.resetModules()
    await mount({ prs: async () => { throw new Error('gh is sulking') } })
    await waitFor(() => expect(screen.getByText('gh is sulking')).toBeTruthy())
  })
})

describe('the worktree button', () => {
  it('opens a fresh session in a worktree that checked the branch out cleanly, with no copy banner', async () => {
    const newSession = vi.fn(async () => ({ id: 'fresh' }))
    await mount({
      prs: async () => listing([pr(7)]),
      prWorktree: async () => ({ ok: true, worktree: { id: 'w9', branch: 'feature/one' }, copied: false }),
      newSession,
    })
    await waitFor(() => expect(screen.getByText('PR 7')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Worktree' }))
    await waitFor(() => expect(newSession).toHaveBeenCalledWith('w9'))
    const { toast } = await import('../../src/lib/toast.ts')
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('every order', () => {
  const prs = [
    pr(1, { updatedAt: '2026-09-01T00:00:00Z', unread: 0, title: 'b' }),
    pr(2, { updatedAt: '2026-09-02T00:00:00Z', unread: 4, title: 'a' }),
    pr(3, { updatedAt: '2026-09-03T00:00:00Z', unread: 1, title: 'c' }),
  ]
  it('offers every sort, reverses, remembers the choice, and totals unread in the header', async () => {
    await mount({ prs: async () => listing(prs) })
    await waitFor(() => expect(rows()).toEqual([3, 2, 1]))
    expect(screen.getByText('5 unread')).toBeTruthy()
    const sort = screen.getByLabelText('Sort by') as HTMLSelectElement
    expect(within(sort).getAllByRole('option').length).toBeGreaterThanOrEqual(19)
    fireEvent.change(sort, { target: { value: 'unread' } })
    expect(rows()).toEqual([2, 3, 1])
    fireEvent.click(screen.getByRole('button', { name: 'Reverse order' }))
    expect(rows()).toEqual([1, 3, 2])
    expect(screen.getByRole('button', { name: 'Reverse order' }).textContent).toBe('↑')
    fireEvent.change(sort, { target: { value: 'title' } })
    expect(rows()).toEqual([2, 1, 3])
    expect(screen.getByRole('button', { name: 'Reverse order' }).textContent).toBe('↑')   // ascending by nature
    expect(JSON.parse(localStorage.getItem('orchestrator.prSort')!)).toEqual({ id: 'title', flipped: false })

    cleanup(); vi.resetModules()
    await mount({ prs: async () => listing(prs) })
    await waitFor(() => expect(rows()).toEqual([2, 1, 3]))
  })

  it('survives a corrupt remembered choice and a storage that throws', async () => {
    localStorage.setItem('orchestrator.prSort', '{nope')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    await mount({ prs: async () => listing(prs) })
    await waitFor(() => expect(rows()).toEqual([3, 2, 1]))
    setItem.mockRestore()
  })
})

describe('state, CI and teammates', () => {
  it('colours the circle like GitHub, hides merged and closed by default, and shows them on demand with when', async () => {
    await mount({ prs: async () => listing([
      pr(1, { state: 'open' }), pr(2, { state: 'draft', isDraft: true }),
      pr(3, { state: 'merged', mergedAt: '2026-08-28T00:00:00Z' }), pr(4, { state: 'closed', closedAt: '2026-08-20T00:00:00Z' }),
    ]) })
    await waitFor(() => expect(rows()).toEqual([1, 2]))
    const circle = (n: number) => within(screen.getByTestId(`pr-${n}`)).getByTestId('state')
    expect(circle(1).className).toContain('text-ok'); expect(circle(1).title).toBe('Open')
    expect(circle(2).className).toContain('text-ink-500'); expect(circle(2).title).toBe('Draft')
    const states = screen.getByRole('group', { name: 'States' })
    expect(within(states).getByRole('button', { name: /Merged 1/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(states).getByRole('button', { name: /Merged 1/ }))
    fireEvent.click(within(states).getByRole('button', { name: /Closed 1/ }))
    expect(rows()).toEqual([1, 2, 3, 4])
    expect(circle(3).className).toContain('text-purple-400')
    expect(circle(4).className).toContain('text-bad')
    expect(within(screen.getByTestId('pr-3')).getByText(/merged .* ago/)).toBeTruthy()
    expect(within(screen.getByTestId('pr-4')).getByText(/closed .* ago/)).toBeTruthy()
    fireEvent.click(within(states).getByRole('button', { name: /Open 1/ }))
    expect(rows()).toEqual([2, 3, 4])
    expect(JSON.parse(localStorage.getItem('orchestrator.prStates')!)).toEqual(['draft', 'merged', 'closed'])
    const sort = screen.getByLabelText('Sort by') as HTMLSelectElement
    fireEvent.change(sort, { target: { value: 'state' } })
    expect(rows()).toEqual([2, 3, 4])
    fireEvent.change(sort, { target: { value: 'merged' } })
    expect(rows()).toEqual([3, 4, 2])
  })

  it('names the CI checks: failures inline with links, pending counts, all passing, and none', async () => {
    await mount({ prs: async () => listing([
      pr(1, { checks: 'fail', checkRuns: [{ name: 'test', result: 'fail', url: 'https://example.com/run' }, { name: 'lint', result: 'fail', url: null }, { name: 'build', result: 'pass', url: null }] }),
      pr(2, { checks: 'pending', checkRuns: [{ name: 'test', result: 'pending', url: null }, { name: 'build', result: 'pass', url: null }] }),
      pr(3, { checks: 'pass', checkRuns: [{ name: 'test', result: 'pass', url: null }, { name: 'lint', result: 'skipped', url: null }] }),
      pr(4, { checks: '', checkRuns: [] }),
      pr(5, { checks: 'pass', checkRuns: [] }),
      pr(6, { checks: 'pass', checkRuns: [{ name: 'test', result: 'pass', url: null }, { name: 'build', result: 'pass', url: null }] }),
    ]) })
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(within(screen.getByTestId('pr-6')).getByTestId('checks').textContent).toBe('CI ✓ 2 passing')
    const checks = (n: number) => within(screen.getByTestId(`pr-${n}`)).getByTestId('checks')
    expect(checks(1).textContent).toContain('CI ✗ 2 of 3 failing')
    expect(within(checks(1)).getByRole('link', { name: 'test' }).getAttribute('href')).toBe('https://example.com/run')
    expect(within(checks(1)).getByText('lint')).toBeTruthy()
    expect(checks(1).className).toContain('text-bad')
    expect(checks(1).title).toBe('✗ test\n✗ lint\n✓ build')
    expect(checks(2).textContent).toContain('CI ⋯ 1 of 2 running')
    expect(checks(3).textContent).toContain('CI ✓ 1 of 2 passing')
    expect(checks(3).title).toContain('– lint')
    expect(checks(4).textContent).toBe('no CI')
    expect(checks(5).textContent).toBe('CI pass')
  })

  it('shows teammates with their verdict ring, marks and counts, plus requested reviewers who have not answered', async () => {
    await mount({ prs: async () => listing([pr(1, {
      reviewers: ['dave', 'bob'],
      participants: [
        { login: 'bob', avatarUrl: 'https://example.com/bob.png', verdict: 'CHANGES_REQUESTED', inlineComments: 4, discussionComments: 1 },
        { login: 'carol', avatarUrl: '', verdict: 'APPROVED', inlineComments: 0, discussionComments: 0 },
        { login: 'erin', avatarUrl: '', verdict: 'COMMENTED', inlineComments: 1, discussionComments: 0 },
        { login: 'fay', avatarUrl: '', verdict: null, inlineComments: 0, discussionComments: 2 },
      ],
    })]) })
    await waitFor(() => expect(rows()).toEqual([1]))
    const reviewers = screen.getByTestId('reviewers')
    expect(reviewers.textContent).toContain('bob✗4 inline, 1 note')
    expect(reviewers.textContent).toContain('carol✓')
    expect(reviewers.textContent).toContain('erin…1 inline')
    expect(reviewers.textContent).toContain('fay2 notes')
    expect(reviewers.textContent).toContain('dave')
    expect(screen.getByTitle('bob — requested changes · 4 inline, 1 note').className).toContain('ring-bad')
    expect(screen.getByTitle('carol — approved').className).toContain('ring-ok')
    expect(screen.getByTitle('dave — review requested, not yet reviewed').className).toContain('ring-ink-600')
    expect(screen.getByTitle('fay — commented, no verdict · 2 notes').className).toContain('ring-ink-700')
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'reviewers' } })
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'approvals' } })
    expect(rows()).toEqual([1])
    cleanup(); vi.resetModules(); localStorage.clear()
    // Before the second tier answers, participants are null: sorting by them must still work.
    await mount({ prs: async () => listing([
      pr(1, { participants: null, reviewers: [] }),
      pr(2, { participants: [{ login: 'bob', avatarUrl: '', verdict: 'APPROVED', inlineComments: 0, discussionComments: 0 }], reviewers: ['dave'] }),
    ]) })
    await waitFor(() => expect(rows()).toEqual([1, 2]))
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'reviewers' } })
    expect(rows()).toEqual([2, 1])
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'approvals' } })
    expect(rows()).toEqual([2, 1])
    cleanup(); vi.resetModules()
    await mount({ prs: async () => listing([pr(2)]) })
    await waitFor(() => expect(rows()).toEqual([2]))
    expect(screen.queryByTestId('reviewers')).toBeNull()
  })

  it('searches number, title, branch, author, key and people, word by word', async () => {
    await mount({ prs: async () => listing([
      pr(1, { title: 'Fix login', author: 'amy', linearKey: 'WID-1', assignees: [{ login: 'zed', avatarUrl: '' }] }),
      pr(2, { title: 'Add search', headRefName: 'feat/search', reviewers: ['bob'], participants: [{ login: 'carol', avatarUrl: '', verdict: null, inlineComments: 0, discussionComments: 0 }] }),
    ]) })
    await waitFor(() => expect(rows()).toEqual([1, 2]))
    const box = screen.getByLabelText('Search pull requests')
    for (const [query, expected] of [['login', [1]], ['#2', [2]], ['feat/search', [2]], ['AMY', [1]], ['wid-1', [1]], ['zed', [1]], ['bob', [2]], ['carol', [2]], ['add carol', [2]], ['nothing here', []]] as const) {
      fireEvent.change(box, { target: { value: query } })
      expect(rows()).toEqual(expected)
    }
    expect(screen.getByText('Nothing matches that search and those states.')).toBeTruthy()
    fireEvent.change(box, { target: { value: '   ' } })
    expect(rows()).toEqual([1, 2])
  })
})
