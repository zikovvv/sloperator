// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, TranscriptItem } from '../../shared/types.ts'

let answer: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  answer = vi.fn(async () => ({ ok: true }))
  vi.doMock('../../src/lib/api.ts', () => ({ api: { answerPermission: answer } }))
  vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null, languageOf: () => null }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const item = (permission: PermissionRequest): TranscriptItem => ({ id: 'i1', role: 'permission', text: 'x', timestamp: 1, permission })
const questions = {
  questions: [
    { question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Go' }, { label: 'No', description: 'Stop' }], multiSelect: false },
    { question: 'Which parts?', header: 'Parts', options: [{ label: 'Tests' }, { label: 'Docs' }], multiSelect: true },
  ],
}
const mount = async (permission: PermissionRequest) => {
  const { PermissionCard } = await import('../../src/components/PermissionCard.tsx')
  return render(<PermissionCard item={item(permission)} />)
}

describe('a question from Claude', () => {
  it('collects one answer per question — a single pick, several picks, or your own words — and sends them', async () => {
    await mount({ id: 'r1', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'pending' })
    expect(screen.getByText('Claude is asking you')).toBeTruthy()
    const answerButton = () => screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement
    expect(answerButton().disabled).toBe(true)                       // nothing chosen yet
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))       // single-select: the later pick replaces the earlier
    expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Yes' }).getAttribute('aria-pressed')).toBe('false')
    expect(answerButton().disabled).toBe(true)                       // the second question is still open
    fireEvent.click(screen.getByRole('button', { name: 'Tests' }))
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))     // multi-select toggles off again
    expect(answerButton().disabled).toBe(false)
    // "Other" on the first question: the typed text is the answer, not the word Other.
    fireEvent.click(screen.getAllByRole('button', { name: 'Other…' })[0])
    expect(answerButton().disabled).toBe(true)                       // an empty custom answer does not count
    fireEvent.change(screen.getByLabelText('Your answer to: Continue?'), { target: { value: 'only if the tests pass' } })
    fireEvent.click(answerButton())
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r1', { behavior: 'allow', answers: { 'Continue?': 'only if the tests pass', 'Which parts?': ['Tests'] } }))
  })

  it('can be declined, and shows how it was settled afterwards', async () => {
    await mount({ id: 'r2', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r2', { behavior: 'deny', message: 'The user declined to answer.' }))
    cleanup()
    await mount({ id: 'r3', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'allowed', answers: { 'Continue?': 'Yes', 'Which parts?': ['Tests', 'Docs'] } })
    expect(screen.getByText('→ Yes')).toBeTruthy()
    expect(screen.getByText('→ Tests, Docs')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    cleanup()
    await mount({ id: 'r4', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'denied', message: 'busy' })
    expect(screen.getAllByText('Declined: busy')).toHaveLength(2)
    cleanup()
    await mount({ id: 'r4b', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'denied' })
    expect(screen.getAllByText('Declined')).toHaveLength(2)
    cleanup()
    await mount({ id: 'r5', toolName: 'AskUserQuestion', input: { questions: [questions.questions[0]] }, toolUseID: 't', status: 'expired' })
    expect(screen.getByText('Nobody answered before the turn ended')).toBeTruthy()
    cleanup()
    await mount({ id: 'r6', toolName: 'AskUserQuestion', input: null, toolUseID: 't', status: 'allowed', answers: {} })
    expect(screen.getByText('Claude asked')).toBeTruthy()   // no questions at all: nothing to list, nothing thrown
    cleanup()
    await mount({ id: 'r6b', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'allowed', answers: {} })
    expect(screen.getAllByText('→ —')).toHaveLength(2)      // allowed through the API with nothing chosen
    cleanup()
    await mount({ id: 'r6d', toolName: 'AskUserQuestion', input: questions, toolUseID: 't', status: 'allowed' })
    expect(screen.getAllByText('→ —')).toHaveLength(2)      // and the same when the answers key is not even there
    cleanup()
    await mount({ id: 'r6c', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Bare?', options: [{ label: 'A' }] }] }, toolUseID: 't', status: 'pending' })
    expect(screen.getByRole('group', { name: 'Bare?' })).toBeTruthy()   // no header: the question names the group
  })
})

describe('permission for a tool', () => {
  it('shows the command, allows it, or denies it with a reason', async () => {
    await mount({ id: 'r7', toolName: 'Bash', input: { command: 'python3 -c "print(1)"', description: 'Probe' }, toolUseID: 't', status: 'pending' })
    expect(screen.getByText('Claude wants to run')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('Probe')).toBeTruthy()                                  // the description is the headline
    expect(screen.getByText('python3 -c "print(1)"')).toBeTruthy()                 // the command is the body
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r7', { behavior: 'allow' }))
    cleanup()
    await mount({ id: 'r8', toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseID: 't', status: 'pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.change(screen.getByLabelText('Why not'), { target: { value: 'archive it instead' } })
    fireEvent.keyDown(screen.getByLabelText('Why not'), { key: 'a' })
    expect(answer).toHaveBeenCalledTimes(1)                                       // typing is not sending
    fireEvent.keyDown(screen.getByLabelText('Why not'), { key: 'Enter' })
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r8', { behavior: 'deny', message: 'archive it instead' }))
    cleanup()
    await mount({ id: 'r9', toolName: 'Bash', input: { command: 'x' }, toolUseID: 't', status: 'pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r9', { behavior: 'deny', message: '' }))
  })

  it('names Codex when it is Codex asking: the tools of the app itself ask for both engines', async () => {
    const { PermissionCard } = await import('../../src/components/PermissionCard.tsx')
    const pending: PermissionRequest = { id: 'r12', toolName: 'mcp__orchestrator__update_worktree', input: { folder: 'review' }, toolUseID: 't', status: 'pending' }
    const view = render(<PermissionCard item={{ ...item(pending), engine: 'codex' }} />)
    expect(screen.getByText('Codex wants to run')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Deny…' }))
    expect(screen.getByPlaceholderText('Tell Codex why, or what to do instead')).toBeTruthy()
    view.unmount()
    render(<PermissionCard item={{ ...item({ ...pending, status: 'allowed' }), engine: 'codex' }} />)
    expect(screen.getByText('Codex asked to run')).toBeTruthy()
  })

  it('reads as history once settled, and copes with the API failing', async () => {
    await mount({ id: 'r10', toolName: 'Write', input: { file_path: '/w/a.py', content: 'x = 1' }, toolUseID: 't', status: 'allowed' })
    expect(screen.getByText('Claude asked to run')).toBeTruthy()
    expect(screen.getByText('Allowed')).toBeTruthy()
    cleanup()
    await mount({ id: 'r11', toolName: 'Bash', input: { command: 'x' }, toolUseID: 't', status: 'denied', message: 'no' })
    expect(screen.getByText('Denied — no')).toBeTruthy()
    cleanup()
    await mount({ id: 'r12', toolName: 'Bash', input: { command: 'x' }, toolUseID: 't', status: 'denied' })
    expect(screen.getByText('Denied')).toBeTruthy()
    cleanup()
    await mount({ id: 'r13', toolName: 'Bash', input: { command: 'x' }, toolUseID: 't', status: 'expired' })
    expect(screen.getByText('Nobody answered before the turn ended')).toBeTruthy()
    cleanup()
    answer.mockRejectedValueOnce(new Error('offline'))
    const toast = vi.fn()
    window.addEventListener('orchestrator:toast', (event) => toast((event as CustomEvent).detail?.text))
    await mount({ id: 'r14', toolName: 'Bash', input: { command: 'x' }, toolUseID: 't', status: 'pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
  })
})

describe('describeInput', () => {
  it('says what each tool would do in one line, and what to show behind it', async () => {
    const { describeInput } = await import('../../src/components/PermissionCard.tsx')
    expect(describeInput('Bash', { command: 'ls -la\nwc' })).toEqual({ headline: 'ls -la', body: { text: 'ls -la\nwc', language: 'shell' } })
    expect(describeInput('shell', { command: 'ls', description: 'List' }).headline).toBe('List')
    expect(describeInput('Read', { file_path: '/a.py', offset: 10, limit: 20 })).toEqual({ headline: '/a.py:10 (+20 lines)', body: null })
    expect(describeInput('Read', { file_path: '/a.py' }).headline).toBe('/a.py')
    expect(describeInput('Edit', { file_path: '/a.py', old_string: 'x', new_string: 'y' })).toEqual({ headline: '/a.py', body: { text: '--- old\nx\n+++ new\ny', language: 'diff' } })
    expect(describeInput('Write', { file_path: '/a.py', content: 'x = 1' })).toEqual({ headline: '/a.py', body: { text: 'x = 1', language: null } })
    expect(describeInput('Grep', { pattern: 'TODO', path: 'src' }).headline).toBe('TODO in src')
    expect(describeInput('Glob', { pattern: '**/*.ts' }).headline).toBe('**/*.ts')
    expect(describeInput('Agent', { description: 'Review it', prompt: 'Look hard' })).toEqual({ headline: 'Review it', body: { text: 'Look hard', language: 'markdown' } })
    expect(describeInput('Task', {}).headline).toBe('subagent')
    expect(describeInput('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c' }] }))
      .toEqual({ headline: '3 todos', body: { text: '☑ a\n◐ b\n☐ c', language: null } })
    expect(describeInput('TodoWrite', { todos: [{ content: 'a' }] }).headline).toBe('1 todo')
    expect(describeInput('TodoWrite', { todos: [{ status: 'pending' }] }).body).toEqual({ text: '☐ ', language: null })
    expect(describeInput('AskUserQuestion', {}).headline).toBe('')
    expect(describeInput('TodoWrite', {}).headline).toBe('0 todos')
    expect(describeInput('WebFetch', { url: 'https://x', prompt: 'why' })).toEqual({ headline: 'https://x', body: { text: 'why', language: null } })
    expect(describeInput('WebFetch', { url: 'https://x' }).body).toBeNull()
    expect(describeInput('WebSearch', { query: 'q' }).headline).toBe('q')
    expect(describeInput('Skill', { skill: 'loop', args: '5m' }).headline).toBe('/loop 5m')
    expect(describeInput('Skill', { skill: 'loop' }).headline).toBe('/loop')
    expect(describeInput('ToolSearch', { query: 'select:X' }).headline).toBe('select:X')
    expect(describeInput('AskUserQuestion', { questions: [{ question: 'A?' }, { question: 'B?' }] }).headline).toBe('A? · B?')
    expect(describeInput('mcp__telegram-notify__send_notification', { message: 'hi' }).headline).toBe('telegram-notify · send_notification')
    expect(describeInput('Monitor', { command: 'tail -f x' }).headline).toBe('tail -f x')     // any string field will do
    expect(describeInput('Monitor', { count: 3 }).headline).toBe('')
    expect(describeInput('Bash', null).headline).toBe('')
  })
})
