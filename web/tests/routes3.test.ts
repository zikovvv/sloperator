import { mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let worktreeID = ''
const notices: any[] = []
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  // A private engines dir whose "claude" is the stalling fake.
  const engines = join(process.env.ORCHESTRATOR_STATE_DIR ?? '/tmp', `engines-${process.pid}`)
  process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
  ;(globalThis as any).orchestratorNotify = (notice: any) => notices.push(notice)
  h = await startHarness()
  mkdirSync(join(h.stateDir, 'engines'))
  symlinkSync(join(process.cwd(), 'tests/fixtures/engines/claude-stall'), join(h.stateDir, 'engines/claude'))
  symlinkSync(join(process.cwd(), 'tests/fixtures/engines/codex'), join(h.stateDir, 'engines/codex'))
  process.env.ORCHESTRATOR_ENGINES_DIR = join(h.stateDir, 'engines')
  void engines
  await h.post('/api/project', { path: h.repo })
  worktreeID = (await json(await h.get('/api/state'))).body.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { delete (globalThis as any).orchestratorNotify; await h.stop() })

describe('tasks with a subagent in flight; deleting a project with a running agent', () => {
  it('shows the Task tool as in flight and kills it when the project is removed', async () => {
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'claude' })
    await h.post(`/api/session/${session.id}/send`, { text: 'spawn a subagent' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.tools.length > 0))
    const task = (await json(await h.get('/api/tasks'))).body.tasks[0]
    expect(task.tools[0]).toMatchObject({ name: 'Task', detail: expect.stringContaining('sub agent') })
    const pid = task.pid
    const projectID = (await json(await h.get('/api/state'))).body.projects[0].id
    expect((await h.del(`/api/project/${projectID}`)).status).toBe(200)
    await waitFor(async () => { try { process.kill(pid, 0); return false } catch { return true } })
    expect(readFileSync(join(h.stateDir, 'running.json'), 'utf8')).toBe('{}')
  })
})

describe('codex "no conversation found" resets the thread id', () => {
  it('drops the stale id and says the next message starts fresh', async () => {
    await h.post('/api/project', { path: h.repo })
    const state = (await json(await h.get('/api/state'))).body
    const main = state.worktrees.find((entry: any) => entry.isMain).id
    const session = (await json(await h.post(`/api/worktree/${main}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'codex' })
    // The fake codex fails with the canonical message when asked to.
    await h.post(`/api/session/${session.id}/send`, { text: 'NOCONV please' })
    await waitFor(async () => (await json(await h.get(`/api/transcript/${session.id}`))).body.some((item: any) => /starts a fresh one/.test(item.text ?? '')))
    const record = (await json(await h.get('/api/state'))).body.sessions.find((entry: any) => entry.id === session.id)
    expect(record.codexThreadID).toBeNull()
  })
})
