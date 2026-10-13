// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDensity, saveDensity } from '../src/lib/density.ts'
import { reportError, toast } from '../src/lib/toast.ts'
import { showNotice } from '../src/lib/notice.ts'
import { useEscape } from '../src/lib/useEscape.ts'
import { api } from '../src/lib/api.ts'

describe('density', () => {
  it('round-trips and falls back to compact on junk or a throwing storage', () => {
    saveDensity('verbose'); expect(loadDensity()).toBe('verbose')
    saveDensity('ubercompact'); expect(loadDensity()).toBe('ubercompact')
    localStorage.setItem('orchestrator.logDensity', 'junk'); expect(loadDensity()).toBe('compact')
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private') })
    expect(loadDensity()).toBe('compact')
    spy.mockRestore()
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private') })
    expect(() => saveDensity('verbose')).not.toThrow()
    setSpy.mockRestore()
  })
})

describe('toast', () => {
  it('dispatches a window event with a tone, and reportError falls back to a generic message', () => {
    const seen: any[] = []
    window.addEventListener('orchestrator:toast', (event) => seen.push((event as CustomEvent).detail))
    toast('hello', 'info'); toast('bad'); reportError(new Error('boom')); reportError({}); reportError(null)
    expect(seen.map((entry) => [entry.text, entry.tone])).toEqual([
      ['hello', 'info'], ['bad', 'error'], ['boom', 'error'], ['That did not work.', 'error'], ['That did not work.', 'error']])
  })
})

describe('notice', () => {
  const original = (window as any).Notification
  afterEach(() => { (window as any).Notification = original; Object.defineProperty(navigator, 'userAgent', { value: 'jsdom', configurable: true }) })
  it('raises a browser notification when permitted, asks once when undecided, never in Electron', async () => {
    const shown: any[] = []
    class FakeNotification { static permission = 'granted'; onclick: any; constructor(public title: string, public options: any) { shown.push(this) } static requestPermission = vi.fn(async () => 'granted') }
    ;(window as any).Notification = FakeNotification
    const opened: any[] = []
    window.addEventListener('orchestrator:open', (event) => opened.push((event as CustomEvent).detail))
    showNotice({ title: 'done', body: 'b', sessionID: 's1' })
    expect(shown).toHaveLength(1)
    shown[0].onclick(); expect(opened[0].sessionID).toBe('s1')
    FakeNotification.permission = 'default'
    showNotice({ title: 'ask', body: 'b' }); showNotice({ title: 'ask again', body: 'b' })
    await Promise.resolve()
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    FakeNotification.permission = 'denied'; showNotice({ title: 'no', body: 'b' })
    Object.defineProperty(navigator, 'userAgent', { value: 'Electron/30', configurable: true })
    FakeNotification.permission = 'granted'; const before = shown.length
    showNotice({ title: 'electron handles it', body: 'b' }); expect(shown.length).toBe(before)
    delete (window as any).Notification
    expect(() => showNotice({ title: 'x', body: 'y' })).not.toThrow()
  })
})

