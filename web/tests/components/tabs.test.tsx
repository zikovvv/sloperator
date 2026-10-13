// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const apiMock = () => {
  const impl: Record<string, any> = {}
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ ok: true, session: { id: 'new' } }) }) })
  return { api, impl, calls }
}
const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main'] }
const worktree: Worktree = { id: 'w', projectID: 'p', name: 'feature', path: '/wt/feature', branch: 'feature', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main' }
const sessionOf = (id: string, title: string, worktreeID = 'w'): Session => ({ id, worktreeID, title, engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 1, inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 })

describe('InfraTab', () => {
  it('lists, previews, edits, saves, refuses a stale save, follows links, guards navigation', async () => {
    const { api, impl } = apiMock()
    impl.infra = vi.fn(async (category: string) => ({ items: category === 'claudemd'
      ? [{ path: '/h/.claude/CLAUDE.md', title: 'Global CLAUDE.md', subtitle: 'Applies everywhere', group: 'Global', exists: true }, { path: '/acme/CLAUDE.md', title: 'CLAUDE.md', subtitle: 'missing', group: 'acme', exists: false }]
      : [{ path: `/h/.claude/${category}/x.md`, title: category, subtitle: '', group: 'Global', exists: true }] }))
    let saved = 0
    impl.infraFile = vi.fn(async (path: string) => path.endsWith('notes.md') ? { text: '# Notes', modified: 1 } : { text: '# Title\n[notes](notes.md) [[wiki]]', modified: 1 })
    impl.saveInfraFile = vi.fn(async (_p: string, _t: string, modified?: number) => { saved += 1; if (saved === 2) throw new Error('changed on disk'); return { ok: true, modified: (modified ?? 0) + 1 } })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { InfraTab } = await import('../../src/components/Tabs.tsx')
    render(<InfraTab />)
    await waitFor(() => expect(screen.getByText('Global CLAUDE.md')).toBeTruthy())
    fireEvent.click(screen.getByText('Global CLAUDE.md'))
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy())
    fireEvent.click(screen.getByText('notes'))
    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy())
    fireEvent.click(screen.getByText('Global CLAUDE.md'))
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '# Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(impl.saveInfraFile).toHaveBeenCalledTimes(1))
    fireEvent.change(editor, { target: { value: '# Changed again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/changed on disk/)).toBeTruthy())
    // Dirty: switching item or category asks first; cancel keeps the editor, discard moves on.
    fireEvent.click(screen.getByText('CLAUDE.md', { selector: 'span' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Memories' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByText('memories')).toBeTruthy())
    for (const category of ['Hooks', 'Skills', 'Agents', 'Commands']) {
      fireEvent.click(screen.getByRole('button', { name: category }))
      await waitFor(() => expect(screen.getByText(category.toLowerCase())).toBeTruthy())
    }
  })
})

describe('UsageTab', () => {
  it('renders plan limits, extra usage variants, and the local report; handles errors', async () => {
    const { api, impl } = apiMock()
    let plan: any = { plan: 'Max (20x)', fetchedAt: 1, limits: [
      { kind: 'session', group: 'session', label: 'Current session', percent: 30, resetsAt: new Date(Date.now() + 3600e3).toISOString(), isActive: false },
      { kind: 'weekly_all', group: 'weekly', label: 'All models', percent: 43, resetsAt: new Date(Date.now() + 86400e3).toISOString(), isActive: false },
    ], extra: { enabled: false, usedUSD: 0, limitUSD: 150, percent: 0, disabledReason: 'out_of_credits' } }
    impl.planUsage = vi.fn(async () => plan)
    const bucket = { messages: 3, input: 10, cacheRead: 20, cacheWrite: 5, output: 7, costUSD: 1.5 }
    impl.usage = vi.fn(async () => ({ blocks: [{ ...bucket, start: Date.now() - 1000, end: Date.now() + 1000, isActive: true, byModel: { opus: bucket } }], today: bucket, last7: bucket, last30: bucket, byModel: { opus: bucket, fable: bucket }, daily: [{ ...bucket, date: '2026-09-02', byModel: { opus: bucket } }], byProject: [{ ...bucket, project: 'acme' }], pricing: { opus: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 }, fable: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 } }, scannedFiles: 3, sessions: [sessionOf('s', 'costly')] }))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { UsageTab } = await import('../../src/components/Tabs.tsx')
    const { unmount } = render(<UsageTab />)
    await waitFor(() => expect(screen.getByText('Plan usage limits')).toBeTruthy())
    expect(screen.getByText(/No credits/)).toBeTruthy(); expect(screen.getByText('costly')).toBeTruthy(); expect(screen.getByText(/assumed = opus/)).toBeTruthy()
    unmount()
    plan = { ...plan, extra: { enabled: true, usedUSD: 3, limitUSD: 150, percent: 2, disabledReason: null } }
    render(<UsageTab />)
    await waitFor(() => expect(screen.getByText(/Pay-as-you-go/)).toBeTruthy())
    cleanup()
    plan = { ...plan, extra: { enabled: false, usedUSD: 0, limitUSD: 150, percent: 0, disabledReason: 'other' } }
    impl.usage = vi.fn(async () => ({ blocks: [], today: bucket, last7: bucket, last30: bucket, byModel: {}, daily: [], byProject: [], pricing: {}, scannedFiles: 0, sessions: [] }))
    render(<UsageTab />)
    await waitFor(() => expect(screen.getByText(/Monthly cap/)).toBeTruthy())
    expect(screen.getByText(/No messages in the current window/)).toBeTruthy()
    cleanup()
    impl.planUsage = vi.fn(async () => ({ error: 'Not signed in' })); impl.usage = vi.fn(async () => { throw new Error('x') })
    render(<UsageTab />)
    await waitFor(() => expect(screen.getByText('Not signed in')).toBeTruthy())
    cleanup()
    impl.planUsage = vi.fn(async () => { throw new Error('network') })
    render(<UsageTab />)
    await waitFor(() => expect(screen.getByText('network')).toBeTruthy())
  })
})

describe('PullRequestsTab and GitHubTab', () => {
  it('shows buttons per rule, reviews, opens worktrees, autofixes, refreshes and degrades', async () => {
    const { api, impl } = apiMock()
    const prs = { ok: true, viewer: 'octo', prs: [
      { number: 1, title: 'Theirs', url: 'u', headRefName: 'theirs', author: 'alice', isMine: false, isDraft: false, state: 'open', checks: 'pass', assignees: [], reviewers: [], checkRuns: [], participants: null, worktreeID: null, totals: { source: { files: 1, added: 2, removed: 3 }, tests: { files: 1, added: 4, removed: 0 } } },
      { number: 2, title: 'Mine', url: 'u', headRefName: 'mine', author: 'octo', isMine: true, isDraft: true, state: 'draft', checks: 'fail', assignees: [], reviewers: [], checkRuns: [], participants: null, worktreeID: 'w', totals: { source: { files: 0, added: 0, removed: 0 }, tests: { files: 0, added: 0, removed: 0 } } },
      { number: 3, title: 'Pending', url: 'u', headRefName: 'p', author: 'bob', isMine: false, isDraft: false, state: 'open', checks: 'pending', assignees: [], reviewers: [], checkRuns: [], participants: null, worktreeID: 'w-nosession', totals: null },
      { number: 4, title: 'Nocheck', url: 'u', headRefName: 'n', author: 'octo', isMine: true, isDraft: false, state: 'open', checks: '', assignees: [], reviewers: [], checkRuns: [], participants: null, worktreeID: null, totals: null },
    ] }
    impl.prs = vi.fn(async () => prs)
    impl.reviewPR = vi.fn(async () => { throw new Error('review failed') })
    impl.prComments = vi.fn(async () => ({ ok: true, comments: [
      { id: 'c1', prNumber: 2, prTitle: 'Mine', prBranch: 'mine', author: 'alice', body: 'fix this', url: 'https://x/c1', createdAt: new Date().toISOString(), path: 'a.py', kind: 'review' },
      { id: 'c2', prNumber: 2, prTitle: 'Mine', prBranch: 'mine', author: 'bob', body: 'and this', url: 'https://x/c2', createdAt: new Date().toISOString(), kind: 'discussion' },
    ] }))
    impl.autofixPR = vi.fn(async () => { throw new Error('autofix failed') })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    const { GitHubTab } = await import('../../src/components/Tabs.tsx')
    const onOpen = vi.fn(); const onChanged = vi.fn()
    const worktrees = [{ ...worktree, id: 'w' }, { ...worktree, id: 'w-nosession', name: 'empty' }]
    render(<PullRequestsTab projects={[project]} worktrees={worktrees} sessions={[sessionOf('s1', 'chat', 'w')]} defaultProjectID="p" onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText('Theirs')).toBeTruthy())
    expect(screen.getByText(/signed in as octo/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByText('review failed')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Open worktree' })[0]); expect(onOpen).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open worktree' })[1])   // no session: creates one
    impl.reviewPR = vi.fn(async () => ({ session: { id: 'rev' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('rev'))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p' } })
    cleanup()
    impl.prs = vi.fn(async () => ({ ok: false, message: 'gh missing' }))
    render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[]} defaultProjectID={null} onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText('gh missing')).toBeTruthy())
    cleanup()
    impl.prs = vi.fn(async () => ({ ok: true, viewer: null, prs: [] }))
    render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[]} defaultProjectID="p" onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText(/No pull requests/)).toBeTruthy())
    cleanup()
    impl.prs = vi.fn(async () => { throw new Error('boom') })
    render(<PullRequestsTab projects={[]} worktrees={[]} sessions={[]} defaultProjectID={null} onOpenSession={onOpen} onChanged={onChanged} />)
    cleanup()
    // GitHub tab
    render(<GitHubTab projects={[project]} defaultProjectID="p" onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText('fix this')).toBeTruthy())
    expect(screen.getByText('a.py')).toBeTruthy(); expect(screen.getByText(/2 comments/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open & autofix/ }))
    await waitFor(() => expect(screen.getByText('autofix failed')).toBeTruthy())
    impl.autofixPR = vi.fn(async () => ({ session: { id: 'fix' } }))
    fireEvent.click(screen.getByRole('button', { name: /Open & autofix/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('fix'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    cleanup()
    impl.prComments = vi.fn(async () => ({ ok: true, comments: [] }))
    render(<GitHubTab projects={[project]} defaultProjectID={null} onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText(/Nobody has commented/)).toBeTruthy())
    cleanup()
    impl.prComments = vi.fn(async () => { throw new Error('gh down') })
    render(<GitHubTab projects={[project]} defaultProjectID="p" onOpenSession={onOpen} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText('gh down')).toBeTruthy())
  })
})

