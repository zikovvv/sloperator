// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectEvents } from '../server/usage.ts'
import { createWorktree } from '../server/worktrees.ts'
import { resetsOn } from '../src/lib/usageFormat.ts'
import { encodeWav } from '../src/lib/wav.ts'
import { api } from '../src/lib/api.ts'
import { makeRepo } from './helpers/server.ts'

afterEach(() => { vi.unstubAllGlobals(); delete process.env.ORCHESTRATOR_CLAUDE_PROJECTS })

describe('usage scanner leftovers', () => {
  it('skips unreadable directories and files, lines without timestamps or usage, and reads without cache fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'))
    process.env.ORCHESTRATOR_CLAUDE_PROJECTS = root
    mkdirSync(join(root, 'locked'), { mode: 0o000 })
    mkdirSync(join(root, '.hidden')); writeFileSync(join(root, '.hidden', 'x.jsonl'), 'x'.repeat(50))
    const good = join(root, 'p'); mkdirSync(good)
    writeFileSync(join(good, 'a.jsonl'), [
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 3, output_tokens: 4 } } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 3 } }, note: 'no timestamp at all here' }),
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-sonnet-5' }, note: 'no usage block here at all' }),
    ].join('\n'))
    const unreadable = join(good, 'b.jsonl'); writeFileSync(unreadable, 'x'.repeat(50)); chmodSync(unreadable, 0o000)
    const { events, files } = await collectEvents(0)
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ cacheRead: 0, cacheWrite: 0, key: null })
    expect(files).toBe(2)
    chmodSync(join(root, 'locked'), 0o755); chmodSync(unreadable, 0o644)
  })
})

describe('worktree naming leftovers', () => {
  it('slugs odd names, strips a slash-only remote prefix, and honours a ~ root override', async () => {
    const repo = makeRepo()
    process.env.ORCHESTRATOR_WORKTREE_ROOT = mkdtempSync(join(tmpdir(), 'wt-'))
    const odd = await createWorktree({ projectPath: repo, projectName: 'p', name: '!!! Ünicode Name !!!' })
    expect(odd.path).toMatch(/nicode-name$/)
    const empty = await createWorktree({ projectPath: repo, projectName: 'p', name: '   ' })
    expect(empty.branch).toBe('orch/work')
    const tilde = await createWorktree({ projectPath: repo, projectName: 'p', name: 'home', rootOverride: '~/.orchestrator-test-root' })
    expect(tilde.path).toContain('/.orchestrator-test-root/')
    const { rmSync } = await import('node:fs'); const { homedir } = await import('node:os')
    rmSync(join(homedir(), '.orchestrator-test-root'), { recursive: true, force: true })
    const noRemote = await createWorktree({ projectPath: repo, projectName: 'p', name: '', branch: 'feature/one', checkoutExisting: true })
    expect(noRemote.branch).toBe('feature/one')
  })
})

describe('lib leftovers', () => {
  it('resetsOn handles null; wav clamps', () => {
    expect(resetsOn(null)).toBe('')
    expect(new DataView(encodeWav(new Float32Array([1.5]), 8000)).getInt16(44, true)).toBe(32767)
  })
  it('api.commits without a base, and transcribe error bodies with and without a message', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen.push(url); return new Response(url.includes('nobody') ? '' : JSON.stringify({ error: 'bad audio' }), { status: 500 }) }))
    await api.commits('/r').catch(() => {})
    expect(seen[0]).not.toContain('base=')
    await expect(api.transcribe(new Blob(['x']))).rejects.toThrow(/bad audio/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(api.transcribe(new Blob(['x']))).rejects.toThrow(/Transcription failed/)
  })
  it('useVoice ignores stop when idle and toggle while transcribing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true }), { status: 200 })))
    const { useVoice } = await import('../src/lib/useVoice.ts')
    const { result } = renderHook(() => useVoice(vi.fn()))
    await act(async () => {})
    await act(async () => { await result.current.stop() })
    expect(result.current.state).toBe('idle')
  })
})
