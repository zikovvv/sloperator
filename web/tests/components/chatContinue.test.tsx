// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, TranscriptItem } from '../../shared/types.ts'

const session: Session = {
  id: 's1', worktreeID: 'w', title: 'Chat', engine: 'claude', accessMode: 'edits', steeringMode: 'steer',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
}
const error = (text: string, canRetry?: boolean): TranscriptItem =>
  ({ id: text, role: 'error', text, canRetry, timestamp: 1 })

beforeEach(() => { vi.resetModules(); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (items: TranscriptItem[], running = false) => {
  vi.doMock('../../src/lib/api.ts', () => ({ api: { activity: async () => ({ running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] }), draft: async () => ({ text: '' }), saveDraft: async () => ({}), voiceStatus: async () => ({ available: false }) } }))
  vi.doMock('../../src/lib/useVoice.ts', () => ({ useVoice: () => ({ state: 'idle', hint: null, toggle: vi.fn(), stop: vi.fn() }) }))
  const { Chat } = await import('../../src/components/Chat.tsx')
  const onContinue = vi.fn()
  render(<Chat session={session} items={items} running={running} skills={[]} comments={[]}
               onRemoveComment={() => {}} onClearComments={() => {}} onOpenFile={() => {}}
               density="normal" onContinue={onContinue} />)
  return { onContinue }
}

describe('a failure in the log', () => {
  it('offers Continue with an API-failure explanation, and calls back when pressed', async () => {
    const { onContinue } = await mount([error('Failed to authenticate. API Error: 401', true)])
    expect(screen.getByText(/API Error: 401/)).toBeTruthy()
    expect(screen.getByText(/The engine could not be reached/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalled()
  })

  it('explains an ordinary failure differently, and offers nothing for an error that cannot be picked up', async () => {
    await mount([error('Process exited with status 2\nsomething broke', true)])
    expect(screen.getByText('The turn did not finish.')).toBeTruthy()
    cleanup(); vi.resetModules()
    await mount([error('That conversation no longer exists')])
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('will not continue while a turn is already running', async () => {
    await mount([error('fetch failed', true)], true)
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('isConnectionFailure', () => {
  it('recognises API and network trouble, and nothing else', async () => {
    const { isConnectionFailure } = await import('../../src/components/Chat.tsx')
    for (const text of [
      'fetch failed', 'ECONNRESET while streaming', 'read ETIMEDOUT', 'getaddrinfo ENOTFOUND api.anthropic.com',
      'EAI_AGAIN', 'socket hang up', 'network is unreachable', 'request timed out', 'HTTP 502', '503 Service',
      '504 Gateway', '429 Too Many Requests', 'Overloaded', 'rate limit exceeded', 'API Error: 401', 'Unauthorized',
    ]) expect(isConnectionFailure(text), text).toBe(true)
    for (const text of ['Process exited with status 2', 'TypeError: x is not a function', 'no conversation found']) {
      expect(isConnectionFailure(text), text).toBe(false)
    }
  })
})
