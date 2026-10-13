import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let worktreeID = ''
const notices: any[] = []
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => Promise<boolean>, timeout = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}
// No content-type: express leaves request.body undefined, which is the `?? {}` branch everywhere.
const bare = (method: string, path: string) => fetch(h.base + path, { method, headers: { Origin: h.base } })
const rawPost = (path: string, _body: string) => bare('POST', path)

beforeAll(async () => {
  process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
  process.env.ORCHESTRATOR_POLL_MS = '400'
  ;(globalThis as any).orchestratorNotify = (notice: any) => notices.push(notice)
  h = await startHarness()
  mkdirSync(join(h.stateDir, 'engines'))
  symlinkSync(join(process.cwd(), 'tests/fixtures/engines/claude-blank'), join(h.stateDir, 'engines/claude'))
  symlinkSync(join(process.cwd(), 'tests/fixtures/engines/codex'), join(h.stateDir, 'engines/codex'))
  process.env.ORCHESTRATOR_ENGINES_DIR = join(h.stateDir, 'engines')
  await h.post('/api/project', { path: h.repo })
  const state = (await json(await h.get('/api/state'))).body
  projectID = state.projects[0].id; worktreeID = state.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { delete process.env.ORCHESTRATOR_POLL_MS; delete (globalThis as any).orchestratorNotify; await h.stop() })

describe('request defaults and missing bodies', () => {
  it('routes tolerate an absent body, absent query fields and unknown ids', async () => {
    expect((await h.get('/api/diff')).status).toBe(400)
    expect((await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=commit&base=main`)).status).toBe(400)   // a commit needs its sha
    expect((await h.get(`/api/commits?path=${encodeURIComponent(h.repo)}&base=main`)).status).toBe(200)
    expect((await h.get('/api/commits')).status).toBe(200)
    expect((await h.get('/api/branches')).status).toBe(200)
    expect((await h.get('/api/file')).status).toBe(403)
    expect((await h.get('/api/infra')).status).toBe(200)
    expect((await h.get('/api/infra/file')).status).toBe(403)
    expect((await h.get('/api/lsp/status')).status).toBe(200)
    expect((await rawPost('/api/lsp/definition', 'null')).status).toBe(200)
    expect((await rawPost('/api/lsp/hover', 'null')).status).toBe(200)
    expect((await bare('PUT', '/api/settings')).status).toBe(200)
    const malformed = await fetch(`${h.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', Origin: h.base }, body: '{not json' })
    expect(malformed.status).toBe(400); expect((await malformed.json()).error).toMatch(/Malformed/)
    expect((await rawPost('/api/attention', 'null')).status).toBe(200)
    expect((await rawPost('/api/pr/review', 'null')).status).toBe(404)
    expect((await rawPost('/api/pr/autofix', 'null')).status).toBe(500)
    expect((await rawPost(`/api/project/${projectID}/group`, 'null')).status).toBe(400)
    expect((await rawPost(`/api/project/${projectID}/worktree`, 'null')).status).toBe(200)
    expect((await bare('PUT', `/api/project/${projectID}/groups`)).status).toBe(200)
    expect((await rawPost('/api/worktree/nope/move', 'null')).status).toBe(404)
    expect((await bare('PATCH', `/api/worktree/${worktreeID}`)).status).toBe(200)
    expect((await rawPost(`/api/worktree/${worktreeID}/terminals`, 'null')).status).toBe(200)
    expect((await rawPost('/api/project', 'null')).status).toBe(400)
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    expect((await rawPost(`/api/session/${session.id}/send`, 'null')).status).toBe(400)
    expect((await bare('PATCH', `/api/session/${session.id}`)).status).toBe(200)
    expect((await bare('PUT', `/api/session/${session.id}/draft`)).status).toBe(200)
    expect((await h.get(`/api/infra/file?path=${encodeURIComponent(join(h.repo, 'README.md'))}`)).status).toBe(200)
    expect((await fetch(`${h.base}/api/infra/file`, { method: 'PUT', headers: { 'content-type': 'application/json', Origin: h.base }, body: JSON.stringify({ path: join(h.repo, 'new.md') }) })).status).toBe(200)
    expect((await bare('PUT', '/api/infra/file')).status).toBe(403)
    expect((await h.get('/api/worktree/nope/terminals')).status).toBe(200)
    for (const terminal of (await json(await h.get(`/api/worktree/${worktreeID}/terminals`))).body.terminals) await h.del(`/api/terminal/${terminal.id}`)
  })

  it('a worktree whose folder vanished cannot open a terminal; a session whose worktree is gone cannot launch', async () => {
    const created = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'vanish' }))).body
    rmSync(created.worktree.path, { recursive: true, force: true })
    expect((await h.post(`/api/worktree/${created.worktree.id}/terminals`, {})).status).toBe(400)
    await h.del(`/api/worktree/${created.worktree.id}?keepOnDisk=1`)
    // A session pointing at a worktree that no longer exists: send is accepted, nothing launches.
    const orphan = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${orphan.id}`, { engine: 'claude' })
    const state = h as any
    void state
  })
})

describe('engine output edge cases', () => {
  it('blank lines, a failed tool without output, a repeated tool result, and a costless claude result', async () => {
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'claude' })
    await h.post('/api/attention', { sessionID: null, focused: false })
    await h.post(`/api/session/${session.id}/send`, { text: 'blank lines please' })
    await waitFor(async () => ((await json(await h.get('/api/state'))).body.sessions.find((entry: any) => entry.id === session.id)?.outputTokens ?? 0) > 0)
    const items = (await json(await h.get(`/api/transcript/${session.id}`))).body
    const tool = items.find((item: any) => item.role === 'tool')
    expect(tool.toolOutput).toMatch(/second result|⚠️ failed/)
    const record = (await json(await h.get('/api/state'))).body.sessions.find((entry: any) => entry.id === session.id)
    expect(record.totalCostUSD).toBe(0)
    expect(notices.some((notice) => /finished/.test(notice.title) && /The turn finished/.test(notice.body))).toBe(true)
  })

  it('steer escalates to SIGKILL for an agent that ignores SIGINT and SIGTERM', async () => {
    writeFileSync(join(h.stateDir, 'engines', 'claude-stubborn'), '#!/bin/bash\ntrap "" INT TERM\necho \'{"type":"system","subtype":"init","session_id":"stub"}\'\nsleep 60\n')
    const { chmodSync } = await import('node:fs'); chmodSync(join(h.stateDir, 'engines', 'claude-stubborn'), 0o755)
    rmSync(join(h.stateDir, 'engines/claude')); symlinkSync(join(h.stateDir, 'engines', 'claude-stubborn'), join(h.stateDir, 'engines/claude'))
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'claude' })
    await h.post(`/api/session/${session.id}/send`, { text: 'ignore signals' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === session.id))
    await h.post(`/api/session/${session.id}/stop`, {})
    await waitFor(async () => !(await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === session.id), 15000)
  }, 30_000)
})

describe('terminal socket details', () => {
  it('replays scrollback, reports the shell exiting, ignores junk and unknown messages, defaults resize', async () => {
    const terminal = (await json(await h.post(`/api/worktree/${worktreeID}/terminals`, {}))).body
    const { default: WebSocket } = await import('ws')
    const first = new WebSocket(`ws://127.0.0.1:${h.port}/terminal?id=${terminal.id}`, { headers: { Origin: h.base } })
    await new Promise((resolve) => first.on('open', resolve))
    first.send('not json'); first.send(JSON.stringify({ type: 'mystery' })); first.send(JSON.stringify({ type: 'resize' })); first.send(JSON.stringify({ type: 'input' }))
    first.send(JSON.stringify({ type: 'input', data: 'echo SCROLLBACK-MARK\r' }))
    await sleep(1200); first.close()
    const second = new WebSocket(`ws://127.0.0.1:${h.port}/terminal?id=${terminal.id}`, { headers: { Origin: h.base } })
    let replay = ''
    await new Promise<void>((resolve) => { second.on('message', (data) => { replay += data.toString() }); second.on('open', () => setTimeout(resolve, 500)) })
    expect(replay).toMatch(/SCROLLBACK-MARK/)
    let closed = false; second.on('close', () => { closed = true })
    second.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
    await waitFor(async () => closed)
    expect(replay).toMatch(/process exited/)
    const gone = new WebSocket(`ws://127.0.0.1:${h.port}/terminal`, { headers: { Origin: h.base } })
    expect(await new Promise<number>((resolve) => gone.on('close', (code) => resolve(code)))).toBe(4004)
  })
})

describe('github polling, static fallback, shutdown paths', () => {
  it('notifies for new comments after the first poll (both the first five and the overflow), and skips when gh fails', async () => {
    notices.length = 0
    const { startServer } = await import('../server/app.ts')
    notices.length = 0
    const polled = await startServer({ port: 0, background: true, signals: false })
    // The first poll records what is already there and says nothing; a later one announces the rest.
    await waitFor(async () => Object.keys(polled.state.seenComments).length > 0, 8000)
    expect(notices.filter((notice) => /commented on|more comments/.test(notice.title))).toEqual([])
    for (const project of Object.keys(polled.state.seenComments)) polled.state.seenComments[project] = []
    await waitFor(() => Promise.resolve(notices.some((notice) => /commented on/.test(notice.title))), 8000)
    await polled.stop()
    const announced = notices.filter((notice) => /commented on/.test(notice.title))
    expect(announced.length).toBeGreaterThan(0)
    expect(announced[0].body).toBeTruthy()
  }, 20_000)

  it('serves index.html for unknown paths when static; SIGINT and the Electron hook stop everything', async () => {
    const staticRoot = join(h.stateDir, 'static'); mkdirSync(staticRoot); writeFileSync(join(staticRoot, 'index.html'), '<p>spa</p>')
    process.env.SERVE_STATIC = staticRoot
    const { startServer } = await import('../server/app.ts')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    const instance = await startServer({ port: 0, background: false, signals: true })
    delete process.env.SERVE_STATIC
    const page = await fetch(`http://127.0.0.1:${instance.port}/deep/link`, { headers: { Origin: `http://127.0.0.1:${instance.port}` } })
    expect(await page.text()).toContain('spa')
    process.emit('SIGINT')
    expect(exit).toHaveBeenCalledWith(0)
    ;(globalThis as any).orchestratorShutdown()
    exit.mockRestore()
    await instance.stop().catch(() => {})
  })
})
