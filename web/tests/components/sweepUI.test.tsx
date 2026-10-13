// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, TranscriptItem, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const apiMock = (defaults: Record<string, any> = {}) => {
  const impl: Record<string, any> = { ...defaults }
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ ok: true, id: 'new' }) }) })
  return { api, impl, calls }
}
const idle = { running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] }
const session: Session = {
  id: 's1', worktreeID: 'w-main', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'queue',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
}
let n = 0
const item = (role: TranscriptItem['role'], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id: `i${n++}`, role, text, timestamp: 1, ...extra })
const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main', 'review'] }
const other: Project = { id: 'q', name: 'beta', path: '/beta', isGit: true, isExpanded: true, worktreeGroups: ['main'] }
const worktrees: Worktree[] = [
  { id: 'w-main', projectID: 'p', name: 'acme', path: '/acme', branch: 'main', baseBranch: null, isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: 'main' },
  { id: 'w-2', projectID: 'p', name: 'feature', path: '/wt/feature', branch: 'feature', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'review' },
  { id: 'w-3', projectID: 'q', name: 'beta', path: '/beta', branch: 'main', baseBranch: null, isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: 'main' },
  { id: 'w-4', projectID: 'q', name: 'side', path: '/wt/side', branch: 'side', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main' },
]

describe('Chat odds and ends', () => {
  const mountChat = async (items: TranscriptItem[], extra: Record<string, any> = {}, skills: any[] = [], voice: any = { state: 'idle', hint: null }) => {
    const { api, impl } = apiMock({ draft: async () => ({ text: '' }), saveDraft: vi.fn(async () => ({})), voiceStatus: async () => ({ available: false }), activity: async () => idle, ...extra })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: () => ({ ...voice, toggle: vi.fn(), stop: vi.fn() }) }))
    vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null, languageOf: () => null }))
    const { Chat, stepSummary } = await import('../../src/components/Chat.tsx')
    const view = render(<Chat session={session} items={items} running={false} skills={skills} comments={[]} onRemoveComment={() => {}}
                              onClearComments={() => {}} onOpenFile={() => {}} density="normal" onContinue={() => {}} />)
    return { ...view, impl, stepSummary }
  }
  const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement

  it('names a nameless tool in a live step', async () => {
    const { stepSummary } = await mountChat([])
    expect(stepSummary({ lead: null, work: [item('tool', 'x', { toolInput: { command: 'ls' } })] }, true)).toBe('tool ls')
  })

  it('saves the draft after a pause, and once more on the way out', async () => {
    const saveDraft = vi.fn(async () => ({}))
    const { unmount } = await mountChat([], { draft: async () => ({ text: 'kept' }), saveDraft })
    await waitFor(() => expect(box().value).toBe('kept'))
    fireEvent.change(box(), { target: { value: 'kept more' } })
    await waitFor(() => expect(saveDraft).toHaveBeenCalledWith('s1', 'kept more'), { timeout: 3000 })
    fireEvent.change(box(), { target: { value: 'last words' } })
    unmount()
    expect(saveDraft).toHaveBeenLastCalledWith('s1', 'last words')
  })

  it('stops following the tail once you scroll up, and follows again from the bottom', async () => {
    const { rerender } = await mountChat([item('user', 'a')])
    const { Chat } = await import('../../src/components/Chat.tsx')
    const log = document.querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 300, configurable: true })
    log.scrollTop = 0
    fireEvent.scroll(log)
    const before = (Element.prototype.scrollIntoView as any).mock.calls.length
    const more = <Chat session={session} items={[item('user', 'a'), item('assistant', 'b')]} running={false} skills={[]} comments={[]} onRemoveComment={() => {}}
                       onClearComments={() => {}} onOpenFile={() => {}} density="normal" onContinue={() => {}} />
    rerender(more)
    expect((Element.prototype.scrollIntoView as any).mock.calls.length).toBe(before)
    log.scrollTop = 700
    fireEvent.scroll(log)
    rerender(<Chat session={session} items={[item('user', 'a'), item('assistant', 'b'), item('assistant', 'c')]} running={false} skills={[]} comments={[]} onRemoveComment={() => {}}
                   onClearComments={() => {}} onOpenFile={() => {}} density="normal" onContinue={() => {}} />)
    expect((Element.prototype.scrollIntoView as any).mock.calls.length).toBeGreaterThan(before)
  })

  it('leaves the skill list alone on a stray key, and Escape drops the half-typed command', async () => {
    await mountChat([item('user', 'hi')], {}, [{ name: 'loop', description: 'again', kind: 'skill' }])
    fireEvent.change(box(), { target: { value: 'run /lo' } })
    expect(screen.getByRole('listbox', { name: 'Skills' })).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'a' })
    expect(box().value).toBe('run /lo')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box().value).toBe('run ')
  })

  it('primes the composer to use an agent from the quick starts, and says when voice has no better hint', async () => {
    await mountChat([], {}, [{ name: 'reviewer', description: 'reviews', kind: 'agent' }, { name: 'loop', description: 'again', kind: 'skill' }], { state: 'unavailable', hint: null })
    fireEvent.click(screen.getByRole('button', { name: 'reviewer' }))
    expect(box().value).toBe('Use the reviewer subagent: ')
    fireEvent.click(screen.getByRole('button', { name: '/loop' }))
    expect(box().value).toBe('/loop ')
    expect(screen.getByLabelText('Dictate').getAttribute('title')).toBe('Voice unavailable')
  })
})

