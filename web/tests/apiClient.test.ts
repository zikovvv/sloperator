// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

describe('the two pull-request calls the review panel makes', () => {
  it('asks for conversations by branch and posts a line comment as JSON', async () => {
    vi.resetModules()
    const calls: Array<[string, any]> = []
    vi.stubGlobal('fetch', async (url: string, init?: any) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { api } = await import('../src/lib/api.ts')
    await api.conversations('/w/tree', 'feature/a b')
    expect(calls[0][0]).toBe('/api/pr/conversations?path=%2Fw%2Ftree&branch=feature%2Fa%20b')
    await api.postLineComment({ path: '/w', prNumber: 7, commitSHA: 'abc', file: 'a.py', line: 3, body: 'hi' })
    expect(calls[1][0]).toBe('/api/pr/comment')
    await api.activity('s1')
    expect(calls[2][0]).toBe('/api/session/s1/activity')
    await api.answerPermission('r1', { behavior: 'deny', message: 'no' })
    expect(calls[3][0]).toBe('/api/permission/r1')
    expect(JSON.parse(calls[3][1].body)).toEqual({ behavior: 'deny', message: 'no' })
    expect(calls[1][1].method).toBe('POST')
    expect(JSON.parse(calls[1][1].body)).toEqual({ path: '/w', prNumber: 7, commitSHA: 'abc', file: 'a.py', line: 3, body: 'hi' })
    vi.unstubAllGlobals()
  })
})
