import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
beforeAll(async () => { h = await startHarness(); await h.post('/api/project', { path: h.repo }) })
afterAll(async () => { await h.stop() })

describe('the diff and tree routes guard their inputs', () => {
  it('refuses a diff and a tree outside the roots, and a raw file with no path', async () => {
    expect((await h.get('/api/diff?path=/etc&scope=uncommitted')).status).toBe(403)
    expect((await h.get('/api/tree?path=/etc&scope=uncommitted')).status).toBe(403)
    expect((await h.get('/api/tree')).status).toBe(403)          // no path is the empty path, which is outside every root
    expect((await h.get('/api/file/raw')).status).toBe(403)
  })

  it('defaults the tree scope to uncommitted and reads a base when one is given', async () => {
    const scoped = await (await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}`)).json()   // no scope, no base
    expect(scoped.files.some((file: any) => file.path === 'README.md')).toBe(true)
    const branched = await (await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=branch&base=main`)).json()
    expect(Array.isArray(branched.files)).toBe(true)
  })
})

describe('the language-server routes tolerate an empty body', () => {
  it('answers definition, references and hover with no body at all', async () => {
    for (const route of ['definition', 'references', 'hover']) {
      const response = await fetch(`${h.base}/api/lsp/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: h.base } })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect('error' in body || 'text' in body || 'locations' in body).toBe(true)
    }
  })
})


describe('an unknown diff scope is refused, not fatal', () => {
  it('answers 400 and the server keeps serving', async () => {
    const bad = await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=bogus`)
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/unknown scope/i)
    expect((await h.get('/api/state')).status).toBe(200)   // not a crashed process
  })
})

describe('pull-request conversations and line comments', () => {
  it('refuses a path outside the roots and a request with no branch', async () => {
    expect((await h.get('/api/pr/conversations?path=/etc&branch=main')).status).toBe(403)
    const noBranch = await h.get(`/api/pr/conversations?path=${encodeURIComponent(h.repo)}`)
    expect(noBranch.status).toBe(400)
    expect((await noBranch.json()).error).toMatch(/branch required/)
  })

  it('answers whatever gh says about the branch rather than throwing', async () => {
    const response = await h.get(`/api/pr/conversations?path=${encodeURIComponent(h.repo)}&branch=main`)
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('ok')
  })

  it('will not post a comment without a file, a whole line and a body', async () => {
    expect((await h.post('/api/pr/comment', { path: '/etc', file: 'a', line: 1, body: 'x' })).status).toBe(403)
    for (const body of [{}, { file: 'a.py' }, { file: 'a.py', line: 0, body: 'x' },
                        { file: 'a.py', line: 1.5, body: 'x' }, { file: 'a.py', line: 3, body: '   ' }]) {
      const refused = await h.post('/api/pr/comment', { path: h.repo, ...body })
      expect(refused.status).toBe(400)
      expect((await refused.json()).error).toMatch(/file, a whole line number and a body/)
    }
  })
})
