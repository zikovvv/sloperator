// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('store', () => {
  it('applies every server event, reconnects after a close, and exposes the helpers', async () => {
    const sockets: any[] = []
    class FakeSocket { readyState = 1; onopen: any; onclose: any; onmessage: any; sent: string[] = []; constructor(public url: string) { sockets.push(this) } send(d: string) { this.sent.push(d) } close() {} }
    vi.stubGlobal('WebSocket', FakeSocket)
    const notices: any[] = []
    window.addEventListener('orchestrator:notice', (event) => notices.push((event as CustomEvent).detail))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url.includes('transcript') ? [{ id: 'h', role: 'user', text: 'hist', timestamp: 1 }] : { id: 'n' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { useStore, loadTranscript, sendMessage, stopSession, patchSession, createSession } = await import('../../src/store.ts')
    vi.useFakeTimers()
    const { result } = renderHook(() => useStore())
    const socket = sockets[0]
    act(() => { socket.onopen() })
    expect(result.current.connected).toBe(true)
    const send = (event: any) => act(() => { socket.onmessage({ data: JSON.stringify(event) }) })
    send({ type: 'state', projects: [{ id: 'p' }], worktrees: [{ id: 'w' }], sessions: [{ id: 's', title: 'a' }] })
    expect(result.current.sessions[0].title).toBe('a')
    send({ type: 'running', sessionIDs: ['s'] }); expect(result.current.running.has('s')).toBe(true)
    send({ type: 'session', session: { id: 's', title: 'b' } }); expect(result.current.sessions[0].title).toBe('b')
    send({ type: 'session', session: { id: 'zzz', title: 'ignored' } })
    send({ type: 'transcript', sessionID: 's', items: [{ id: '1', role: 'user', text: 'x', timestamp: 1 }] })
    send({ type: 'append', sessionID: 's', item: { id: '2', role: 'tool', text: 'ls', timestamp: 2 } })
    send({ type: 'append', sessionID: 'other', item: { id: '3', role: 'user', text: 'y', timestamp: 3 } })
    send({ type: 'patch', sessionID: 's', itemID: '2', toolOutput: 'out' })
    send({ type: 'patch', sessionID: 'nowhere', itemID: '9', toolOutput: 'out' })
    expect(result.current.transcripts.s.find((item: any) => item.id === '2').toolOutput).toBe('out')
    send({ type: 'notify', notice: { title: 't', body: 'b' } }); expect(notices).toHaveLength(1)
    send({ type: 'error', message: 'oops' })
    send({ type: 'unknown-kind' })
    act(() => { socket.onclose() })
    expect(result.current.connected).toBe(false)
    act(() => { vi.advanceTimersByTime(1100) })
    expect(sockets.length).toBe(2)
    vi.useRealTimers()
    expect(await loadTranscript('s')).toHaveLength(1)
    await sendMessage('s', 'hello'); await stopSession('s'); await patchSession('s', { title: 'z' } as any); await createSession('w')
    const methods = fetchMock.mock.calls.map((call) => `${(call[1] as any)?.method ?? 'GET'} ${call[0]}`)
    expect(methods).toContain('POST /api/session/s/send'); expect(methods).toContain('POST /api/session/s/stop')
    expect(methods).toContain('PATCH /api/session/s'); expect(methods).toContain('POST /api/worktree/w/session')
  })
})