describe('Sidebar drags, folds and menus', () => {
  const mountSidebar = async (impl: Record<string, any> = {}) => {
    const mock = apiMock(impl)
    vi.doMock('../../src/lib/api.ts', () => ({ api: mock.api }))
    const { Sidebar } = await import('../../src/components/Sidebar.tsx')
    const onSelectSession = vi.fn(); const onSelectWorktree = vi.fn(); const onChanged = vi.fn()
    render(<Sidebar projects={[project, other]} worktrees={worktrees} sessions={[session]} running={new Set()} attention={new Set()}
      onQuickWorktree={vi.fn()} onNewWorktree={vi.fn()} selectedSession={null} selectedWorktree={null}
      onSelectSession={onSelectSession} onSelectWorktree={onSelectWorktree} onChanged={onChanged} />)
    return { ...mock, onSelectSession, onSelectWorktree, onChanged }
  }
  const groupBox = (name: string) => screen.getByRole('button', { name: new RegExp(`${name}\\s*\\(`) }).closest('div')!.parentElement as HTMLElement

  it('ignores drags from nowhere or from another project, a folder dropped on itself, and a click on a handle', async () => {
    const { calls, onSelectWorktree } = await mountSidebar()
    const review = groupBox('review')
    fireEvent.dragOver(review); fireEvent.drop(review); fireEvent.dragLeave(review)
    // A worktree of the other project cannot land in this one.
    const handles = screen.getAllByTitle('Drag onto a folder to move this worktree there')
    fireEvent.dragStart(handles[handles.length - 1])
    fireEvent.dragOver(review); fireEvent.drop(review)
    expect(calls.some(([name]) => name === 'moveWorktree')).toBe(false)
    // A folder dropped where it already is changes nothing.
    const folderHandle = within(review).getByTitle('Drag to reorder folders')
    fireEvent.dragStart(folderHandle); fireEvent.dragOver(review); fireEvent.drop(review); fireEvent.dragEnd(folderHandle)
    expect(calls.some(([name]) => name === 'reorderGroups')).toBe(false)
    fireEvent.click(handles[0])
    expect(onSelectWorktree).not.toHaveBeenCalled()
  })

  it('folds a project both ways, and opens nothing when a new session comes back without an id', async () => {
    const newSession = vi.fn(async () => ({}))
    const { onChanged, onSelectSession } = await mountSidebar({ newSession })
    const toggle = screen.getAllByRole('button', { name: 'Toggle project' })[0]
    fireEvent.click(toggle)
    expect(screen.queryByTitle('Drag onto a folder to move this worktree there')).toBeTruthy()   // the other project is still open
    fireEvent.click(toggle)
    const rows = screen.getAllByRole('button', { name: 'Row actions' })
    fireEvent.click(rows[1])   // the first worktree of acme
    fireEvent.click(screen.getByRole('menuitem', { name: 'New session' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(newSession).toHaveBeenCalled()
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('renames a session from its menu', async () => {
    const patchSession = vi.fn(async () => ({}))
    const { onChanged } = await mountSidebar({ patchSession })
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand worktree' })[0])
    const row = screen.getByText('Chat').closest('[role="button"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Row actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(patchSession).toHaveBeenCalledWith('s1', { title: 'Renamed chat' }))
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('TerminalDrawer with a shell already open', () => {
  it('reuses it, relays keys and sizes only while the socket is open, and refits when its box changes', async () => {
    const { api, impl } = apiMock()
    impl.terminals = vi.fn(async () => ({ terminals: [{ id: 't1', worktreeID: 'w', title: 'Terminal 1', pid: 1 }] }))
    impl.openTerminal = vi.fn()
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const sockets: any[] = []
    class FakeSocket { static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any; sent: string[] = []; constructor(public url: string) { sockets.push(this); setTimeout(() => this.onopen?.(), 0) } send(data: string) { this.sent.push(data) } close() {} }
    vi.stubGlobal('WebSocket', FakeSocket)
    const instances: any[] = []
    const fit = vi.fn()
    vi.doMock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; data: any; resize: any; constructor() { instances.push(this) } loadAddon() {} open() {} write = vi.fn(); onData(cb: any) { this.data = cb; return { dispose() {} } } onResize(cb: any) { this.resize = cb; return { dispose() {} } } dispose() {} } }))
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit = fit } }))
    vi.doMock('@xterm/xterm/css/xterm.css', () => ({}))
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callback() } observe() {} disconnect() {} })
    const { TerminalDrawer } = await import('../../src/components/TerminalDrawer.tsx')
    render(<TerminalDrawer worktreeID="w" worktreeName="main" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeTruthy())
    expect(impl.openTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: /Terminal 1/ }))
    await waitFor(() => expect(sockets.length).toBe(1))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(fit).toHaveBeenCalled()
    act(() => { instances[0].data('ls'); instances[0].resize({ cols: 100, rows: 30 }) })
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'input', data: 'ls' }))
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
    const sent = sockets[0].sent.length
    sockets[0].readyState = 3
    act(() => { instances[0].data('x'); instances[0].resize({ cols: 1, rows: 1 }) })
    expect(sockets[0].sent).toHaveLength(sent)
  })
})

