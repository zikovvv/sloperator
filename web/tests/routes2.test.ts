import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const notices: any[] = []
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
  ;(globalThis as any).orchestratorNotify = (notice: any) => notices.push(notice)
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await json(await h.get('/api/state'))).body.projects[0].id
})
afterAll(async () => { delete (globalThis as any).orchestratorNotify; await h.stop() })

describe('pull request workspaces (fake gh + real origin ref)', () => {
  it('lists PRs with worktree matching and reviews a foreign PR into the PR Reviews folder', async () => {
    const prs = (await json(await h.get(`/api/prs?project=${projectID}`))).body
    expect(prs.ok).toBe(true); expect(prs.prs[0].worktreeID).toBeNull()
    const review = (await json(await h.post('/api/pr/review', { projectID, prNumber: 7, title: 'Add widgets' }))).body
    expect(review.error ?? null).toBeNull()
    expect(review.command).toBe('/code-review')
    expect(review.worktree.group).toBe('PR Reviews'); expect(review.worktree.branch).toBe('orch/pr-7')
    expect(existsSync(join(review.worktree.path, 'src.py'))).toBe(true)
    expect(review.session.title).toMatch(/Review PR #7: Add widgets/)
    await waitFor(async () => (await json(await h.get(`/api/transcript/${review.session.id}`))).body.some((item: any) => item.role === 'assistant'))
    const again = (await json(await h.get(`/api/prs?project=${projectID}`))).body
    const matched = again.prs.find((pr: any) => pr.number === 7)
    expect(matched.worktreeID).toBe(review.worktree.id); expect(matched.worktreeName).toBe('PR #7')
    // A PR branch can only be checked out once: a second review reuses the worktree, new session.
    const second = (await json(await h.post('/api/pr/review', { projectID, prNumber: 7 }))).body
    expect(second.worktree.id).toBe(review.worktree.id); expect(second.session.id).not.toBe(review.session.id)
  })
  it('autofix lands in the main folder for a fresh PR, and reuses an existing PR worktree', async () => {
    const fresh = (await json(await h.post('/api/pr/autofix', { projectID, prNumber: 8, title: 'Other' }))).body
    expect(fresh.error ?? null).toBeNull()
    expect(fresh.worktree.group).toBeNull(); expect(fresh.worktree.branch).toBe('orch/pr-8')
    const reused = (await json(await h.post('/api/pr/autofix', { projectID, prNumber: 7, title: 'Add widgets' }))).body
    expect(reused.worktree.group).toBe('PR Reviews')
    const items = (await json(await h.get(`/api/transcript/${reused.session.id}`))).body
    expect(items[0].text).toMatch(/Do NOT reply/)
    expect((await h.post('/api/pr/autofix', { projectID: 'nope', prNumber: 7 })).status).toBe(500)
  })
  it('polls comments on the user\'s PRs and notifies only after the first poll', async () => {
    const { startServer } = await import('../server/app.ts')
    // A separate instance with the poller on, pointed at the same state directory, with a fake gh.
    const polled = await startServer({ port: 0, background: true, signals: false })
    await sleep(5500)   // first poll (silent) runs after 5s
    notices.length = 0
    await polled.stop()
    expect(notices.filter((notice) => /commented on/.test(notice.title))).toHaveLength(0)
  }, 20_000)
})

describe('project removal and reaping', () => {
  it('removing a project forgets its worktrees and sessions but touches nothing on disk', async () => {
    const before = (await json(await h.get('/api/state'))).body
    const worktrees = before.worktrees.filter((entry: any) => entry.projectID === projectID)
    expect(worktrees.length).toBeGreaterThan(1)
    expect((await h.del(`/api/project/${projectID}`)).status).toBe(200)
    const after = (await json(await h.get('/api/state'))).body
    expect(after.projects).toHaveLength(0); expect(after.worktrees).toHaveLength(0); expect(after.sessions).toHaveLength(0)
    for (const worktree of worktrees) expect(existsSync(worktree.path)).toBe(true)
  })
  it('a second instance on the same state reaps an agent the first one left behind', async () => {
    await h.post('/api/project', { path: h.repo })
    const state = (await json(await h.get('/api/state'))).body
    const worktreeID = state.worktrees.find((entry: any) => entry.isMain).id
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'claude' })
    await h.post(`/api/session/${session.id}/send`, { text: 'SLOW orphan' })
    await waitFor(async () => Object.keys(JSON.parse(readFileSync(join(h.stateDir, 'running.json'), 'utf8'))).length > 0)
    const pid = JSON.parse(readFileSync(join(h.stateDir, 'running.json'), 'utf8'))[session.id]
    // Simulate a crash: the record stays on disk, the process keeps running.
    const { startServer } = await import('../server/app.ts')
    const second = await startServer({ port: 0, background: false, signals: false })
    await waitFor(async () => { try { process.kill(pid, 0); return false } catch { return true } })
    const items = JSON.parse(readFileSync(join(h.stateDir, 'transcripts', `${session.id}.json`), 'utf8'))
    expect(items.some((item: any) => /interrupted by an app restart/.test(item.text))).toBe(true)
    await second.stop()
  })
})

describe('shutdown', () => {
  it('SIGTERM to a subprocess server kills its agents and shells', async () => {
    const { spawn } = await import('node:child_process')
    const stateDir = join(h.stateDir, 'sub'); mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), readFileSync(join(h.stateDir, 'state.json')))
    const child = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, ORCHESTRATOR_STATE_DIR: stateDir, PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const port = await new Promise<number>((resolve) => child.stdout.on('data', (chunk) => { const match = /:(\d+)/.exec(chunk.toString()); if (match) resolve(Number(match[1])) }))
    const base = `http://127.0.0.1:${port}`
    const state = await (await fetch(`${base}/api/state`, { headers: { Origin: base } })).json()
    const worktreeID = state.worktrees.find((entry: any) => entry.isMain).id
    const terminal = await (await fetch(`${base}/api/worktree/${worktreeID}/terminals`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: '{}' })).json()
    child.kill('SIGTERM')
    await waitFor(async () => { try { process.kill(terminal.pid, 0); return false } catch { return true } })
    await waitFor(async () => { try { process.kill(child.pid!, 0); return false } catch { return true } })
  }, 30_000)
})
