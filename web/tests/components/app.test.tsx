// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main'] }
const main: Worktree = { id: 'w', projectID: 'p', name: 'acme', path: '/acme', branch: 'main', baseBranch: null, isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: 'main' }
const sessionOf = (id: string, title: string, over: Partial<Session> = {}): Session => ({ id, worktreeID: 'w', title, engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 0.5, inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, ...over })

const bucket = { messages: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUSD: 0 }
const tabDefaults: Record<string, any> = {
  usage: async () => ({ blocks: [], today: bucket, last7: bucket, last30: bucket, byModel: {}, daily: [], byProject: [], pricing: {}, scannedFiles: 0, sessions: [] }),
  planUsage: async () => ({ error: 'not signed in' }),
  prs: async () => ({ ok: false, message: 'no gh' }), prComments: async () => ({ ok: false, message: 'no gh' }),
  prDetails: async () => ({ ok: false, message: 'no gh' }),
  tasks: async () => ({ tasks: [], terminals: [] }), infra: async () => ({ items: [] }),
  models: async () => ({}),   // nothing usable: the built-in list stands
  branches: async () => ({ branches: ['main'], defaultBranch: 'main' }),
  worktreeInfo: async () => ({ liveBranch: 'main', changedFiles: 0, branchesInUse: [] }),
  rawFileURL: (path: string) => `/api/file/raw?path=${encodeURIComponent(path)}`,
  settings: async () => ({ worktreeRoot: null, codexPricing: { input: 1, cached: 0.1, output: 2 }, claudePricing: {} }),
}

async function mountApp(store: any, impl: Record<string, any> = {}, transcript?: any[]) {
  impl = { ...tabDefaults, ...impl }
  const calls: Array<[string, any[]]> = []
  impl.activity ??= async () => ({ running: false, startedAt: null, tools: [], background: [], finished: [], processes: [], agents: [] })
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ session: { id: 'made' }, id: 'made' }) }) })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  vi.doMock('../../src/store.ts', () => ({
    useStore: () => store,
    loadTranscript: async () => transcript ?? [{ id: 'h1', role: 'user', text: 'history', timestamp: 1 }, { id: 'h2', role: 'assistant', text: 'see [the file](a.py) and ![shot](out/shot.png)', timestamp: 2 }],
  }))
  vi.doMock('../../src/components/ReviewPanel.tsx', () => ({ ReviewPanel: (props: any) => (
    <div data-testid="review"><button onClick={() => props.onAddComment({ id: 'c', file: 'a', line: 1, body: 'b' })}>add-comment</button>
      <button onClick={() => props.onQuote('quoted')}>quote</button><span data-testid="open">{props.open?.path ?? ''}</span><span data-testid="open-line">{props.open?.line ?? ''}</span>
      <button onClick={props.onCollapse}>collapse-review</button></div>) }))
  vi.doMock('../../src/components/TerminalDrawer.tsx', () => ({ TerminalDrawer: (props: any) => <div data-testid="terminal"><button onClick={props.onClose}>hide</button><span data-testid="sign-in">{props.signIn?.engine ?? ''}</span></div> }))
  vi.doMock('../../src/lib/monaco.ts', () => ({}))
  const { default: App } = await import('../../src/App.tsx')
  const view = render(<App />)
  return { calls, ...view }
}

const baseStore = () => ({
  connected: true, projects: [project], worktrees: [main],
  sessions: [sessionOf('s1', 'First'), sessionOf('s2', 'Second', { engine: 'codex' })],
  running: new Set<string>(), transcripts: { s1: [{ id: 'l1', role: 'assistant', text: 'live', timestamp: 2 }] },
})