describe('tabs, in their corners', () => {
  it('keeps the open file when the next category still has it, and says why a file will not load', async () => {
    const { api, impl } = apiMock()
    impl.infra = vi.fn(async () => ({ items: [
      { path: '/h/x.md', title: 'Shared', subtitle: '', group: 'Global', exists: true },
      { path: '/h/y.md', title: 'Other', subtitle: '', group: 'Global', exists: true },
    ] }))
    impl.infraFile = vi.fn(async (path: string) => {
      if (path === '/h/x.md') throw new Error('unreadable')
      return { text: path === '/h/y.md' ? 'see [abs](/etc/far.md)' : '# far away', modified: 1 }
    })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { InfraTab } = await import('../../src/components/Tabs.tsx')
    render(<InfraTab />)
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy())
    fireEvent.click(screen.getByText('Shared'))
    await waitFor(() => expect(screen.getByText('unreadable')).toBeTruthy())
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Categories' })).getByRole('button', { name: 'Skills' }))
    await waitFor(() => expect(impl.infra).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Shared').closest('button')?.className).toContain('row-active')
    // A link with an absolute path opens that path as it is.
    fireEvent.click(screen.getByText('Other'))
    await waitFor(() => expect(screen.getByText('abs')).toBeTruthy())
    fireEvent.click(screen.getByText('abs'))
    await waitFor(() => expect(impl.infraFile).toHaveBeenCalledWith('/etc/far.md'))
    // Unsaved edits stand between you and the next file until you discard them.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# far, changed' } })
    fireEvent.click(screen.getByText('Other'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('[abs](/etc/far.md)'))   // still in the editor
  })

  it('orders models, days and sessions by cost, in millions where it comes to that', async () => {
    const { api, impl } = apiMock()
    const cheap = { messages: 1, input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUSD: 1 }
    const pricey = { ...cheap, costUSD: 5 }
    impl.planUsage = vi.fn(async () => ({ error: 'x' }))
    impl.usage = vi.fn(async () => ({
      blocks: [{ ...cheap, start: Date.now() - 1000, end: Date.now() + 1000, isActive: true, byModel: { opus: cheap, fable: pricey } }],
      today: cheap, last7: cheap, last30: cheap, byModel: { opus: cheap, fable: pricey },
      daily: [{ ...cheap, date: '2026-09-02', byModel: { opus: cheap, fable: pricey } }], byProject: [], pricing: {}, scannedFiles: 1,
      sessions: [{ ...session, id: 'a', title: 'cheap one', totalCostUSD: 1 }, { ...session, id: 'b', title: 'pricey one', totalCostUSD: 5, inputTokens: 2_500_000 },
                 { ...session, id: 'c', title: 'free words', totalCostUSD: 0, outputTokens: 12 }, { ...session, id: 'd', title: 'silent', totalCostUSD: 0, outputTokens: 0 }],
    }))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { UsageTab } = await import('../../src/components/Tabs.tsx')
    render(<UsageTab />)
    await waitFor(() => expect(screen.getByText('pricey one')).toBeTruthy())
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '')
    expect(rows.findIndex((text) => text.includes('pricey one'))).toBeLessThan(rows.findIndex((text) => text.includes('cheap one')))
    expect(screen.getByText('2.5M')).toBeTruthy()
    expect(screen.getByText('free words')).toBeTruthy(); expect(screen.queryByText('silent')).toBeNull()
    expect(screen.getByText(/fable \$5 · opus \$1/)).toBeTruthy()
  })

  it('asks GitHub nothing without a project, switches projects, and counts a lone comment', async () => {
    const { api, impl } = apiMock()
    impl.prComments = vi.fn(async (id: string) => ({ ok: true, comments: id === 'q'
      ? [{ id: 'c1', prNumber: 9, prTitle: 'Solo', prBranch: 'b', author: 'a', body: 'one', url: 'u', createdAt: new Date().toISOString(), kind: 'discussion' }] : [] }))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { GitHubTab } = await import('../../src/components/Tabs.tsx')
    render(<GitHubTab projects={[]} defaultProjectID={null} onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await act(async () => {})
    expect(impl.prComments).not.toHaveBeenCalled()
    cleanup()
    render(<GitHubTab projects={[project, other]} defaultProjectID={null} onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(impl.prComments).toHaveBeenCalledWith('p'))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'q' } })
    await waitFor(() => expect(screen.getByText('1 comment')).toBeTruthy())
  })
})

