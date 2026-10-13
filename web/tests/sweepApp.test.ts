import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let mainID = ''
const json = async (response: Response) => response.json()
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const transcript = async (id: string) => (await json(await h.get(`/api/transcript/${id}`))) as any[]
const finished = (id: string, turns = 1) => until(() => transcript(id),
  (all) => all.filter((entry) => entry.role === 'info' && /\$/.test(entry.text)).length >= turns, `turn ${turns} of ${id}`)
const tasks = async () => (await json(await h.get('/api/tasks'))).tasks as any[]
const sessionRecord = async (id: string) => (await json(await h.get('/api/state'))).sessions.find((entry: any) => entry.id === id)
const newSession = async (engine: 'claude' | 'codex' = 'claude') => {
  const session = await json(await h.post(`/api/worktree/${mainID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine, accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}
const notices = () => {
  const seen: any[] = []
  const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { Origin: h.base } })
  socket.on('message', (raw) => { const event = JSON.parse(String(raw)); if (event.type === 'notify') seen.push(event.notice) })
  return { seen, ready: new Promise<void>((resolve) => socket.on('open', () => resolve())), socket }
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = await json(await h.get('/api/state'))
  projectID = state.projects[0].id
  mainID = state.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { await h.stop() })

describe('the pieces on their own', () => {
  it('looks for engines on PATH when no folder is pinned, and logs what background work drops', async () => {
    const { enginePaths, reportFailure, defaultPort } = await import('../server/app.ts')
    const savedPort = process.env.PORT
    try {
      process.env.PORT = '4242'; expect(defaultPort()).toBe(4242)
      delete process.env.PORT; expect(defaultPort()).toBe(8787)
    } finally { process.env.PORT = savedPort }
    const savedDir = process.env.ORCHESTRATOR_ENGINES_DIR
    const savedPath = process.env.PATH
    try {
      delete process.env.ORCHESTRATOR_ENGINES_DIR
      expect(enginePaths().length).toBeGreaterThan(0)
      delete process.env.PATH
      expect(Array.isArray(enginePaths())).toBe(true)
    } finally {
      process.env.ORCHESTRATOR_ENGINES_DIR = savedDir
      process.env.PATH = savedPath
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportFailure(new Error('boom'))
    expect(error).toHaveBeenCalledWith('[orchestrator]', expect.any(Error))
    error.mockRestore()
  })
})

describe('engines that misbehave', () => {
  it('says when an engine cannot start, and picks the message up again on retry', async () => {
    const id = await newSession()
    const broken = mkdtempSync(join(tmpdir(), 'orch-broken-engine-'))
    writeFileSync(join(broken, 'claude'), '#!/bin/bash\n', { mode: 0o644 })   // present, but not executable
    const saved = process.env.ORCHESTRATOR_ENGINES_DIR
    process.env.ORCHESTRATOR_ENGINES_DIR = broken
    try {
      await h.post(`/api/session/${id}/send`, { text: 'hello' })
      const items = await until(() => transcript(id), (all) => all.some((entry) => entry.role === 'error'), 'the start failure')
      expect(items.find((entry) => entry.role === 'error').text).toMatch(/^Could not start claude: spawn .*EACCES/)
      expect(await tasks()).toEqual([])
    } finally { process.env.ORCHESTRATOR_ENGINES_DIR = saved }
    // The message never left the queue, so a retry does not add it twice.
    expect((await h.post(`/api/session/${id}/retry`, {})).status).toBe(200)
    const done = await finished(id)
    expect(done.filter((entry) => entry.role === 'user')).toHaveLength(1)
    expect(done.find((entry) => entry.role === 'assistant').text).toContain('FAKE-REPLY')
  })

  it('forgets a Claude session id the CLI no longer knows, and reports a silent crash by its status', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'first' })
    await finished(id)
    expect((await sessionRecord(id)).claudeSessionID).toMatch(/^fake-/)
    await h.post(`/api/session/${id}/send`, { text: 'NOCONV please' })
    await until(() => sessionRecord(id), (session) => session.claudeSessionID === null, 'the session id to be dropped')
    await until(() => transcript(id), (all) => all.filter((entry) => entry.role === 'error').length >= 1, 'the failure')
    const other = await newSession()
    await h.post(`/api/session/${other}/send`, { text: 'CRASHQUIET' })
    const items = await until(() => transcript(other), (all) => all.some((entry) => entry.role === 'error'), 'the crash')
    expect(items.find((entry) => entry.role === 'error').text).toBe('Process exited with status 3')
  })

  it('shows what Codex did without words or output, and says when it finished', async () => {
    const watcher = notices(); await watcher.ready
    const id = await newSession('codex')
    await h.post(`/api/session/${id}/send`, { text: 'EDITS then SILENT' })
    // The fake codex is near-instant, so wait on the transcript it leaves, not the ephemeral task row.
    const items = await until(() => transcript(id), (all) => all.some((entry) => entry.role === 'info' && /token/.test(entry.text)), 'the codex turn to finish')
    expect(items.find((entry) => entry.role === 'tool' && entry.toolName === 'edit')).toMatchObject({ text: 'update a.py', toolOutput: '' })
    expect(items.some((entry) => entry.role === 'assistant')).toBe(false)
    await until(async () => watcher.seen, (seen) => seen.some((notice) => notice.body === '20 in · 3 out tokens'), 'the finished notice')
    watcher.socket.close()
  })

  it('drops tool output that arrives after its session was deleted', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'DEAFEND' })
    await until(() => transcript(id), (all) => all.some((entry) => entry.role === 'tool'), 'the tool call')
    expect((await h.del(`/api/session/${id}`)).status).toBe(200)
    await sleep(1500)
    expect((await h.get('/api/state')).status).toBe(200)
    expect(await transcript(id)).toEqual([])
  })

  it('lets the agent process itself be killed from the tasks list', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'STALL' })
    const [task] = await until(tasks, (all) => all.some((task) => task.sessionID === id && task.processes.length > 0), 'the stalled agent')
    expect(task.title).toBeTruthy(); expect(task.worktree).toBeTruthy()
    expect((await h.del(`/api/tasks/process/${task.pid}`)).status).toBe(200)
    await until(tasks, (all) => !all.some((task) => task.sessionID === id), 'the agent to be gone')
  })
})

describe('sessions and their words', () => {
  it('keeps the default title for a message that is only code, and forgets a cleared model', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: '```py\nx = 1\n```' })
    await finished(id)
    expect((await sessionRecord(id)).title).toBe('New session')
    await h.patch(`/api/session/${id}`, { model: 'fable-5' })
    expect((await json(await h.get('/api/settings'))).sessionDefaults.models.claude).toMatchObject({ model: 'fable-5' })
    await h.patch(`/api/session/${id}`, { model: null })
    expect((await json(await h.get('/api/settings'))).sessionDefaults.models.claude).toMatchObject({ model: 'fable-5' })
  })

  it('logs requests that carry no user agent, and refuses a body that is too large', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/permission/nothing',
        headers: { 'content-type': 'application/json', Origin: h.base, 'content-length': 2 } }, (response) => { response.resume(); resolve(response.statusCode ?? 0) })
      request.on('error', reject)
      request.end('{}')
    })
    expect(status).toBe(404)
    const huge = JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024) })
    expect((await h.post('/api/permission/nothing', JSON.parse(huge))).status).toBe(413)
  })
})

describe('worktrees and files', () => {
  it('shows a vanished worktree with no branch, and reports a move or a delete git refuses', async () => {
    const created = (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).worktree
    rmSync(created.path, { recursive: true, force: true })
    const worktree = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.id === created.id)
    expect(worktree.branch).toBeNull()
    // Back as a plain folder git no longer owns, in a folder nothing can be moved out of or deleted from.
    mkdirSync(created.path, { recursive: true }); writeFileSync(join(created.path, 'keep.txt'), 'x')
    chmodSync(dirname(created.path), 0o555)
    try {
      expect((await h.post(`/api/worktree/${created.id}/move`, { group: 'review' })).status).toBe(500)
      expect((await h.del(`/api/worktree/${created.id}`)).status).toBe(500)
    } finally { chmodSync(dirname(created.path), 0o755) }
    expect((await h.del(`/api/worktree/${created.id}?keepOnDisk=1`)).status).toBe(200)
    expect((await h.post('/api/project/nope/worktree', {})).status).toBe(404)
    // A move with no group goes to the main folder; a rename with no name is refused.
    const other = (await json(await h.post(`/api/project/${projectID}/worktree`, { group: 'review' }))).worktree
    expect((await h.post(`/api/worktree/${other.id}/move`, {})).status).toBe(200)
    expect((await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.id === other.id).group).toBeNull()
    expect((await h.patch(`/api/project/${projectID}/group/review`, {})).status).toBe(400)
  })

  it('reads the main checkout, the default diff scope, and refuses a file it cannot read', async () => {
    const info = await json(await h.get(`/api/worktree/${mainID}/info`))
    expect(typeof info.changedFiles).toBe('number')
    expect((await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}`)).status).toBe(200)
    const secret = join(h.repo, 'secret.png')
    writeFileSync(secret, 'not really an image')
    chmodSync(secret, 0o000)
    try {
      expect((await h.get(`/api/file/raw?path=${encodeURIComponent(secret)}`)).status).toBe(404)
    } finally { chmodSync(secret, 0o644) }
  })
})

describe('GitHub', () => {
  it('polls on request, sums up a flood of comments, and copes with being signed out', async () => {
    const watcher = notices(); await watcher.ready
    expect((await h.post('/api/github/poll', {})).status).toBe(200)   // the first look only records what is there
    process.env.FAKE_GH_MODE = 'many-comments'
    try {
      expect((await h.post('/api/github/poll', {})).status).toBe(200)
      await until(async () => watcher.seen, (seen) => seen.some((notice) => /^2 more comments$/.test(notice.title)), 'the summary notice')
      expect(watcher.seen.filter((notice) => /commented on #8/.test(notice.title))).toHaveLength(5)
      process.env.FAKE_GH_MODE = 'unauth'
      expect((await h.post('/api/github/poll', {})).status).toBe(200)
      expect((await json(await h.get(`/api/prs?project=${projectID}&refresh=1`))).ok).toBe(false)
    } finally { delete process.env.FAKE_GH_MODE }
    watcher.socket.close()
  })
})
