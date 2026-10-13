// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('api defaults', () => {
  it('newWorktree without options posts an empty body; diff only adds sha when given', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('../src/lib/api.ts')
    await api.newWorktree('p')
    expect(fetchMock.mock.calls[0][1]!.body).toBe('{}')
    await api.diff('/w', 'uncommitted', null)
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('sha=')
    await api.diff('/w', 'commit', 'main', 3, 'abc')
    expect(String(fetchMock.mock.calls[2][0])).toContain('base=main&sha=abc')
    expect(String(fetchMock.mock.calls[2][0])).not.toContain('fresh=')
    await api.diff('/w', 'branch', 'main', 3, undefined, true)   // the refresh button: fetch origin first
    expect(String(fetchMock.mock.calls[3][0])).toContain('&fresh=1')
    await api.diffFile('/w', 'commit', 'main', 'src/a b.py', 'abc')
    expect(String(fetchMock.mock.calls[4][0])).toBe('/api/diff/file?path=%2Fw&scope=commit&file=src%2Fa%20b.py&base=main&sha=abc')
    await api.diffFile('/w', 'uncommitted', null, 'src/a.py')
    expect(String(fetchMock.mock.calls[5][0])).toBe('/api/diff/file?path=%2Fw&scope=uncommitted&file=src%2Fa.py')
    await api.models()
    expect(String(fetchMock.mock.calls[6][0])).toBe('/api/models')
    await api.nameSession('s1')   // "Rename with Claude"
    expect(String(fetchMock.mock.calls[7][0])).toBe('/api/session/s1/name')
    expect(fetchMock.mock.calls[7][1]!.method).toBe('POST')
  })
})

describe('downsample', () => {
  it('averages fractional windows and passes through when the target rate is not lower', async () => {
    const { downsample } = await import('../src/lib/wav.ts')
    const samples = new Float32Array([1, 1, 3, 3, 5, 5])
    expect(Array.from(downsample(samples, 3, 2))).toEqual([1, 2, 3, 5])
    expect(downsample(samples, 2, 2)).toBe(samples)
  })
})

describe('useVoice', () => {
  const processors: any[] = []
  const mediaStub = (rate: number) => {
    const track = { stop: vi.fn() }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } })
    class FakeContext {
      sampleRate = rate
      destination = {}
      createMediaStreamSource() { return { connect() {} } }
      createScriptProcessor() { const processor = { connect() {}, onaudioprocess: null as any }; processors.push(processor); return processor }
      close = vi.fn(async () => {})
    }
    vi.stubGlobal('AudioContext', FakeContext)
    return { track }
  }

  it('toggle while recording stops and transcribes at the context sample rate', async () => {
    const { track } = mediaStub(32000)
    const transcribe = vi.fn(async () => 'hi ')
    vi.doMock('../src/lib/api.ts', () => ({ api: { voiceStatus: async () => ({ available: true }), transcribe } }))
    const { useVoice } = await import('../src/lib/useVoice.ts')
    const onText = vi.fn()
    const { result } = renderHook(() => useVoice(onText))
    await act(async () => { result.current.toggle() })
    await waitFor(() => expect(result.current.state).toBe('recording'))
    act(() => { processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(32000) } }) })
    await act(async () => { result.current.toggle() })
    await waitFor(() => expect(result.current.state).toBe('idle'))
    expect(track.stop).toHaveBeenCalled()
    expect(onText).toHaveBeenCalledWith('hi')
    const clip = (transcribe.mock.calls[0] as any[])[0] as Blob
    expect(clip.size).toBe(44 + 16000 * 2)
  })

  it('reports an unavailable server without a hint as no hint at all', async () => {
    vi.doMock('../src/lib/api.ts', () => ({ api: { voiceStatus: async () => ({ available: false }), transcribe: vi.fn() } }))
    const { useVoice } = await import('../src/lib/useVoice.ts')
    const { result } = renderHook(() => useVoice(() => {}))
    await waitFor(() => expect(result.current.state).toBe('unavailable'))
    expect(result.current.hint).toBeNull()
    act(() => { result.current.toggle() })
    expect(result.current.state).toBe('unavailable')
  })
})

describe('store', () => {
  it('stops reconnecting once unmounted and ignores unknown events', async () => {
    vi.useFakeTimers()
    const sockets: any[] = []
    class FakeSocket { onopen: any; onclose: any; onmessage: any; constructor() { sockets.push(this) } close() {} }
    vi.stubGlobal('WebSocket', FakeSocket)
    const { useStore } = await import('../src/store.ts')
    const { result, unmount } = renderHook(() => useStore())
    act(() => { sockets[0].onopen() })
    expect(result.current.connected).toBe(true)
    act(() => { sockets[0].onmessage({ data: JSON.stringify({ type: 'unknown' }) }) })
    unmount()
    act(() => { sockets[0].onclose() })
    vi.advanceTimersByTime(5000)
    expect(sockets).toHaveLength(1)
  })
})
