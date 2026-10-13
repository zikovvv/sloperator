// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, TranscriptItem } from '../../shared/types.ts'

const session: Session = {
  id: 's1', worktreeID: 'w', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'queue',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
}
let n = 0
const item = (role: TranscriptItem['role'], text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
  ({ id: `i${n++}`, role, text, timestamp: 1, ...extra })
const noSelection = { isCollapsed: true, anchorNode: null, toString: () => '' }
const select = (node: Node | null, text: string) => ({ isCollapsed: false, anchorNode: node, toString: () => text })

beforeEach(() => {
  vi.resetModules(); Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('getSelection', vi.fn(() => noSelection))
  vi.doMock('../../src/lib/api.ts', () => ({ api: { activity: async () => ({ running: false, startedAt: null, tools: [], background: [], finished: [], processes: [], agents: [] }), draft: async () => ({ text: '' }), saveDraft: async () => ({}), voiceStatus: async () => ({ available: false }) } }))
  vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: () => ({ state: 'idle', hint: null, toggle: vi.fn(), stop: vi.fn() }) }))
  vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null, languageOf: () => null }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const mount = async (items: TranscriptItem[], density: 'compact' | 'normal' = 'normal') => {
  const { Chat } = await import('../../src/components/Chat.tsx')
  return render(<Chat session={session} items={items} running={false} skills={[]} comments={[]} onRemoveComment={() => {}}
                      onClearComments={() => {}} onOpenFile={() => {}} density={density} onContinue={() => {}} />)
}
const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement
const quote = async () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Quote in next message' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

describe('right-click in the chat', () => {
  const log = () => [
    item('user', 'do it'), item('assistant', 'Sure thing.'), item('thinking', 'hmm'),
    item('tool', 'ls -la', { toolName: 'Bash', toolOutput: 'total 0' }), item('info', 'turn ended'),
  ]

  it('quotes the message under the pointer whole, naming who said it, and stacks quotes with room to type', async () => {
    await mount(log())
    fireEvent.contextMenu(screen.getByText('Sure thing.'), { clientX: 10, clientY: 20 })
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Claude said]\n> Sure thing.\n'))
    await waitFor(() => expect(box().selectionStart).toBe(box().value.length))   // the caret waits after the quote
    fireEvent.contextMenu(screen.getByText('do it'))
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Claude said]\n> Sure thing.\n\n> [you said earlier]\n> do it\n'))
    fireEvent.change(box(), { target: { value: box().value + 'because…' } })
    fireEvent.contextMenu(screen.getByText('hmm'))
    await quote()
    await waitFor(() => expect(box().value.endsWith("because…\n\n> [Claude's thinking]\n> hmm\n")).toBe(true))
  })

  it('knows a tool call from its output', async () => {
    await mount(log())
    fireEvent.contextMenu(screen.getByText('ls -la'))
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Bash call]\n> ls -la\n'))
    fireEvent.click(screen.getByRole('button', { expanded: false }))   // opens the row: the output is now on screen
    fireEvent.contextMenu(screen.getByText('total 0'))
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Bash call]\n> ls -la\n\n> [Bash output]\n> total 0\n'))
  })

  it('quotes just the selected words when there are some, and copies them on request', async () => {
    await mount(log(), 'compact')
    const node = screen.getByText('Sure thing.').firstChild
    vi.stubGlobal('getSelection', vi.fn(() => select(node, 'thing')))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.contextMenu(screen.getByText('Sure thing.'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('thing')
    fireEvent.contextMenu(screen.getByText('Sure thing.'))
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Claude said]\n> thing\n'))
    // A selection anchored on an element (a triple-click) rather than on text still knows its message.
    vi.stubGlobal('getSelection', vi.fn(() => select(screen.getByText('Sure thing.'), 'Sure thing.')))
    fireEvent.contextMenu(screen.getByText('Sure thing.'))
    await quote()
    await waitFor(() => expect(box().value.endsWith('> [Claude said]\n> Sure thing.\n')).toBe(true))
    // Selected text that is not inside any message still quotes, just without a name.
    vi.stubGlobal('getSelection', vi.fn(() => select(screen.getByText('turn ended').firstChild, 'turn ended')))
    fireEvent.contextMenu(screen.getByText('turn ended'))
    await quote()
    await waitFor(() => expect(box().value.endsWith('> [from this session]\n> turn ended\n')).toBe(true))
  })

  it('leaves the native menu alone where there is nothing to quote, and ignores selections made elsewhere', async () => {
    await mount(log())
    const ignored = fireEvent.contextMenu(screen.getByText('turn ended'))
    expect(ignored).toBe(true)   // not prevented
    expect(screen.queryByRole('menu')).toBeNull()
    vi.stubGlobal('getSelection', vi.fn(() => select(document.body, 'somewhere else')))
    fireEvent.contextMenu(screen.getByText('Sure thing.'))
    await quote()
    await waitFor(() => expect(box().value).toBe('> [Claude said]\n> Sure thing.\n'))   // the message, not the stray selection
    await mount([item('tool', '', { toolName: 'Read' })])   // nothing to say, nothing offered
    expect(fireEvent.contextMenu(screen.getByText('Read'))).toBe(true)
  })

  it('takes quotes from the review panel through the compose event', async () => {
    await mount([])
    fireEvent.change(box(), { target: { value: 'look: ' } })
    window.dispatchEvent(new CustomEvent('orchestrator:compose', { detail: { text: '> [src/a.py:3]\n> x = 1' } }))
    await waitFor(() => expect(box().value).toBe('look:\n\n> [src/a.py:3]\n> x = 1\n'))
  })

  it('names every kind of item', async () => {
    const { quoteLabel } = await import('../../src/components/Chat.tsx')
    expect(quoteLabel(item('assistant', 'x', { engine: 'codex' }), null)).toBe('Codex said')
    expect(quoteLabel(item('tool', 'x'), 'output')).toBe('tool output')
    expect(quoteLabel(item('error', 'x'), null)).toBe('from this session')
  })
})