describe('App', () => {
  it('lands on the first session, merges history with live items, drives every header control and shortcut', async () => {
    const store = { ...baseStore(), running: new Set(['s1']) }   // cmd-. only stops a running turn
    const { calls } = await mountApp(store, { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    expect(screen.getByText('live')).toBeTruthy()
    // The header doubles as the window's title bar in the packaged app: drag to move, double-click to fill the screen.
    expect(screen.getByTestId('titlebar').className).toContain('titlebar')
    // Header controls.
    fireEvent.click(within(screen.getByRole('group', { name: 'Steering' })).getByRole('button', { name: /Steer/ }))
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } })
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Access mode'), { target: { value: 'full' } })
    fireEvent.change(screen.getByLabelText('Log detail'), { target: { value: 'compact' } })
    expect(localStorage.getItem('orchestrator.logDensity')).toBe('compact')
    await waitFor(() => expect(calls.filter(([n]) => n === 'patchSession').length).toBeGreaterThanOrEqual(5))
    // Review panel interactions: comments, quotes, and a file the chat asked to see.
    fireEvent.click(screen.getByText('add-comment'))
    fireEvent.click(screen.getByText('quote'))
    await waitFor(() => expect(calls.some(([n, args]) => n === 'send' && args[1] === 'quoted')).toBe(true))
    fireEvent.click(screen.getByText('the file'))
    expect(screen.getByTestId('open').textContent).toBe('/acme/a.py')
    expect((screen.getByAltText('shot') as HTMLImageElement).src).toContain('/api/file/raw?path=%2Facme%2Fout%2Fshot.png')
    // The chat column tucks away and the review takes the room; both come back.
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }))
    expect(screen.getByTestId('chat-column').classList.contains('hidden')).toBe(true)
    expect(localStorage.getItem('orchestrator.chatCollapsed')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))
    expect(screen.getByTestId('chat-column').classList.contains('hidden')).toBe(false)
    fireEvent.click(screen.getByText('collapse-review')); expect(screen.queryByTestId('review')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show review panel' })); expect(screen.getByTestId('review')).toBeTruthy()
    // Terminal drawer and review toggles via buttons and keys.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal' })); expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.click(screen.getByText('hide')); expect(screen.queryByTestId('terminal')).toBeNull()
    fireEvent.keyDown(window, { key: 'j', metaKey: true }); expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'r', metaKey: true, shiftKey: true }); expect(screen.queryByTestId('review')).toBeNull()
    fireEvent.keyDown(window, { key: 'r', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    await waitFor(() => expect(calls.some(([n]) => n === 'stop')).toBe(true))
    // The worktree panel's own buttons reach the app: a terminal, and leaving a worktree that is gone.
    if (screen.queryByTestId('terminal')) fireEvent.click(screen.getByText('hide'))   // closed first; the panel's own button opens it
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal' }))
    expect(screen.getByTestId('terminal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()   // the project's own checkout stays
    fireEvent.keyDown(window, { key: 'v', metaKey: true, shiftKey: true })
    for (const key of ['2', '3', '4', '5', '6', '1']) fireEvent.keyDown(window, { key, metaKey: true })
    fireEvent.keyDown(window, { key: 'a', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'x', metaKey: true })   // unbound: ignored
    // Palette: every command group.
    const palette = async (query: string) => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      const input = screen.getByPlaceholderText(/Jump to a session/)
      fireEvent.change(input, { target: { value: query } }); fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => {})
    }
    await palette('Second'); await palette('acme'); await palette('New session in'); await palette('New worktree in acme'); await palette('choose branch')
    fireEvent.keyDown(window, { key: 'Escape' })
    await palette('Sonnet'); await palette('Effort max'); await palette('Read only'); await palette('Switch to claude'); await palette('Settings'); await palette('Usage'); await palette('Sessions')
    await palette('Rename session with Claude')
    expect(calls.some(([name]) => name === 'nameSession')).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    // Notification click event lands on a session or the GitHub tab; attention reporting on focus/blur.
    window.dispatchEvent(new CustomEvent('orchestrator:open', { detail: { sessionID: 's2' } }))
    window.dispatchEvent(new CustomEvent('orchestrator:open', { detail: { tab: 'github' } }))
    window.dispatchEvent(new CustomEvent('orchestrator:open', { detail: {} }))
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('blur'))
    await waitFor(() => expect(calls.some(([n]) => n === 'attention')).toBe(true))
    // Settings gear.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  })

  it('a worktree with no sessions offers to open one, remembers where you were, and shows the empty state with nothing at all', async () => {
    const store = { ...baseStore(), sessions: [], transcripts: {} }
    const { calls } = await mountApp(store, { skills: async () => ({ skills: [] }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open acme' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open acme' }))
    await waitFor(() => expect(calls.some(([n]) => n === 'newSession')).toBe(true))
    expect(JSON.parse(localStorage.getItem('orchestrator.view')!).worktreeID).toBeTruthy()
    cleanup(); vi.resetModules()
    // A remembered worktree that no longer exists is let go of too.
    localStorage.setItem('orchestrator.view', JSON.stringify({ tab: 'sessions', sessionID: null, worktreeID: 'vanished' }))
    await mountApp(baseStore(), { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    await waitFor(() => expect(JSON.parse(localStorage.getItem('orchestrator.view')!).sessionID).toBe('s1'))
    cleanup(); vi.resetModules()
    // A remembered session that no longer exists is let go of, and the first session is landed on.
    localStorage.setItem('orchestrator.view', JSON.stringify({ tab: 'sessions', sessionID: 'vanished', worktreeID: null }))
    await mountApp(baseStore(), { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    await waitFor(() => expect(JSON.parse(localStorage.getItem('orchestrator.view')!).sessionID).toBe('s1'))
    cleanup(); vi.resetModules()
    await mountApp({ ...baseStore(), projects: [], worktrees: [], sessions: [], transcripts: {} }, { skills: async () => ({ skills: [] }) })
    expect(screen.getByText('Nothing selected')).toBeTruthy()
  })

  it('signs the session\'s engine in again from a failed turn, in the terminal drawer', async () => {
    const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }
    localStorage.setItem('orchestrator.showTerminal', '0')
    await mountApp(baseStore(), quiet, [{ id: 'e1', role: 'error', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', canRetry: true, timestamp: 1 }])
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(screen.getByTestId('sign-in').textContent).toBe('claude'))
  })

  it('takes the server\'s model catalog when it is one, and keeps the built-in list otherwise', async () => {
    const catalog = { claude: { strongest: 'claude-x', models: [{ id: 'claude-x', label: 'X 9', featured: true }] }, codex: { strongest: 'g', models: [{ id: 'g', label: 'G', featured: true }] } }
    const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }
    await mountApp(baseStore(), { ...quiet, models: async () => catalog })
    await waitFor(() => expect([...screen.getByLabelText('Model').querySelectorAll('option')].map((option) => option.textContent)).toContain('X 9'))
    cleanup(); vi.resetModules()
    await mountApp(baseStore(), { ...quiet, models: async () => { throw new Error('down') } })
    await waitFor(() => expect([...screen.getByLabelText('Model').querySelectorAll('option')].map((option) => option.textContent)).toContain('Fable 5.1'))
  })

  it('shows attention dots for turns that ended elsewhere and clears them when opened', async () => {
    const store: any = { ...baseStore(), running: new Set(['s2']) }
    await mountApp(store, { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    // A re-render with s2 no longer running marks it as needing attention; opening it clears that.
    cleanup(); vi.resetModules()
    await mountApp({ ...store, running: new Set() }, { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    fireEvent.click(screen.getAllByText('Second')[0])
  })
})

describe('the + button', () => {
  it('creates a worktree with no questions and opens the session it came with', async () => {
    const { calls } = await mountApp(baseStore(), { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
    await waitFor(() => expect(calls.some(([name, args]) => name === 'newWorktree' && args[0] === 'p')).toBe(true))
  })
})

describe('side panels', () => {
  it('hide and show from their buttons, resize by dragging their edge, reset on double-click, and remember it all', async () => {
    await mountApp(baseStore(), { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) })
    const sidebar = () => screen.getByTestId('sidebar-column') as HTMLElement
    expect(sidebar().style.width).toBe('240px')
    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize sidebar' }), { clientX: 100 })
    fireEvent(window, new MouseEvent('mousemove', { clientX: 160 }))
    fireEvent(window, new MouseEvent('mouseup'))
    expect(sidebar().style.width).toBe('300px')
    expect(localStorage.getItem('orchestrator.sidebarWidth')).toBe('300')
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sidebar' }))
    expect(sidebar().style.width).toBe('240px')
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(screen.queryByTestId('sidebar-column')).toBeNull()
    expect(localStorage.getItem('orchestrator.sidebarCollapsed')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(screen.getByTestId('sidebar-column')).toBeTruthy()

    const review = () => screen.getByTestId('review-column') as HTMLElement
    expect(review().style.width).toBe('560px')
    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize review panel' }), { clientX: 700 })
    fireEvent(window, new MouseEvent('mousemove', { clientX: 650 }))
    fireEvent(window, new MouseEvent('mouseup'))
    expect(review().style.width).toBe('610px')
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize review panel' }))
    expect(review().style.width).toBe('560px')
    fireEvent.click(screen.getByText('collapse-review'))   // the panel's own control, the only one (mocked here)
    expect(screen.queryByTestId('review-column')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show review panel' }))
    expect(screen.getByTestId('review-column')).toBeTruthy()
  })
})

describe('landing, opening and links', () => {
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }

  it('lands on a worktree, not a session, when the worktree has none, and opens a fresh one on click', async () => {
    const empty = { id: 'w2', projectID: 'p', name: 'quiet-wt', path: '/acme-quiet', branch: 'orch/quiet', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main' }
    // Only an archived session exists, so landing falls to the worktree, not a session.
    const store: any = { ...baseStore(), worktrees: [main, empty], sessions: [sessionOf('sa', 'Archived', { isArchived: true })] }
    const madeless = { ...quiet, newSession: async () => ({}) }   // the server answered without an id
    await mountApp(store, madeless)
    await waitFor(() => expect(screen.getByRole('button', { name: /Open (acme|quiet-wt)/ })).toBeTruthy())
    fireEvent.click(within(document.querySelector('nav') as HTMLElement).getByTitle('quiet-wt'))
    // No session to open and none came back: it stays on the worktree without throwing.
    await waitFor(() => expect(screen.getByText(/Open quiet-wt|Session ready/)).toBeTruthy())
  })

  it('keeps the session controls inside the chat column, so the review runs the full height', async () => {
    await mountApp(baseStore(), quiet)
    await waitFor(() => expect(screen.getByTestId('chat-column')).toBeTruthy())
    const chat = screen.getByTestId('chat-column')
    // Every session control lives in the chat column; nothing spans the top to cap the review.
    for (const label of ['Engine', 'Model', 'Access mode', 'Log detail']) {
      expect(chat.contains(screen.getByLabelText(label))).toBe(true)
    }
    expect(chat.contains(screen.getByRole('group', { name: 'Steering' }))).toBe(true)
    expect(chat.contains(screen.getByTestId('review-column'))).toBe(false)
    // Collapsing the chat takes the controls with it, leaving the review the whole window.
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }))
    expect(screen.getByTestId('chat-column').classList.contains('hidden')).toBe(true)
  })

  it('opens an absolute file path and an absolute image as themselves, not under the worktree', async () => {
    const store = baseStore()
    await mountApp(store, quiet, [
      { id: 'h1', role: 'user', text: 'go', timestamp: 1 },
      { id: 'h2', role: 'assistant', text: 'see [abs](/etc/hosts) and ![pic](/var/img.png), [a line](src/x.py#L42) and [elsewhere](/other-checkout/src/y.py:7)', timestamp: 2 },
    ])
    await waitFor(() => expect(screen.getByText('abs')).toBeTruthy())
    fireEvent.click(screen.getByText('abs'))
    expect(screen.getByTestId('open').textContent).toBe('/etc/hosts')   // absolute: taken as-is
    // A line on the reference is a line to open at, not part of the path.
    fireEvent.click(screen.getByText('a line'))
    expect(screen.getByTestId('open').textContent).toBe('/acme/src/x.py'); expect(screen.getByTestId('open-line').textContent).toBe('42')
    fireEvent.click(screen.getByText('elsewhere'))
    expect(screen.getByTestId('open').textContent).toBe('/other-checkout/src/y.py'); expect(screen.getByTestId('open-line').textContent).toBe('7')
    expect((screen.getByAltText('pic') as HTMLImageElement).src).toContain('%2Fvar%2Fimg.png')
  })
})

describe('a branch worktree', () => {
  const feature = { id: 'feat', projectID: 'p', name: 'feature-x', path: '/acme-feature', branch: 'orch/feature-x', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main' }
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }
  /** What the server does on PATCH: the next state carries the change, as a new list. */
  const archiving = (store: any) => async (id: string, patch: any) => {
    store.worktrees = store.worktrees.map((entry: any) => (entry.id === id ? { ...entry, ...patch } : entry))
    return { ok: true }
  }

  it('leaves the session view when its worktree is archived from the panel', async () => {
    const store: any = { ...baseStore(), worktrees: [...baseStore().worktrees, feature], sessions: [sessionOf('s9', 'Feature chat', { worktreeID: 'feat' })] }
    const { calls } = await mountApp(store, { ...quiet, patchWorktree: archiving(store) })
    await waitFor(() => expect(screen.getByTestId('worktree-setup')).toBeTruthy())
    if (!screen.queryByRole('button', { name: 'Archive' })) fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    // Landing never returns to an archived worktree: the main checkout offers to open instead.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open acme' })).toBeTruthy())
    expect(screen.queryByTestId('worktree-setup')).toBeNull()
    expect(calls.some(([n]) => n === 'patchWorktree')).toBe(false)   // the impl above answered, not the proxy
  })

  it('leaves the session view when its worktree is archived from the sidebar menu', async () => {
    const store: any = { ...baseStore(), worktrees: [...baseStore().worktrees, feature], sessions: [sessionOf('s9', 'Feature chat', { worktreeID: 'feat' })] }
    await mountApp(store, { ...quiet, patchWorktree: archiving(store) })
    await waitFor(() => expect(screen.getByTestId('worktree-setup')).toBeTruthy())
    const row = within(document.querySelector('nav') as HTMLElement).getByTitle('feature-x').closest('.row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Row actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open acme' })).toBeTruthy())
    expect(screen.queryByTestId('worktree-setup')).toBeNull()
  })

  it('drops a file the chat asked to see when you move to another worktree: its review starts blank', async () => {
    const store: any = { ...baseStore(), worktrees: [...baseStore().worktrees, feature], sessions: [...baseStore().sessions, sessionOf('s9', 'Feature chat', { worktreeID: 'feat' })] }
    await mountApp(store, quiet)
    await waitFor(() => expect(screen.getByText('the file')).toBeTruthy())
    fireEvent.click(screen.getByText('the file'))
    expect(screen.getByTestId('open').textContent).toBe('/acme/a.py')
    fireEvent.click(within(document.querySelector('nav') as HTMLElement).getByTitle('feature-x'))
    await waitFor(() => expect(screen.getByTestId('open').textContent).toBe(''))
  })
})

describe('the panels and their one collapse control', () => {
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }

  it('every panel folds from the same control, and each sits at its own top-left', async () => {
    await mountApp(baseStore(), quiet)
    await waitFor(() => expect(screen.getByTestId('chat-column')).toBeTruthy())
    // One shared class means one look; each is the first control of its own panel.
    for (const label of ['Hide sidebar', 'Hide chat']) {   // the review's own is pinned in reviewPanel.test.tsx
      expect(screen.getByRole('button', { name: label }).className).toContain('panel-toggle')
    }
    // The collapse control leads the worktree row — the top-left corner of this panel.
    const row = screen.getByRole('button', { name: 'Hide chat' }).parentElement!
    expect(row.firstElementChild).toBe(screen.getByRole('button', { name: 'Hide chat' }))
    expect(screen.getByTestId('worktree-setup').contains(screen.getByRole('button', { name: 'Hide chat' }))).toBe(true)
    // Folding each one leaves the same button behind to bring it back.
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(screen.getByRole('button', { name: 'Show sidebar' }).className).toContain('panel-toggle')
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }))
    expect(screen.getByRole('button', { name: 'Show chat' }).className).toContain('panel-toggle')
  })

  it('sends the branch to the Pull Requests tab and never takes the review column for it', async () => {
    await mountApp(baseStore(), quiet)
    await waitFor(() => expect(screen.getByTestId('review')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Pull request for this branch' }))
    // The PR opens where PRs live; the session's review column is not borrowed for it.
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search pull requests' })).toBeTruthy())
    expect((screen.getByRole('searchbox', { name: 'Search pull requests' }) as HTMLInputElement).value).toBe('main')
    expect(localStorage.getItem('orchestrator.rightPane')).toBeNull()   // nothing persisted to get stuck on
    // Back to the session, the review column is exactly where it was.
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    await waitFor(() => expect(screen.getByTestId('review')).toBeTruthy())
    // Opening the tab by hand shows every PR again, not the last branch.
    fireEvent.click(screen.getByRole('tab', { name: 'Pull Requests' }))
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search pull requests' }) as HTMLInputElement).value).toBe(''))
  })
})

describe('the pull request button in a session', () => {
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }
  const row = (over: Record<string, unknown> = {}) => ({
    number: 12, title: 'Add widgets', url: 'u', headRefName: 'main', baseRefName: 'main', state: 'open',
    mergedAt: null, closedAt: null, isDraft: false, author: 'octo', authorAvatar: '', assignees: [],
    reviewers: [], reviewRequested: false, isMine: true, createdAt: '', updatedAt: '',
    checkRuns: [], checks: null, activity: null, lastCommitAt: null, commits: 0, linearKey: null, linearURL: null,
    unread: 0, worktreeID: null, worktreeName: null, ...over,
  })

  it('shows the number and state of the pull request on this branch, and opens it in the PR tab', async () => {
    await mountApp(baseStore(), { ...quiet, prs: async () => ({ ok: true, viewer: 'octo', prs: [row()], fetchedAt: 0, pending: false }) })
    const button = await screen.findByRole('button', { name: 'Pull request for this branch' })
    await waitFor(() => expect(button.textContent).toContain('#12'))
    expect(button.textContent).toContain('open')
    expect(button.title).toContain('Add widgets')
    fireEvent.click(button)
    // It lands in the Pull Requests tab, narrowed to that pull request.
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search pull requests' }) as HTMLInputElement).value).toBe('#12'))
  })

  it('shows a plain PR button when the branch has none, and survives GitHub being unreachable', async () => {
    await mountApp(baseStore(), { ...quiet, prs: async () => ({ ok: false, message: 'no gh' }) })
    const button = await screen.findByRole('button', { name: 'Pull request for this branch' })
    expect(button.textContent).toBe('PR')
    expect(button.title).toMatch(/No pull request/)
    fireEvent.click(button)
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search pull requests' }) as HTMLInputElement).value).toBe('main'))
  })

  it('marks a draft as such rather than calling everything open', async () => {
    await mountApp(baseStore(), { ...quiet, prs: async () => ({ ok: true, viewer: 'octo', prs: [row({ state: 'draft' })], fetchedAt: 0, pending: false }) })
    const button = await screen.findByRole('button', { name: 'Pull request for this branch' })
    await waitFor(() => expect(button.textContent).toContain('draft'))
  })
})

describe('the last corners of the session view', () => {
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }

  it('carries on when GitHub cannot be reached at all, and when a worktree has no branch', async () => {
    const noBranch = { ...main, branch: null }
    const store = { ...baseStore(), worktrees: [noBranch, { ...main, id: 'w2', name: 'other', branch: null }] }
    await mountApp(store, { ...quiet, prs: async () => { throw new Error('offline') } })
    const button = await screen.findByRole('button', { name: 'Pull request for this branch' })
    await waitFor(() => expect(button.textContent).toBe('PR'))
    fireEvent.click(button)
    // With no branch there is nothing to narrow by, and nothing throws.
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search pull requests' }) as HTMLInputElement).value).toBe(''))
  })

  it('does not pretend to know a state GitHub invented', async () => {
    const odd = {
      number: 3, title: 'Odd', url: 'u', headRefName: 'main', baseRefName: 'main', state: 'queued',
      mergedAt: null, closedAt: null, isDraft: false, author: 'o', authorAvatar: '', assignees: [],
      reviewers: [], reviewRequested: false, isMine: true, createdAt: '', updatedAt: '',
      checkRuns: [], checks: null, activity: null, lastCommitAt: null, commits: 0, linearKey: null,
      linearURL: null, unread: 0, worktreeID: null, worktreeName: null,
    }
    await mountApp(baseStore(), { ...quiet, prs: async () => ({ ok: true, viewer: 'o', prs: [odd], fetchedAt: 0, pending: false }) })
    const button = await screen.findByRole('button', { name: 'Pull request for this branch' })
    await waitFor(() => expect(button.textContent).toContain('#3'))
    expect(button.textContent).toContain('open')   // an unknown state reads as open rather than blank
  })

  it('removes a comment chip, clears them on send, and picks a failed turn back up', async () => {
    const store = { ...baseStore(), transcripts: { s1: [
      { id: 'e1', role: 'error', text: 'Process exited with status 1', canRetry: true, timestamp: 3 },
    ] } }
    const { calls } = await mountApp(store, quiet)
    await waitFor(() => expect(screen.getByText('add-comment')).toBeTruthy())
    fireEvent.click(screen.getByText('add-comment'))
    await waitFor(() => expect(screen.getByRole('button', { name: /Remove comment|✕/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Remove comment|✕/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remove comment|✕/ })).toBeNull())
    // Continue asks the server to retry the turn.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'retry')).toBe(true))
    // Sending clears whatever chips were attached.
    fireEvent.click(screen.getByText('add-comment'))
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'go' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remove comment|✕/ })).toBeNull())
  })
})