describe('NewWorktreeDialog and SettingsDialog', () => {
  it('searches branches, switches modes, creates and reports warnings and errors; settings edit and debounce', async () => {
    const { api, impl } = apiMock()
    impl.branches = vi.fn(async () => ({ branches: ['main', 'feature/login', 'origin/feature/search'], defaultBranch: 'main' }))
    impl.newWorktree = vi.fn(async (_p: string, options: any) => options.name === 'warn' ? { session: { id: 'ws' }, warning: 'stash kept' } : options.name === 'boom' ? Promise.reject(new Error('git said no')) : { session: { id: 'ok' } })
    impl.settings = vi.fn(async () => ({ worktreeRoot: null, linearWorkspace: null, codexPricing: { input: 1, cached: 0.1, output: 2 }, claudePricing: { opus: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 } } }))
    impl.saveSettings = vi.fn(async () => ({}))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { NewWorktreeDialog, SettingsDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
    const onClose = vi.fn(); const onCreated = vi.fn()
    const { unmount } = render(<NewWorktreeDialog project={project} inUse={['main']} onClose={onClose} onCreated={onCreated} />)
    await waitFor(() => expect(impl.branches).toHaveBeenCalled())
    // The fork point starts on the repository's default branch.
    fireEvent.click(screen.getByRole('button', { name: /^main/ }))
    const search = screen.getByPlaceholderText(/Search 3 branches/)
    fireEvent.change(search, { target: { value: 'flogin' } }); fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByText('feature/login')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /feature\/login/ }))
    fireEvent.click(screen.getByText('Current HEAD', { selector: 'button.row' }))
    fireEvent.click(screen.getByRole('button', { name: /Current HEAD/ }))
    fireEvent.change(screen.getByPlaceholderText(/Search 3 branches/), { target: { value: 'zzz' } })
    expect(screen.getByText(/No branch matches/)).toBeTruthy()
    fireEvent.keyDown(screen.getByPlaceholderText(/Search 3 branches/), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Existing branch' }))
    expect((screen.getByRole('button', { name: 'Create and open chat' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Choose a branch/ }))
    fireEvent.change(screen.getByPlaceholderText(/Search 2 branches/), { target: { value: 'search' } })
    fireEvent.click(screen.getByRole('button', { name: /origin\/feature\/search/ }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ok'))
    unmount()
    render(<NewWorktreeDialog project={project} inUse={[]} onClose={onClose} onCreated={onCreated} />)
    fireEvent.change(screen.getByPlaceholderText(/named after|from the branch/), { target: { value: 'warn' } })
    fireEvent.change(screen.getByPlaceholderText('orch/my-work'), { target: { value: 'orch/w' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(screen.getByText('stash kept')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/named after|from the branch/), { target: { value: 'boom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(screen.getByText('git said no')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog'))
    cleanup()
    vi.useFakeTimers()
    render(<SettingsDialog onClose={onClose} />)
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    await act(async () => {})
    const root = screen.getByPlaceholderText(/orchestrator\/worktrees/)
    fireEvent.change(root, { target: { value: '~/custom' } }); fireEvent.change(root, { target: { value: '' } })
    const numbers = screen.getAllByRole('spinbutton')
    fireEvent.change(numbers[0], { target: { value: '3' } }); fireEvent.change(numbers[3], { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Linear workspace'), { target: { value: ' acme-co ' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(impl.saveSettings).toHaveBeenCalledTimes(1)
    expect(impl.saveSettings.mock.calls[0][0]).toMatchObject({ linearWorkspace: 'acme-co' })
    fireEvent.change(screen.getByLabelText('Linear workspace'), { target: { value: '' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(impl.saveSettings.mock.calls[1][0]).toMatchObject({ linearWorkspace: null })
    fireEvent.click(screen.getByRole('button', { name: 'Done' })); expect(onClose).toHaveBeenCalled()
  })
})
