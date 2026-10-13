// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

beforeEach(() => {
  vi.resetModules(); Element.prototype.scrollIntoView = vi.fn()
  vi.doMock('../../src/lib/api.ts', () => ({ api: { activity: async () => ({ running: false, startedAt: null, tools: [], background: [], finished: [], processes: [], agents: [] }), draft: async () => ({ text: '' }), saveDraft: async () => ({}), voiceStatus: async () => ({ available: false }) } }))
  vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: () => ({ state: 'idle', hint: null, toggle: vi.fn(), stop: vi.fn() }) }))
  vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null, languageOf: () => null }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (items: TranscriptItem[], density: 'ubercompact' | 'compact' | 'normal' | 'verbose', running = false) => {
  const { Chat } = await import('../../src/components/Chat.tsx')
  return render(<Chat session={session} items={items} running={running} skills={[]} comments={[]} onRemoveComment={() => {}}
                      onClearComments={() => {}} onOpenFile={() => {}} density={density} onContinue={() => {}} />)
}

const conversation = () => [
  item('user', 'do the thing'),
  item('assistant', 'Looking first.'),
  item('tool', 'src/app.py', { toolName: 'Read', toolOutput: 'def x(): pass' }),
  item('thinking', 'hmm'),
  item('assistant', 'Now changing it.'),
  item('tool', 'ls -la', { toolName: 'Bash', toolOutput: 'total 0' }),
  item('tool', 'grep x', { toolName: 'Grep', toolOutput: '⚠️ no match' }),
  item('assistant', 'Done: it works now.', { engine: 'codex' }),
  item('info', 'turn ended'),
]

describe('groupTurns', () => {
  it('cuts the log into turns at your messages, with steps inside and the closing answer apart', async () => {
    const { groupTurns, stepSummary, stepsOf } = await import('../../src/components/Chat.tsx')
    const turns = groupTurns(conversation(), false)
    expect(turns).toHaveLength(1)
    expect(turns[0].user?.text).toBe('do the thing')
    expect(stepsOf(turns[0]).map((step) => [step.lead?.text, step.work.length])).toEqual([['Looking first.', 2], ['Now changing it.', 2]])
    expect(turns[0].answer?.text).toBe('Done: it works now.')
    expect(turns[0].after.map((block) => (block.kind === 'note' ? block.item.text : '?'))).toEqual(['turn ended'])
    // While the agent is still running, its last line is not yet an answer.
    const live = groupTurns(conversation().slice(0, 8), true)
    expect(live[0].answer).toBeNull(); expect(stepsOf(live[0])).toHaveLength(3)
    // Tools before any line of the agent's, and a log that starts without a message of yours.
    const bare = groupTurns([item('tool', 'x', { toolName: 'Bash' }), item('assistant', 'ok')], false)
    expect(bare[0].user).toBeNull(); expect(stepsOf(bare[0])[0].lead).toBeNull(); expect(bare[0].answer?.text).toBe('ok')
    expect(stepSummary({ lead: null, work: [item('thinking', 'hm')] }, true)).toBe('thinking…')
    expect(stepSummary({ lead: null, work: [item('thinking', 'hm')] }, false)).toBe('thought')
    expect(groupTurns([], false)).toEqual([])
    // A turn made only of notes has no step to lift into an answer.
    const notesOnly = groupTurns([item('user', 'go'), item('info', 'just a note')], false)
    expect(notesOnly[0].answer).toBeNull()
    expect(notesOnly[0].blocks.map((block) => block.kind)).toEqual(['note'])
  })
})

