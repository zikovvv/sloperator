// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, TranscriptItem, Worktree, Project } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const apiMock = () => {
  const impl: Record<string, any> = {}
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ id: 'new', session: { id: 'new' } }) }) })
  return { api, impl, calls }
}
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', worktreeID: 'w1', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'steer',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0.5, inputTokens: 10, cachedInputTokens: 20, outputTokens: 30, ...over,
})
const item = (role: TranscriptItem['role'], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id: Math.random().toString(36).slice(2), role, text, timestamp: Date.now() - 4000, ...extra })

describe('Chat', () => {
  it('renders every item kind in every density, sends, autocompletes, attaches comments, dictates, stops', async () => {
    const { api, impl, calls } = apiMock()
    impl.draft = vi.fn(async () => ({ text: 'saved draft' }))
    impl.voiceStatus = vi.fn(async () => ({ available: false, hint: 'no whisper' }))
    impl.activity = vi.fn(async () => ({ running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] }))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { Chat } = await import('../../src/components/Chat.tsx')
    const items = [
      item('user', 'hello'), item('assistant', '# Reply\n\nwith **markdown** and `x`'),
      item('thinking', 'pondering'), item('tool', 'ls -la /tmp', { toolName: 'Bash', toolOutput: 'out' }),
      item('tool', 'src/app.py', { toolName: 'Read', toolOutput: 'file' }), item('tool', 'anything', { toolName: 'Task', toolOutput: '⚠️ failed' }),
      item('info', 'Queued'), item('error', 'boom', { engine: 'codex' }), item('assistant', 'old', { timestamp: Date.now() - 7_200_000 }),
      item('assistant', 'minutes', { timestamp: Date.now() - 120_000 }),
    ]
    const onOpenFile = vi.fn(); const onRemove = vi.fn(); const onClear = vi.fn()
    const skills = [{ name: 'code-review', description: 'review', kind: 'skill' }, { name: 'helper', description: 'agent', kind: 'agent' }]
    const props = { session: session(), items, running: false, skills, comments: [{ id: 'c1', file: 'a.ts', line: 3, snippet: 'x', body: 'wrong' }], onRemoveComment: onRemove, onClearComments: onClear, onOpenFile, density: 'normal' as const }
    const { rerender } = render(<Chat onContinue={vi.fn()} {...props} />)
    await waitFor(() => expect((screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement).value).toBe('saved draft'))
    expect(screen.getAllByText(/\d+h ago/).length).toBeGreaterThan(0); expect(screen.getAllByText(/\d+m ago/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('src/app.py')); expect(onOpenFile).toHaveBeenCalledWith('src/app.py')
    fireEvent.keyDown(screen.getByText('src/app.py'), { key: 'Enter' })
    fireEvent.click(screen.getByText('ls -la /tmp').closest('button')!); expect(screen.getByText('out')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment' })); expect(onRemove).toHaveBeenCalledWith('c1')
    rerender(<Chat onContinue={vi.fn()} {...props} density="compact" />)
    fireEvent.click(screen.getByText(/3 tool calls/))
    expect(screen.getByText(/ls -la/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...props} density="verbose" />)
    expect(screen.getByText('file')).toBeTruthy()
    // Composer: slash autocomplete with keyboard, quick start, send with comments, Shift+Enter.
    rerender(<Chat onContinue={vi.fn()} {...props} items={[]} comments={[]} />)
    const box = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '/cod' } })
    expect(screen.getByRole('listbox', { name: 'Skills' })).toBeTruthy()
    fireEvent.keyDown(box, { key: 'ArrowDown' }); fireEvent.keyDown(box, { key: 'ArrowUp' }); fireEvent.keyDown(box, { key: 'Tab' })
    expect(box.value).toBe('/code-review ')
    fireEvent.change(box, { target: { value: '/cod' } }); fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toContain('code-review')
    fireEvent.change(box, { target: { value: '/zzz' } }); fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /helper/ }))
    expect(box.value).toMatch(/subagent/)
    fireEvent.change(box, { target: { value: 'send me' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls.some(([name]) => name === 'send')).toBe(true))
    expect(onClear).toHaveBeenCalled()
    fireEvent.change(box, { target: { value: '   ' } }); fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Dictate' }).getAttribute('title')).toMatch(/no whisper/)
    rerender(<Chat onContinue={vi.fn()} {...props} items={[]} comments={[]} running />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'stop')).toBe(true))
    expect(screen.getByPlaceholderText(/Steer the running turn/)).toBeTruthy()
    rerender(<Chat onContinue={vi.fn()} {...props} items={[]} comments={[]} running session={session({ steeringMode: 'queue' })} />)
    expect(screen.getByPlaceholderText(/Queue/)).toBeTruthy()
    window.dispatchEvent(new CustomEvent('orchestrator:dictate'))
  })
})

