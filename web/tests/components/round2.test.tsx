// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, TranscriptItem, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); localStorage.clear(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

const apiMock = (impl: Record<string, any> = {}) => {
  const calls: Array<[string, any[]]> = []
  impl.activity ??= async () => ({ running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] })
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ id: 'new', session: { id: 'new' } }) }) })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  return { calls, impl }
}
const session = (over: Partial<Session> = {}): Session => ({ id: 's1', worktreeID: 'w', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ...over })
const item = (role: TranscriptItem['role'], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id: Math.random().toString(36).slice(2), role, text, timestamp: Date.now(), ...extra })

describe('Chat: compact summaries, voice states, scrolling, hints, auto-grow', () => {
  it('summarises read/edit and long tool calls, single-item and failed groups, path detection, and voice states', async () => {
    apiMock({ draft: async () => ({ text: '' }), voiceStatus: async () => ({ available: true }) })
    let voiceState: any = { state: 'recording', hint: null, toggle: vi.fn(), stop: vi.fn() }
    vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: (onText: (t: string) => void) => { (globalThis as any).__onText = onText; return voiceState } }))
    const { Chat } = await import('../../src/components/Chat.tsx')
    const tools = [
      item('tool', 'src/deep/app.py', { toolName: 'Read' }), item('tool', 'x'.repeat(80), { toolName: 'Grep', toolOutput: '⚠️ nope' }),
    ]
    const base = { session: session(), items: tools, running: false, skills: [], comments: [], onRemoveComment: vi.fn(), onClearComments: vi.fn(), onOpenFile: vi.fn(), density: 'compact' as const }
    // Settled steps say what they did altogether; a step still running says what it is on right now.
    const { rerender } = render(<Chat onContinue={vi.fn()} {...base} />)
    expect(screen.getByText(/2 tool calls · Read, Grep/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...base} items={[tools[0]]} running />)
    expect(screen.getByText(/Read deep\/app\.py/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...base} items={[tools[1]]} running />)
    expect(screen.getByText(/x{60}…/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...base} items={[item('tool', 'ls -la', { toolName: 'shell' }), item('tool', 'whatever', { toolName: undefined })]} />)
    expect(screen.getByText(/2 tool calls · shell, tool/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...base} items={[item('tool', '', { toolName: 'Bash' })]} running />)
    expect(screen.getByText(/Bash command …/)).toBeTruthy()
    // A failed tool tints the fold; opening it shows the tools as rows, output behind each row.
    rerender(<Chat onContinue={vi.fn()} {...base} items={tools} />)
    expect(screen.getByTestId('step-fold').className).toContain('text-warn')
    fireEvent.click(screen.getByTestId('step-fold'))
    expect(screen.getByText('Grep')).toBeTruthy()
    fireEvent.click(screen.getByText('Grep'))
    expect(screen.getByText(/⚠️ nope/)).toBeTruthy()
    // Voice: recording style, transcribing glyph, dictated text appended to a draft.
    expect(screen.getByRole('button', { name: 'Dictate' }).className).toContain('bg-bad')
    voiceState = { state: 'transcribing', hint: null, toggle: vi.fn(), stop: vi.fn() }
    rerender(<Chat onContinue={vi.fn()} {...base} items={[]} />)
    expect(screen.getByRole('button', { name: 'Dictate' }).textContent).toBe('…')
    const box = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'start' } })
    act(() => { (globalThis as any).__onText('dictated') })
    expect(box.value).toBe('start dictated')
    fireEvent.change(box, { target: { value: '' } })
    act(() => { (globalThis as any).__onText('alone') })
    expect(box.value).toBe('alone')
    // Slash hint: hover and click apply; codex engine label on items; scroll pinning.
    rerender(<Chat onContinue={vi.fn()} {...base} items={[item('assistant', 'from codex', { engine: 'codex' }), item('error', 'bad', {})]} skills={[{ name: 'zeta', description: 'z', kind: 'skill' }, { name: 'alpha', description: 'a', kind: 'skill' }]} session={session({ engine: 'codex' })} running />)
    expect(screen.getByText(/Codex is working/)).toBeTruthy()
    fireEvent.change(box, { target: { value: '/a' } })
    fireEvent.mouseEnter(screen.getAllByRole('option')[0]); fireEvent.click(screen.getAllByRole('option')[0])
    expect(box.value).toMatch(/^\/alpha /)
    const list = screen.getByText('from codex').closest('div')!.parentElement!.parentElement!
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true }); Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true })
    fireEvent.scroll(list, { target: { scrollTop: 0 } })
    fireEvent.scroll(list, { target: { scrollTop: 900 } })
    fireEvent.input(box)
  })
})

describe('CommandPalette hover, ConfirmDialog keydown, TextPrompt Enter', async () => {
  it('covers the remaining handlers', async () => {
    const { CommandPalette } = await import('../../src/components/CommandPalette.tsx')
    const run = vi.fn()
    render(<CommandPalette commands={[{ id: 'a', group: 'G', label: 'Alpha', run }, { id: 'b', group: 'G', label: 'Beta', run }]} onClose={() => {}} />)
    fireEvent.mouseEnter(screen.getByText('Beta'))
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump/), { key: 'Enter' }); expect(run).toHaveBeenCalledTimes(1)
    cleanup()
    const { ConfirmDialog } = await import('../../src/components/ConfirmDialog.tsx')
    const onCancel = vi.fn()
    render(<ConfirmDialog title="t" onCancel={onCancel} onConfirm={() => {}} />)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Enter' }); fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    cleanup()
    const { TextPrompt } = await import('../../src/components/TextPrompt.tsx')
    const onSubmit = vi.fn()
    render(<TextPrompt title="t" label="l" onCancel={() => {}} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v' } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('v')
  })
})