describe('a failure in the middle of a turn', () => {
  it('stays where it happened, never under the answer, in every fold', async () => {
    const { groupTurns } = await import('../../src/components/Chat.tsx')
    const log = [
      item('user', 'do it'), item('assistant', 'Trying.'), item('tool', 'x', { toolName: 'Bash' }),
      item('error', 'Process exited with status 1', { canRetry: true }), item('info', 'Continuing after the failure…'),
      item('assistant', 'Second go.'), item('tool', 'y', { toolName: 'Bash' }), item('assistant', 'Done now.'),
    ]
    const [turn] = groupTurns(log, false)
    expect(turn.blocks.map((block) => (block.kind === 'note' ? `note:${block.item.role}` : `step:${block.step.lead?.text}`)))
      .toEqual(['step:Trying.', 'note:error', 'note:info', 'step:Second go.'])
    expect(turn.answer?.text).toBe('Done now.')
    for (const density of ['compact', 'ubercompact'] as const) {
      await mount(log, density)
      if (density === 'ubercompact') fireEvent.click(screen.getByTestId('turn-fold'))
      expect(screen.getByText('Done now.')).toBeTruthy()
      // The failure sits between the two steps, and Continue is not offered under the answer.
      const failure = screen.getByText(/Process exited/)
      const [first, second] = screen.getAllByTestId('step-fold')
      expect(first.compareDocumentPosition(failure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(failure.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // The answer comes after the failure box in the document.
      expect(screen.getByText(/Process exited/).compareDocumentPosition(screen.getByText('Done now.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      cleanup()
    }
  })
})

describe('compact and ubercompact views', () => {
  it('compact: one line per step with the tools behind it, the answer in the open, the failed step tinted', async () => {
    await mount(conversation(), 'compact')
    expect(screen.getByText('do the thing')).toBeTruthy()
    const folds = screen.getAllByTestId('step-fold')
    expect(folds.map((fold) => fold.textContent)).toEqual(['▸1 tool call · Read', '▸2 tool calls · Bash, Grep'])
    expect(folds[1].className).toContain('text-warn')
    expect(screen.getByText('Done: it works now.')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()   // the answer carries its engine
    expect(screen.queryByTestId('turn-fold')).toBeNull()
    fireEvent.click(folds[0])
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.getByText('src/app.py')).toBeTruthy()
  })

  it('ubercompact: once answered, the whole turn folds into one line that opens back into steps', async () => {
    await mount(conversation(), 'ubercompact')
    expect(screen.queryByTestId('step-fold')).toBeNull()
    const fold = screen.getByTestId('turn-fold')
    expect(fold.textContent).toBe('▸Worked in 2 steps · 3 tool calls')
    expect(screen.getByText('Done: it works now.')).toBeTruthy()
    fireEvent.click(fold)
    expect(screen.getAllByTestId('step-fold')).toHaveLength(2)
    fireEvent.click(fold)
    expect(screen.queryByTestId('step-fold')).toBeNull()
  })

  it('says "1 step · 1 tool call" in the singular, names a nameless tool "tool", and tints Claude orange', async () => {
    await mount([item('user', 'go'), item('assistant', 'one'), item('tool', 'x', { toolName: undefined }), item('assistant', 'done', { engine: 'claude' })], 'ubercompact')
    expect(screen.getByTestId('turn-fold').textContent).toBe('▸Worked in 1 step · 1 tool call')
    fireEvent.click(screen.getByTestId('turn-fold'))
    expect(screen.getByTestId('step-fold').textContent).toBe('▸1 tool call · tool')
    expect(screen.getByText('Claude').className).toContain('text-orange-400')
    cleanup()
    await mount([item('tool', 'x', { toolName: undefined, toolOutput: 'out' }), item('assistant', 'done', { engine: 'claude' })], 'verbose')
    expect(screen.getByText('tool')).toBeTruthy()
    expect(screen.getByText('Claude').className).toContain('text-orange-400')
  })

  it('a turn still running shows its live step breathing with what it is on, and keeps the folds after', async () => {
    await mount(conversation().slice(0, 7), 'ubercompact', true)
    const folds = screen.getAllByTestId('step-fold')
    expect(folds.at(-1)!.textContent).toBe('▸Grep grep x')
    expect(folds.at(-1)!.querySelector('.shimmer')).toBeTruthy()
    expect(screen.getByText(/Claude is working/)).toBeTruthy()
    fireEvent.click(folds.at(-1)!)
    expect(folds.at(-1)!.querySelector('.shimmer')).toBeNull()   // open: the rows say it, not the summary
  })

  it('keeps the live step breathing when a note lands after it mid-turn, as a steer does', async () => {
    await mount([item('user', 'go'), item('assistant', 'Trying.'), item('tool', 'ls', { toolName: 'Bash' }), item('info', 'Steering: interrupting current turn…')], 'compact', true)
    expect(screen.getByTestId('step-fold').querySelector('.shimmer')).toBeTruthy()
    expect(screen.getByText('Steering: interrupting current turn…')).toBeTruthy()
  })

  it('normal and verbose keep every row; a shell command opens highlighted with a copy button', async () => {
    await mount(conversation(), 'verbose')
    expect(screen.queryByTestId('step-fold')).toBeNull()
    expect(screen.getAllByText('Bash')).toHaveLength(1)
    expect(screen.getByText('total 0')).toBeTruthy()   // verbose opens outputs
    expect(screen.getAllByRole('button', { name: 'Copy output' }).length).toBeGreaterThan(0)   // one per open row
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    cleanup()
    await mount(conversation(), 'normal')
    expect(screen.queryByText('total 0')).toBeNull()
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByText('total 0')).toBeTruthy()
  })
})

describe('the composer grows and shrinks with the text', () => {
  it('drops the inline height when the draft is emptied, so a big paste does not leave a huge box', async () => {
    const view = await mount([], 'compact')
    const box = view.getByLabelText('Message') as HTMLTextAreaElement
    // jsdom reports scrollHeight 0, so the grown height is whatever it measures — what matters is
    // that emptying the draft removes the inline height instead of leaving the last one behind.
    fireEvent.change(box, { target: { value: 'x\n'.repeat(40) } })
    expect(box.style.height).not.toBe('')
    fireEvent.change(box, { target: { value: '' } })
    expect(box.style.height).toBe('')
  })
})