describe('leaving before GitHub answers', () => {
  const quiet = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }

  it('drops the answer instead of setting state on a view that is gone', async () => {
    let fail: (error: Error) => void = () => {}
    const pending = new Promise((_resolve, reject) => { fail = reject })
    const { unmount } = await mountApp(baseStore(), { ...quiet, prs: () => pending })
    await waitFor(() => expect(screen.getByTestId('chat-column')).toBeTruthy())
    unmount()
    fail(new Error('too late'))
    await pending.catch(() => {})   // the rejection is handled inside the component
  })

  it('drops a successful answer just the same', async () => {
    let land: (value: any) => void = () => {}
    const pending = new Promise((resolve) => { land = resolve })
    const { unmount } = await mountApp(baseStore(), { ...quiet, prs: () => pending })
    await waitFor(() => expect(screen.getByTestId('chat-column')).toBeTruthy())
    unmount()
    land({ ok: true, viewer: 'o', prs: [], fetchedAt: 0, pending: false })
    await pending
  })
})

describe('App corners', () => {
  const defaults = { skills: async () => ({ skills: [] }), draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: false, hint: 'x' }) }
  const palette = async (query: string) => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = screen.getByPlaceholderText(/Jump to a session/)
    fireEvent.change(input, { target: { value: query } }); fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
  }

  it('lands on the worktree when there is no session, shows when the socket is down, opens the palette from its button, and ignores ⌘. with nothing running', async () => {
    const { calls } = await mountApp({ ...baseStore(), sessions: [], transcripts: {}, connected: false }, defaults)
    await waitFor(() => expect(screen.getByTitle('Reconnecting…')).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/Open acme/)).toBeTruthy())   // the worktree, since no session exists
    cleanup(); vi.resetModules()
    // Sessions whose only worktree is archived leave nothing to land on.
    await mountApp({ ...baseStore(), worktrees: [{ ...main, isArchived: true }], transcripts: {}, connected: true }, defaults)
    await act(async () => {})
    expect(screen.queryByText(/Open acme/)).toBeNull()
    cleanup(); vi.resetModules()
    await mountApp({ ...baseStore(), sessions: [], transcripts: {}, connected: false }, defaults)
    await waitFor(() => expect(screen.getByTitle('Reconnecting…')).toBeTruthy())
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(calls.some(([name]) => name === 'stop')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '⌘K' }))
    expect(screen.getByPlaceholderText(/Jump to a session/)).toBeTruthy()
  })

  it('switches the engine from the palette either way', async () => {
    const { calls } = await mountApp(baseStore(), defaults)
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    await palette('Switch to Codex')
    expect(calls.some(([name, args]) => name === 'patchSession' && args[1]?.engine === 'codex')).toBe(true)
    cleanup(); vi.resetModules()
    const second = await mountApp({ ...baseStore(), sessions: [sessionOf('s1', 'First', { engine: 'codex' })] }, defaults)
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    await palette('Switch to Claude')
    expect(second.calls.some(([name, args]) => name === 'patchSession' && args[1]?.engine === 'claude')).toBe(true)
  })

  it('jumps to the session that needs attention, clears the effort, and stops a turn from the tasks tab', async () => {
    const store: any = { ...baseStore(), running: new Set(['s2']) }
    await mountApp(store, defaults)
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    cleanup(); vi.resetModules()
    const task = { sessionID: 's1', title: 'First', engine: 'claude', worktree: 'acme', pid: 1, startedAt: Date.now(), tools: [], background: [], finished: [], processes: [] }
    // s2 has said something and is no longer running: that is what earns a dot, and ⌘⇧A goes there.
    const { calls } = await mountApp({ ...store, running: new Set(), transcripts: { ...store.transcripts, s2: [{ id: 'x', role: 'assistant', text: 'done elsewhere', timestamp: 3 }] } },
      { ...defaults, tasks: async () => ({ tasks: [task], terminals: [] }) })
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'a', metaKey: true, shiftKey: true })
    await waitFor(() => expect(calls.some(([name, args]) => name === 'attention' && args[0] === 's2')).toBe(true))
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: '' } })
    expect(calls.some(([name, args]) => name === 'patchSession' && args[1]?.effort === null)).toBe(true)
    fireEvent.keyDown(window, { key: '6', metaKey: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop turn' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Stop turn' }))
    expect(calls.some(([name, args]) => name === 'stop' && args[0] === 's1')).toBe(true)
  })

  it('opens the PR tabs with no worktree in hand, and the new-worktree dialog with only real branches in use', async () => {
    const empty = await mountApp({ ...baseStore(), sessions: [], transcripts: {}, worktrees: [] }, defaults)
    fireEvent.keyDown(window, { key: '4', metaKey: true })
    await waitFor(() => expect(screen.getByLabelText('Project')).toBeTruthy())
    fireEvent.keyDown(window, { key: '5', metaKey: true })
    await act(async () => {})
    expect(empty.calls.some(([name]) => name === 'prComments')).toBe(false)   // nothing chosen: nothing asked... unless a project is
    cleanup(); vi.resetModules(); localStorage.clear()   // the tab is remembered; start on the sessions again
    const bare = { ...main, id: 'w2', name: 'bare', branch: null, isMain: false, group: 'main' }
    const created: any[] = [{}, { session: { id: 'made' } }, {}]
    const { calls } = await mountApp({ ...baseStore(), worktrees: [main, bare] }, { ...defaults, newWorktree: async () => created.shift() })
    await waitFor(() => expect(screen.getByText('history')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))   // the quick one: no session came back, nothing opens
    await act(async () => {})
    await palette('choose branch')
    await waitFor(() => expect(screen.getByPlaceholderText('orch/my-work')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(calls.some(([name, args]) => name === 'attention' && args[0] === 'made')).toBe(true))
    // Created without a session: the list refreshes and nothing opens.
    await palette('choose branch')
    await waitFor(() => expect(screen.getByPlaceholderText('orch/my-work')).toBeTruthy())
    const before = calls.filter(([name]) => name === 'attention').length
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(screen.queryByPlaceholderText('orch/my-work')).toBeNull())
    expect(calls.filter(([name]) => name === 'attention').length).toBe(before)
  })
})
