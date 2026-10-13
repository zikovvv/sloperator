// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, Project, Session, TranscriptItem, Worktree } from '../../shared/types.ts'

const session: Session = {
  id: 's1', worktreeID: 'w', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'queue',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
}
let n = 0
const item = (role: TranscriptItem['role'], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id: `i${n++}`, role, text, timestamp: 1, ...extra })
const question = (id: string, status: PermissionRequest['status'] = 'pending'): TranscriptItem =>
  item('permission', 'Continue?', { permission: { id, toolName: 'AskUserQuestion', toolUseID: 't', status,
    input: { questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] } } })

beforeEach(() => {
  vi.resetModules(); Element.prototype.scrollIntoView = vi.fn()
  vi.doMock('../../src/lib/api.ts', () => ({ api: {
    activity: async () => ({ running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] }), draft: async () => ({ text: '' }), saveDraft: async () => ({}), voiceStatus: async () => ({ available: false }), answerPermission: vi.fn(async () => ({ ok: true })),
  } }))
  vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: () => ({ state: 'idle', hint: null, toggle: vi.fn(), stop: vi.fn() }) }))
  vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null, languageOf: () => null }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (items: TranscriptItem[], density: 'ubercompact' | 'compact' | 'normal' | 'verbose', running = false) => {
  const { Chat } = await import('../../src/components/Chat.tsx')
  return render(<Chat session={session} items={items} running={running} skills={[]} comments={[]} onRemoveComment={() => {}}
                      onClearComments={() => {}} onOpenFile={() => {}} density={density} onContinue={() => {}} />)
}

describe('a question in the chat', () => {
  it('shows the card wherever the log is, and a strip that brings you to it', async () => {
    const log = [item('user', 'ASK me'), item('tool', 'Continue?', { toolName: 'AskUserQuestion' }), question('q1')]
    for (const density of ['normal', 'verbose', 'compact', 'ubercompact'] as const) {
      await mount(log, density, true)
      expect(screen.getByTestId('permission-card')).toBeTruthy()
      const strip = screen.getByTestId('waiting-strip')
      expect(strip.textContent).toContain('Claude is waiting for your answer')
      fireEvent.click(within(strip).getByRole('button', { name: 'Show' }))
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
      cleanup()
    }
    await mount([item('user', 'ASK me twice'), question('q1'), question('q2')], 'normal', true)
    expect(screen.getByTestId('waiting-strip').textContent).toContain('Claude is waiting for 2 answers')
    cleanup()
    // Answered, the strip goes and the card stays as a record.
    await mount([item('user', 'ASK me'), question('q1', 'allowed')], 'normal')
    expect(screen.queryByTestId('waiting-strip')).toBeNull()
    expect(screen.getByTestId('permission-card')).toBeTruthy()
  })

  it('shows a request whose details are gone as a plain note rather than nothing at all', async () => {
    const bare = item('permission', 'AskUserQuestion needs your answer')
    for (const density of ['normal', 'compact'] as const) {
      await mount([item('user', 'ASK me'), bare], density)
      expect(screen.getByText('AskUserQuestion needs your answer')).toBeTruthy()
      expect(screen.queryByTestId('permission-card')).toBeNull()
      cleanup()
    }
  })

  it('keeps an ubercompact turn open while its question is unanswered, and folds it once it is', async () => {
    const turn = (status: PermissionRequest['status']) => [
      item('user', 'ASK me'), item('assistant', 'Checking.'), item('tool', 'ls', { toolName: 'Bash', toolOutput: 'x' }),
      question('q1', status), item('assistant', 'HOST-SAID answered'),
    ]
    await mount(turn('pending'), 'ubercompact')
    expect(screen.queryByTestId('turn-fold')).toBeNull()
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy()
    cleanup()
    await mount(turn('allowed'), 'ubercompact')
    expect(screen.getByTestId('turn-fold')).toBeTruthy()
    expect(screen.queryByTestId('permission-card')).toBeNull()
    fireEvent.click(screen.getByTestId('turn-fold'))
    expect(screen.getByTestId('permission-card')).toBeTruthy()
  })
})

describe('a tool row that knows its input', () => {
  it('leads with what the tool was told, and opens to the command itself', async () => {
    await mount([
      item('tool', 'python3 -c "print(1)"', { toolName: 'Bash', toolInput: { command: 'python3 -c "print(1)"', description: 'Probe' }, toolOutput: '1' }),
      item('tool', 'src/app.py', { toolName: 'Read', toolInput: { file_path: 'src/app.py' } }),
      item('tool', 'grep it', { toolName: 'Grep', toolInput: { pattern: 'TODO' } }),
      item('tool', 'ls -la', { toolName: 'Bash', toolOutput: 'total 0' }),   // an older row without input still opens to its text
      item('tool', 'whoami', { toolInput: { command: 'whoami' } }),           // input but no name: still a tool
    ], 'normal')
    const rows = screen.getAllByRole('button', { expanded: false })
    expect(rows[0].textContent).toContain('Probe')
    expect(rows[0].textContent).not.toContain('print(1)')
    fireEvent.click(rows[0])
    expect(screen.getByText('python3 -c "print(1)"')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'src/app.py' })).toBeTruthy()
    expect(rows[2].textContent).toContain('TODO')
    fireEvent.click(rows[2]); expect(screen.queryByText('grep it')).toBeNull()   // no body: the headline stays
    fireEvent.click(rows[3]); expect(screen.getAllByText('ls -la').length).toBeGreaterThan(0)
    expect(rows[4].textContent).toContain('tool'); expect(rows[4].textContent).toContain('whoami')
  })
})