describe('Markdown remaining branches', () => {
  it('wiki links already ending in .md, a pipe line that is not a table, a malformed link token, deep headings', async () => {
    const { Markdown, expandWikiLinks, parseBlocks } = await import('../../src/components/Markdown.tsx')
    expect(expandWikiLinks('[[notes.md]]')).toContain('(notes.md)')
    const blocks = parseBlocks('| not a table\nnext line\n### third level\n#### fourth')
    expect(blocks[0].kind).toBe('paragraph'); expect(blocks.filter((block) => block.kind === 'heading')).toHaveLength(2)
    render(<Markdown text="[broken](x" />)
    expect(screen.getByText(/broken/)).toBeTruthy()
  })
})

describe('NewWorktreeDialog remaining branches', () => {
  it('escape in the branch search, Enter with no match, project without groups, a created response without a session', async () => {
    const created: any[] = []
    apiMock({ branches: async () => ({ branches: ['main'] }), newWorktree: async (...args: any[]) => { created.push(args); return {} } })
    const { NewWorktreeDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
    const onCreated = vi.fn()
    const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }
    render(<NewWorktreeDialog project={project} inUse={[]} onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Current HEAD/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Current HEAD/ }))
    const search = screen.getByPlaceholderText(/Search 1 branches/)
    fireEvent.change(search, { target: { value: 'zzz' } }); fireEvent.keyDown(search, { key: 'Enter' }); fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.change(screen.getByPlaceholderText('orch/my-work'), { target: { value: 'orch/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create and open chat' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(null))
    expect(created[0][1].base).toBeUndefined()
  })
})

describe('Sidebar remaining branches', () => {
  it('menu overlay click closes, folder drop on itself, drag guards, worktree without a branch, created session without an id', async () => {
    apiMock({ newSession: async () => ({}) })
    const { Sidebar } = await import('../../src/components/Sidebar.tsx')
    const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }
    const worktree: Worktree = { id: 'w', projectID: 'p', name: 'acme', path: '/acme', branch: null, baseBranch: null, isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: null }
    render(<Sidebar projects={[project]} worktrees={[worktree]} sessions={[]} running={new Set()} attention={new Set()} onQuickWorktree={vi.fn()} onNewWorktree={() => {}} selectedSession={null} selectedWorktree={null} onSelectSession={() => {}} onSelectWorktree={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Row actions' })[0])
    fireEvent.click(document.querySelector('.fixed.inset-0')!)
    expect(screen.queryByRole('menu')).toBeNull()
    const folder = screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!.parentElement!.parentElement!
    fireEvent.dragOver(folder); fireEvent.drop(folder)   // nothing dragging: ignored
    const grip = screen.getByTitle('Drag to reorder folders')
    fireEvent.dragStart(grip); fireEvent.dragOver(folder); fireEvent.drop(folder)   // onto itself: ignored
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Row actions' })[1]); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete worktree…' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('The branch  is NOT deleted')
  })
})

describe('TerminalDrawer remaining branches', () => {
  it('drawer open failure on first mount', async () => {
    apiMock({ terminals: async () => ({ terminals: [] }), openTerminal: async () => { throw new Error('cannot open') } })
    vi.doMock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} } } onResize() { return { dispose() {} } } dispose() {} } }))
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
    vi.doMock('@xterm/xterm/css/xterm.css', () => ({}))
    vi.stubGlobal('ResizeObserver', class { constructor(cb: any) { cb() } observe() {} disconnect() {} })
    const { TerminalDrawer } = await import('../../src/components/TerminalDrawer.tsx')
    render(<TerminalDrawer worktreeID="w" worktreeName="main" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('cannot open')).toBeTruthy())
  })
})

describe('Tabs remaining branches', () => {
  it('infra: listing error, selected path vanishing, revert; usage: fmt scales; prs: catch; page: main worktree, branch fallback', async () => {
    let items: any[] = [{ path: '/a.md', title: 'A', subtitle: '', group: 'G', exists: true }]
    const { impl } = apiMock({ infra: async () => ({ items }), infraFile: async () => ({ text: 'body', modified: 1 }) })
    const { InfraTab, UsageTab } = await import('../../src/components/Tabs.tsx')
    const { unmount } = render(<InfraTab />)
    await waitFor(() => expect(screen.getByText('A')).toBeTruthy())
    fireEvent.click(screen.getByText('A'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    items = [{ path: '/b.md', title: 'B', subtitle: '', group: 'G', exists: true }]
    fireEvent.click(screen.getByRole('button', { name: 'Memories' }))
    await waitFor(() => expect(screen.getByText('B')).toBeTruthy())
    impl.infra = async () => { throw new Error('listing broke') }
    fireEvent.click(screen.getByRole('button', { name: 'Hooks' }))
    await waitFor(() => expect(screen.getByText('listing broke')).toBeTruthy())
    unmount()
    const big = { messages: 2_000_000_000, input: 5_000_000, cacheRead: 5_000, cacheWrite: 0, output: 12, costUSD: 1 }
    impl.planUsage = async () => ({ plan: 'Pro', limits: [], extra: null, fetchedAt: 1 })
    impl.usage = async () => ({ blocks: [], today: big, last7: big, last30: big, byModel: {}, daily: [], byProject: [], pricing: {}, scannedFiles: 0, sessions: [] })
    vi.useFakeTimers()
    render(<UsageTab />)
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    await act(async () => { vi.advanceTimersByTime(31_000) })
    vi.useRealTimers()
    await waitFor(() => expect(screen.getAllByText(/2\.00B messages/)[0]).toBeTruthy())
  })
})
