// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionActivity } from '../../shared/types.ts'

const now = Date.now()
const busy: SessionActivity = {
  running: true, startedAt: 1000,
  tools: [{ id: 't1', name: 'Task', detail: 'sub agent', startedAt: now - 65_000 }],
  finished: [],
  processes: [{ pid: 42, ppid: 1, command: 'sleep 30', depth: 1, elapsed: 65, cpu: 0.4 },
              { pid: 43, ppid: 42, command: 'python x.py', depth: 2, elapsed: 3, cpu: 97 }],
  agents: [
    { id: 'abcdef123', updatedAt: 2000, idleMS: 5, prompt: 'Look around\nmore', truncated: true,
      rows: [{ role: 'assistant', text: 'Hi' }, { role: 'tool', text: 'Bash ls' }, { role: 'info', text: 'denied' }] },
    { id: 'old', updatedAt: 500, idleMS: 99, prompt: '', rows: [], truncated: false },
  ],
}
const idle: SessionActivity = { running: false, startedAt: null, tools: [], finished: [], processes: [], agents: [] }
let activity: ReturnType<typeof vi.fn>
let killProcess: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules(); localStorage.clear()
  activity = vi.fn(async () => busy)
  killProcess = vi.fn(async () => ({ ok: true }))
  vi.doMock('../../src/lib/api.ts', () => ({ api: { activity, killProcess } }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const mount = async (running = true) => {
  const { ActivityPanel } = await import('../../src/components/ActivityPanel.tsx')
  return render(<ActivityPanel sessionID="s1" running={running} />)
}

describe('ActivityPanel', () => {
  it('folds to one line; opens to the tools, the processes with a kill switch, and the subagents', async () => {
    await mount()
    const header = await screen.findByRole('button', { expanded: false })
    expect(header.textContent).toBe('▸Running now · 1 tool call · 2 processes · 2 subagents')
    fireEvent.click(header)
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(localStorage.getItem('orchestrator.activityOpen')).toBe('1')
    expect(screen.getByText('Task')).toBeTruthy(); expect(screen.getByText('sub agent')).toBeTruthy(); expect(screen.getByText('1m 5s')).toBeTruthy()
    expect(screen.getByText('sleep 30')).toBeTruthy(); expect(screen.getByText('python x.py')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' })[0])
    expect(killProcess).toHaveBeenCalledWith(42)
    const agents = screen.getAllByTestId('subagent')
    expect(agents[0].textContent).toContain('agent abcdef12'); expect(agents[0].textContent).toContain('Look around'); expect(agents[0].textContent).toContain('working')
    expect(agents[0].textContent).toContain('… earlier lines not shown'); expect(agents[0].textContent).toContain('→ Bash ls'); expect(agents[0].textContent).toContain('denied')
    expect(agents[1].textContent).toContain('finished'); expect(agents[1].textContent).toContain('Nothing said yet.')
  })

  it('counts what finished, and shows it as the last turn once the session idles', async () => {
    const finished = [{ id: 'f1', name: 'Bash', detail: 'npm test', input: { command: 'npm test' }, startedAt: 100, endedAt: 4100, output: 'ok 12 tests', failed: false }]
    activity.mockImplementation(async () => ({ ...idle, finished }))
    await mount(false)
    const header = await screen.findByRole('button', { expanded: false })
    expect(header.textContent).toBe('▸Last turn · 1 finished')
    fireEvent.click(header)
    expect(screen.getByText('Last turn (1)')).toBeTruthy()
    fireEvent.click(screen.getByTestId('finished-tool').querySelector('button')!)
    expect(screen.getByTestId('tool-output').textContent).toBe('ok 12 tests')
  })

  it('asks every second while the session runs, once when it idles, and says nothing when there is nothing', async () => {
    vi.useFakeTimers()
    const { rerender } = await mount()
    await act(async () => {})
    expect(activity).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(activity).toHaveBeenCalledTimes(2)
    const { ActivityPanel } = await import('../../src/components/ActivityPanel.tsx')
    activity.mockImplementation(async () => ({ ...idle, agents: busy.agents }))
    rerender(<ActivityPanel sessionID="s1" running={false} />)
    await act(async () => {})
    expect(activity).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(activity).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button').textContent).toContain('Last turn · 2 subagents')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByTestId('subagent')[0].textContent).toContain('finished')   // nothing runs, so nobody is working
    activity.mockImplementation(async () => ({ ...idle, running: true, startedAt: 5, tools: busy.tools }))
    rerender(<ActivityPanel sessionID="s2" running />)
    await act(async () => {})
    expect(screen.getAllByRole('button')[0].textContent).toBe('▾Running now · 1 tool call')   // no processes, no subagents: not mentioned
    activity.mockImplementation(async () => idle)
    rerender(<ActivityPanel sessionID="s3" running={false} />)
    await act(async () => {})
    expect(screen.queryByTestId('activity-panel')).toBeNull()
  })

  it('reports a kill that failed, and stays quiet when the server cannot be asked', async () => {
    const toasts: string[] = []
    window.addEventListener('orchestrator:toast', (event) => toasts.push((event as CustomEvent).detail.text))
    killProcess.mockImplementation(async () => { throw new Error('not yours') })
    localStorage.setItem('orchestrator.activityOpen', '1')
    await mount()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Kill' }))[1])
    await waitFor(() => expect(toasts).toEqual(['not yours']))
    cleanup()
    activity.mockImplementation(async () => { throw new Error('offline') })
    await mount()
    await act(async () => {})
    expect(screen.queryByTestId('activity-panel')).toBeNull()
  })
})