describe('useEscape', () => {
  it('calls back on Escape only, and unsubscribes on unmount', () => {
    const onClose = vi.fn()
    const { unmount } = renderHook(() => useEscape(onClose))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('api wrappers', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('fail')) return new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
      if (url.includes('empty')) return new Response('', { status: 500 })
      return new Response(JSON.stringify({ ok: true, id: 'x', session: { id: 's' }, text: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })
  it('calls every route with the right method and body', async () => {
    await api.send('s', 'hi', [{ file: 'a', line: 1, body: 'b' }]); await api.stop('s'); await api.patchSession('s', { title: 't' } as any)
    await api.deleteSession('s'); await api.newSession('w'); await api.addProject('/p'); await api.deleteProject('p')
    await api.newWorktree('p', { name: 'n' }); await api.patchWorktree('w', { name: 'n' }); await api.deleteWorktree('w'); await api.deleteWorktree('w', true)
    await api.addGroup('p', 'g'); await api.removeGroup('p', 'g'); await api.moveWorktree('w', 'g'); await api.reorderGroups('p', ['a'])
    await api.worktreeInfo('w'); await api.diff('/r', 'uncommitted', null, 3); await api.diff('/r', 'commit', 'main', 3, 'sha'); await api.commits('/r', 'main')
    await api.branches('/r'); await api.file('/f'); await api.infra('skills'); await api.infraFile('/f'); await api.saveInfraFile('/f', 'x', 1)
    await api.skills(); await api.usage(); await api.planUsage(); await api.prs('p'); await api.prComments('p'); await api.reviewPR('p', 1, 't'); await api.autofixPR('p', 1, 't')
    await api.lspStatus('/f.py'); await api.definition('/w', '/f', 0, 0); await api.hover('/w', '/f', 0, 0); await api.settings(); await api.saveSettings({ a: 1 })
    await api.tasks(); await api.killProcess(1); await api.terminals('w'); await api.openTerminal('w'); await api.openTerminal('w', { ifNone: true }); await api.closeTerminal('t')
    await api.attention('s', true); await api.draft('s'); await api.saveDraft('s', 'd'); await api.voiceStatus(); await api.transcribe(new Blob(['x']))
    const methods = calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url.replace(/\?.*/, '')}`)
    expect(methods).toContain('DELETE /api/session/s'); expect(methods).toContain('PATCH /api/worktree/w'); expect(methods).toContain('PUT /api/settings')
    expect(calls.some((call) => call.url.includes('keepOnDisk=1'))).toBe(true)
    expect(calls.some((call) => call.url.includes('sha=sha'))).toBe(true)
  })
  it('throws the server message on failure, or the status when the body is empty', async () => {
    await expect(api.file('/fail')).rejects.toThrow(/nope/)
    await expect(api.file('/empty')).rejects.toThrow(/500/)
  })
})

describe('useVoice', () => {
  it('records raw PCM through an AudioContext, encodes a WAV, and posts it; handles denial and short clips', async () => {
    const processors: any[] = []
    class FakeContext {
      sampleRate = 16000
      createMediaStreamSource() { return { connect: vi.fn() } }
      createScriptProcessor() { const node: any = { connect: vi.fn(), onaudioprocess: null }; processors.push(node); return node }
      destination = {}
      close = vi.fn(async () => {})
    }
    vi.stubGlobal('AudioContext', FakeContext)
    const stop = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) }, configurable: true })
    const transcribed: Blob[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('voice/status')) return new Response(JSON.stringify({ available: true }), { status: 200 })
      transcribed.push(init?.body as Blob); return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 })
    }))
    const { useVoice } = await import('../src/lib/useVoice.ts')
    const onText = vi.fn()
    const { result } = renderHook(() => useVoice(onText))
    await act(async () => {})
    expect(result.current.state).toBe('idle')
    await act(async () => { result.current.toggle() })
    expect(result.current.state).toBe('recording')
    // Too short: a quarter second of nothing.
    await act(async () => { await result.current.stop() })
    expect(result.current.hint).toMatch(/Too short/)
    await act(async () => { result.current.toggle() })
    act(() => { processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(16000).fill(0.1) } }) })
    await act(async () => { await result.current.stop() })
    expect(onText).toHaveBeenCalledWith('hello there')
    expect(transcribed[0].type).toBe('audio/wav')
    // Nothing recognised, and a failing server.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '  ' }), { status: 200 })))
    await act(async () => { result.current.toggle() })
    act(() => { processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(16000) } }) })
    await act(async () => { await result.current.stop() })
    expect(result.current.hint).toMatch(/Nothing was recognised/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'whisper missing' }), { status: 503 })))
    await act(async () => { result.current.toggle() })
    act(() => { processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(16000) } }) })
    await act(async () => { await result.current.stop() })
    expect(result.current.hint).toMatch(/whisper missing/)
    // Denied microphone.
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => { const error = new Error('no'); error.name = 'NotAllowedError'; throw error }) }, configurable: true })
    await act(async () => { result.current.toggle() })
    expect(result.current.hint).toMatch(/denied/)
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => { throw new Error('busy') }) }, configurable: true })
    await act(async () => { result.current.toggle() })
    expect(result.current.hint).toBe('busy')
    expect(stop).toHaveBeenCalled()
  })
  it('is unavailable when the server says so or cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: false, hint: 'install whisper' }), { status: 200 })))
    const { useVoice } = await import('../src/lib/useVoice.ts')
    const first = renderHook(() => useVoice(vi.fn()))
    await act(async () => {})
    expect(first.result.current.state).toBe('unavailable'); expect(first.result.current.hint).toBe('install whisper')
    act(() => { first.result.current.toggle() })   // no-op while unavailable
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const second = renderHook(() => useVoice(vi.fn()))
    await act(async () => {})
    expect(second.result.current.hint).toMatch(/Could not reach/)
  })
})

describe('the density level that was renamed', () => {
  it('reads a stored "supercompact" as ubercompact, so nobody is dropped back to compact', async () => {
    localStorage.setItem('orchestrator.logDensity', 'supercompact')
    vi.resetModules()
    const { loadDensity } = await import('../src/lib/density.ts')
    expect(loadDensity()).toBe('ubercompact')
    localStorage.setItem('orchestrator.logDensity', 'nonsense')
    expect(loadDensity()).toBe('compact')
  })
})
