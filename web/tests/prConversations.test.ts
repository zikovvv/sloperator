import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const ask = (branch: string) => h.get(`/api/pr/conversations?path=${encodeURIComponent(h.repo)}&branch=${branch}`)
const body = async (response: Response) => response.json()

beforeAll(async () => { h = await startHarness(); await h.post('/api/project', { path: h.repo }) })
afterAll(async () => { await h.stop(); delete process.env.FAKE_GH_MODE })

describe('the conversations on a branch', () => {
  it('anchors a live thread to its line, keeps an outdated one with its snippet, and adds the general comments', async () => {
    delete process.env.FAKE_GH_MODE
    const result = await body(await ask('feature/widgets'))
    expect(result).toMatchObject({ ok: true, number: 7, headSHA: 'deadbee' })
    const byID = (id: string) => result.threads.find((thread: any) => thread.id === id)
    const live = byID('t1'); const stale = byID('t2')
    const general = result.threads.at(-1)   // the pull request's own comments come last
    expect(live).toMatchObject({ path: 'src/app.py', line: 12, outdated: false, resolved: false })
    expect(live.comments[0]).toMatchObject({ author: 'alice', body: 'rename this', avatarURL: 'https://example.com/a.png' })
    // Outdated: GitHub still reports a line, but there is nothing left to point at.
    expect(stale).toMatchObject({ path: 'src/gone.py', line: null, originalLine: 9, outdated: true, resolved: true })
    expect(stale.snippet).toContain('-old')
    // A thread whose comments are all empty is not a conversation at all.
    expect(result.threads.map((thread: any) => thread.id)).not.toContain('t3')
    expect(general).toMatchObject({ path: null, line: null })
    expect(general.comments.map((comment: any) => comment.body)).toEqual(['ship it'])   // the blank one is dropped
  })

  it('survives a thread with no path, an author with no login, and a pull request with nothing on it', async () => {
    delete process.env.FAKE_GH_MODE
    const result = await body(await ask('feature/widgets'))
    const anonymous = result.threads.find((thread: any) => thread.id === 't4')
    expect(anonymous).toMatchObject({ path: null, line: null, originalLine: null })
    expect(anonymous.comments[0]).toMatchObject({ author: 'ghost', avatarURL: null })
    process.env.FAKE_GH_MODE = 'bare-pr'
    const bare = await body(await ask('feature/widgets'))
    expect(bare).toMatchObject({ ok: true, number: 9, headSHA: 'beef', threads: [] })
    delete process.env.FAKE_GH_MODE
  })

  it('says so when the branch has no pull request, and passes gh\'s own failure through', async () => {
    process.env.FAKE_GH_MODE = 'no-pr'
    expect(await body(await ask('feature/widgets'))).toEqual({ ok: false, message: 'No pull request for feature/widgets.' })
    process.env.FAKE_GH_MODE = 'threads-fail'
    const failed = await body(await ask('feature/widgets'))
    expect(failed.ok).toBe(false)
    expect(failed.message).toMatch(/graphql exploded/)
    delete process.env.FAKE_GH_MODE
  })
})

describe('posting a review comment on a line', () => {
  const post = (extra: Record<string, unknown> = {}) =>
    h.post('/api/pr/comment', { path: h.repo, prNumber: 7, commitSHA: 'deadbee', file: 'src/app.py', line: 12, body: 'looks off', ...extra })

  it('sends it to GitHub and answers with the link', async () => {
    delete process.env.FAKE_GH_MODE
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, url: 'https://example.com/pr/7#discussion_r1' })
  })

  it('reports GitHub refusing the line rather than pretending it worked', async () => {
    process.env.FAKE_GH_MODE = 'comment-fail'
    const response = await post()
    expect(response.status).toBe(502)
    const result = await response.json()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not part of the diff/)
    delete process.env.FAKE_GH_MODE
  })
})

describe('the shapes and failures that are easy to get wrong', () => {
  it('takes a thread with no comments block, and reports a failure that printed nothing', async () => {
    delete process.env.FAKE_GH_MODE
    const result = await body(await ask('feature/widgets'))
    // A thread GitHub returns without any comments is not a conversation and is left out.
    expect(result.threads.map((thread: any) => thread.id)).not.toContain('t5')
    process.env.FAKE_GH_MODE = 'threads-silent'
    const silent = await body(await ask('feature/widgets'))
    expect(silent.ok).toBe(false)
    expect(silent.message).toBeTruthy()   // falls back to the error's own message
    delete process.env.FAKE_GH_MODE
  })

  it('posts without a commit sha, answers an empty url, and reports a silent refusal', async () => {
    delete process.env.FAKE_GH_MODE
    const noSHA = await h.post('/api/pr/comment', { path: h.repo, prNumber: 7, file: 'src/app.py', line: 3, body: 'x' })
    expect(noSHA.status).toBe(200)
    process.env.FAKE_GH_MODE = 'comment-bare'
    expect(await (await h.post('/api/pr/comment', { path: h.repo, prNumber: 7, commitSHA: 'a', file: 'a.py', line: 1, body: 'x' })).json())
      .toEqual({ ok: true, url: '' })
    process.env.FAKE_GH_MODE = 'comment-silent'
    const silent = await (await h.post('/api/pr/comment', { path: h.repo, prNumber: 7, commitSHA: 'a', file: 'a.py', line: 1, body: 'x' })).json()
    expect(silent.ok).toBe(false)
    expect(silent.message).toBeTruthy()
    delete process.env.FAKE_GH_MODE
  })

  it('refuses a request with no path and one with no body at all', async () => {
    expect((await h.get('/api/pr/conversations?branch=main')).status).toBe(403)
    const bare = await fetch(`${h.base}/api/pr/comment`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: h.base } })
    expect(bare.status).toBe(403)   // no body means no path, which is outside every root
    expect((await h.post('/api/pr/comment', { path: h.repo, file: 'a.py', line: 2 })).status).toBe(400)
    // A body express never parsed at all, because it was not sent as JSON.
    const unparsed = await fetch(`${h.base}/api/pr/comment`, {
      method: 'POST', headers: { 'content-type': 'text/plain', Origin: h.base }, body: 'not json',
    })
    expect(unparsed.status).toBe(403)
  })
})