describe('the pull-request list', () => {
  it('counts general notes, and dates a closed pull request only when GitHub says when', async () => {
    const { api, impl } = apiMock()
    const pr = {
      number: 7, title: 'Seven', url: 'https://example.com/7', headRefName: 'feature/one', baseRefName: 'main', state: 'closed', mergedAt: null, closedAt: null,
      checkRuns: [], participants: null, author: 'alice', authorAvatar: null, isMine: true, isDraft: false, checks: 'pass',
      assignees: [], reviewers: [], reviewRequested: false, createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lastCommitAt: null,
      commitCount: 1, additions: 1, deletions: 0, changedFiles: 1, unread: 0, linearKey: null, linearURL: null, totals: null, worktreeID: null,
      activity: { inlineComments: 0, discussionComments: 2, commits: 0, reviews: 0, reviewState: null, threadsOpen: 0, threadsResolved: 0, threadsForMe: 0 },
    }
    impl.prs = vi.fn(async () => ({ ok: true, viewer: 'octo', prs: [pr] }))
    impl.prDetails = vi.fn(async () => ({ ok: true, viewer: 'octo', prs: [pr] }))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    vi.doMock('../../src/lib/toast.ts', () => ({ toast: vi.fn(), reportError: vi.fn() }))
    const { PullRequestsTab } = await import('../../src/components/PullRequests.tsx')
    render(<PullRequestsTab projects={[project]} worktrees={[]} sessions={[]} defaultProjectID="p" onOpenSession={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(impl.prs).toHaveBeenCalled())
    const closed = await screen.findByRole('button', { name: /closed/i })
    if (closed.getAttribute('aria-pressed') !== 'true') fireEvent.click(closed)
    await waitFor(() => expect(screen.getByText('Seven')).toBeTruthy())
    expect(screen.getByText('2 notes')).toBeTruthy()
    expect(screen.getAllByTitle('Closed').some((element) => /^closed/.test(element.textContent ?? ''))).toBe(true)   // no date to add
  })
})

describe('language server providers before any editor is wired', () => {
  it('answers no highlights', async () => {
    vi.doMock('../../src/lib/api.ts', () => ({ api: {} }))
    const { ensureProviders } = await import('../../src/lib/lspProviders.ts')
    const providers: Record<string, any> = {}
    ensureProviders({ languages: {
      registerDefinitionProvider() {}, registerReferenceProvider() {}, registerHoverProvider() {},
      registerDocumentHighlightProvider: (_l: string, p: any) => { providers.highlights = p },
    } } as any, 'python')
    expect(await providers.highlights.provideDocumentHighlights({ uri: 'file:///w/a.py' }, { lineNumber: 1, column: 1 })).toEqual([])
  })
})
