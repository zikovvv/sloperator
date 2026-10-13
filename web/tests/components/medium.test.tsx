// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const apiMock = () => {
  const calls: string[] = []
  const impl: Record<string, any> = {}
  const handler = { get: (_t: any, key: string) => impl[key] ?? ((...args: any[]) => { calls.push(`${key}:${JSON.stringify(args).slice(0, 60)}`); return Promise.resolve({}) }) }
  return { api: new Proxy({}, handler), calls, impl }
}

describe('TasksTab', () => {
  it('renders agents with subagents, commands and processes; stop, open and kill work; errors show', async () => {
    const { api, calls, impl } = apiMock()
    let tasks: any = { tasks: [{
      sessionID: 's1', title: 'Job', engine: 'claude', worktree: 'main', pid: 42, startedAt: Date.now() - 3_700_000,
      tools: [{ id: 't1', name: 'Task', detail: 'sub', startedAt: Date.now() - 65_000 }, { id: 't2', name: 'Bash', detail: 'ls', startedAt: Date.now() - 5000 }],
      finished: [],
      processes: [{ pid: 43, ppid: 42, command: 'bash', depth: 1, elapsed: 4, cpu: 1 }],
    }], terminals: [{ id: 'x', worktreeID: 'w', title: 'Terminal 1', pid: 9 }] }
    impl.tasks = vi.fn(async () => tasks)
    impl.killProcess = vi.fn(async (pid: number) => { if (pid === 43) throw new Error('refused'); return {} })
    impl.closeTerminal = vi.fn(async () => ({}))
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { TasksTab } = await import('../../src/components/TasksTab.tsx')
    const onOpen = vi.fn(); const onStop = vi.fn()
    render(<TasksTab onOpenSession={onOpen} onStopSession={onStop} />)
    await waitFor(() => expect(screen.getByText('Job')).toBeTruthy())
    expect(screen.getByText(/1h 1m/)).toBeTruthy(); expect(screen.getByText(/1m 5s/)).toBeTruthy()
    fireEvent.click(screen.getByText('Job')); expect(onOpen).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByRole('button', { name: 'Stop turn' })); expect(onStop).toHaveBeenCalledWith('s1')
    expect(screen.getByText('agent pid 42')).toBeTruthy()
    expect(screen.getByText(/Commands and their processes \(1\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await waitFor(() => expect(screen.getByText('refused')).toBeTruthy())
    expect(impl.killProcess).toHaveBeenCalledWith(43)
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(impl.closeTerminal).toHaveBeenCalledWith('x')
    tasks = { tasks: [{ ...tasks.tasks[0], tools: [], processes: [] }], terminals: [] }
    await waitFor(() => expect(screen.getByText(/Thinking — no tool call/)).toBeTruthy(), { timeout: 4000 })
    tasks = { tasks: [], terminals: [] }
    await waitFor(() => expect(screen.getByText(/No agent is running/)).toBeTruthy(), { timeout: 4000 })
    impl.tasks = vi.fn(async () => { throw new Error('down') })
    await waitFor(() => expect(screen.getByText('down')).toBeTruthy(), { timeout: 4000 })
    void calls
  })
})

describe('TerminalDrawer', () => {
  it('opens one terminal if none, adds and closes tabs, hides, and drops a tab whose shell died', async () => {
    const terminals: any[] = []
    const { api, impl } = apiMock()
    impl.terminals = vi.fn(async () => ({ terminals: [...terminals] }))
    impl.openTerminal = vi.fn(async () => { const t = { id: `t${terminals.length + 1}`, worktreeID: 'w', title: `Terminal ${terminals.length + 1}`, pid: 1 }; terminals.push(t); return t })
    impl.closeTerminal = vi.fn(async (id: string) => { terminals.splice(terminals.findIndex((t) => t.id === id), 1); return {} })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const sockets: any[] = []
    class FakeSocket { static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any; sent: string[] = []; constructor(public url: string) { sockets.push(this); setTimeout(() => this.onopen?.(), 0) } send(data: string) { this.sent.push(data) } close() { this.onclose?.({ code: 1000 }) } }
    vi.stubGlobal('WebSocket', FakeSocket)
    const dispose = { dispose: vi.fn() }
    vi.doMock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write = vi.fn(); onData(cb: any) { (this as any).data = cb; return dispose } onResize(cb: any) { (this as any).resize = cb; return dispose } dispose() {} } }))
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
    vi.doMock('@xterm/xterm/css/xterm.css', () => ({}))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { TerminalDrawer } = await import('../../src/components/TerminalDrawer.tsx')
    const onClose = vi.fn()
    render(<TerminalDrawer worktreeID="w" worktreeName="main" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeTruthy())
    expect(impl.openTerminal).toHaveBeenCalledWith('w', { ifNone: true })
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /Terminal 2/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: /Terminal 1/ }))
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    sockets[0].onmessage?.({ data: 'hello' }); sockets[0].onmessage?.({ data: 5 })
    fireEvent.click(screen.getByRole('tab', { name: /Terminal 2/ }).querySelector('[aria-label="Close terminal"]')!)
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Terminal 2/ })).toBeNull())
    act(() => { sockets[0].onclose?.({ code: 4004 }) })
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' })); expect(onClose).toHaveBeenCalled()
    impl.openTerminal = vi.fn(async () => { throw new Error('no shell') })
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    await waitFor(() => expect(screen.getByText('no shell')).toBeTruthy())
  })
  it('reports a listing failure', async () => {
    const { api, impl } = apiMock()
    impl.terminals = vi.fn(async () => { throw new Error('listing failed') })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    vi.doMock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} } } onResize() { return { dispose() {} } } dispose() {} } }))
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
    vi.doMock('@xterm/xterm/css/xterm.css', () => ({}))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { TerminalDrawer } = await import('../../src/components/TerminalDrawer.tsx')
    render(<TerminalDrawer worktreeID="w" worktreeName="main" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('listing failed')).toBeTruthy())
  })
})