describe('a live step', () => {
  it('names what the running tool was asked, not its raw input', async () => {
    const { stepSummary } = await import('../../src/components/Chat.tsx')
    const live = (work: TranscriptItem) => stepSummary({ lead: null, work: [work] }, true)
    expect(live(item('tool', '{"questions":[{"question":"Continue?"}]}', { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Continue?' }] } }))).toBe('AskUserQuestion Continue?')
    expect(live(item('tool', 'python3 -c "print(1)"', { toolName: 'Bash', toolInput: { command: 'python3 -c "print(1)"', description: 'Probe' } }))).toBe('Bash Probe')
    expect(live(item('tool', 'python3 -c "print(1)"', { toolName: 'Bash', toolInput: { command: 'python3 -c "print(1)"' } }))).toBe('Bash python3 …')
    expect(live(item('tool', 'ls -la', { toolName: 'Bash' }))).toBe('Bash ls …')
  })
})

describe('the sidebar while a session waits', () => {
  it('marks the session and its folded worktree as asking, ahead of working', async () => {
    vi.doMock('../../src/lib/api.ts', () => ({ api: {} }))
    const { Sidebar } = await import('../../src/components/Sidebar.tsx')
    const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }
    const worktrees: Worktree[] = [
      { id: 'w', projectID: 'p', name: 'acme', path: '/acme', branch: 'main', baseBranch: null, isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: null },
    ]
    const sessions: Session[] = [session, { ...session, id: 's2', title: 'Other' }]
    const { rerender } = render(<Sidebar projects={[project]} worktrees={worktrees} sessions={sessions} running={new Set(['s1', 's2'])} attention={new Set()} asking={new Set(['s1'])}
      onQuickWorktree={vi.fn()} onNewWorktree={vi.fn()} selectedSession="s1" selectedWorktree={null} onSelectSession={vi.fn()} onSelectWorktree={vi.fn()} onChanged={vi.fn()} />)
    // Two sessions: the worktree opens, and both it and the session that asks carry the mark.
    expect(screen.getAllByTitle('Waiting for your answer')).toHaveLength(2)
    expect(screen.getAllByTitle('Working')).toHaveLength(2)                   // the project's running count, and the session that only works
    // Folded, the row alone carries the most pressing status of what is inside.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse worktree' }))
    expect(screen.getAllByTitle('Waiting for your answer')).toHaveLength(1)
    expect(screen.getAllByTitle('Working')).toHaveLength(1)                   // only the project's count is left
    rerender(<Sidebar projects={[project]} worktrees={worktrees} sessions={sessions} running={new Set(['s1'])} attention={new Set()}
      onQuickWorktree={vi.fn()} onNewWorktree={vi.fn()} selectedSession="s1" selectedWorktree={null} onSelectSession={vi.fn()} onSelectWorktree={vi.fn()} onChanged={vi.fn()} />)
    expect(screen.queryByTitle('Waiting for your answer')).toBeNull()
  })
})

describe('the store', () => {
  it('tracks which sessions ask, and settles a card in place when the answer lands', async () => {
    const sockets: any[] = []
    class FakeSocket { readyState = 1; onopen: any; onclose: any; onmessage: any; constructor(public url: string) { sockets.push(this) } send() {} close() {} }
    vi.stubGlobal('WebSocket', FakeSocket)
    const { act, renderHook } = await import('@testing-library/react')
    const { useStore } = await import('../../src/store.ts')
    const { result } = renderHook(() => useStore())
    const send = (event: any) => act(() => { sockets[0].onmessage({ data: JSON.stringify(event) }) })
    send({ type: 'transcript', sessionID: 's', items: [question('q1'), item('user', 'and another item, left alone')] })
    send({ type: 'running', sessionIDs: ['s'], asking: ['s'] })
    expect(result.current.asking.has('s')).toBe(true)
    send({ type: 'permission', sessionID: 's', itemID: result.current.transcripts.s[0].id, permission: { ...result.current.transcripts.s[0].permission, status: 'allowed', answers: { 'Continue?': 'Yes' } } })
    expect(result.current.transcripts.s[0].permission?.status).toBe('allowed')
    expect(result.current.transcripts.s[1].text).toBe('and another item, left alone')
    send({ type: 'permission', sessionID: 'nowhere', itemID: 'x', permission: { id: 'x', toolName: 'Bash', input: null, toolUseID: 't', status: 'denied' } })
    expect(result.current.transcripts.nowhere).toEqual([])
    send({ type: 'running', sessionIDs: [] })
    expect(result.current.asking.size).toBe(0)
    vi.unstubAllGlobals()
  })
})
