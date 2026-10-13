import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let sessionID = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const items = async (id = sessionID) => (await json(await h.get(`/api/transcript/${id}`))).body
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = (await json(await h.get('/api/state'))).body
  const worktree = (await json(await h.post(`/api/project/${state.projects[0].id}/worktree`, { name: 'r', branch: 'orch/r' }))).body.worktree
  sessionID = (await json(await h.post(`/api/worktree/${worktree.id}/session`))).body.id
})
afterAll(async () => { await h.stop() })

describe('a failure from the engine can be picked back up', () => {
  it('marks the error retryable and Continue sends the same message again', async () => {
    await h.post(`/api/session/${sessionID}/send`, { text: 'please FAIL loudly' })
    await waitFor(async () => (await items()).some((item: any) => item.role === 'error'))
    const failure = (await items()).find((item: any) => item.role === 'error')
    expect(failure.canRetry).toBe(true)
    expect(failure.text).toMatch(/401/)

    expect((await h.post(`/api/session/${sessionID}/retry`, {})).status).toBe(200)
    await waitFor(async () => (await items()).some((item: any) => item.text === 'Continuing after the failure…'))
    // The same prompt went out again — and failed again — without repeating your message in the log.
    await waitFor(async () => (await items()).filter((item: any) => item.role === 'error').length === 2)
    expect((await items()).filter((item: any) => item.role === 'user')).toHaveLength(1)
  })

  it('refuses to continue a running turn, an unknown session, or one that never sent anything', async () => {
    expect((await h.post('/api/session/nope/retry', {})).status).toBe(404)
    const state = (await json(await h.get('/api/state'))).body
    const empty = (await json(await h.post(`/api/worktree/${state.worktrees.at(-1)!.id}/session`))).body
    const refused = await json(await h.post(`/api/session/${empty.id}/retry`, {}))
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/no message was sent/)


    // A turn that is genuinely still running: the fake engine sleeps on SLOW.
    await h.post(`/api/session/${sessionID}/send`, { text: 'take your time, this is SLOW' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === sessionID))
    expect((await h.post(`/api/session/${sessionID}/retry`, {})).status).toBe(409)
    await h.post(`/api/session/${sessionID}/stop`, {})
  })

  it('does not grow the queue when the message is still waiting, and keeps Continue after a reload', async () => {
    const { mkdirSync } = await import('node:fs')
    const nowhere = join(h.stateDir, 'no-engines-at-all')
    mkdirSync(nowhere, { recursive: true })
    process.env.ORCHESTRATOR_ENGINES_DIR = nowhere
    try {
      const state = (await json(await h.get('/api/state'))).body
      const session = (await json(await h.post(`/api/worktree/${state.worktrees[1].id}/session`))).body
      await h.post(`/api/session/${session.id}/send`, { text: 'do the thing once' })
      await waitFor(async () => (await items(session.id)).some((item: any) => /Could not find/.test(item.text)))
      // The failure happened before the engine ever ran, so the message is still queued.
      for (let attempt = 0; attempt < 3; attempt += 1) await h.post(`/api/session/${session.id}/retry`, {})
      const queued = JSON.parse(readFileSync(join(h.stateDir, 'state.json'), 'utf8')).queuedMessages[session.id]
      expect(queued).toEqual(['do the thing once'])

      // A restart reloads the transcript; the failure keeps its Continue button.
      const { loadTranscript } = await import('../server/state.ts')
      expect(loadTranscript(session.id).find((item) => item.role === 'error')?.canRetry).toBe(true)
    } finally {
      process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
    }
  })

  it('reports a crashed process, and an engine that is not installed, as retryable too', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs')
    const crashing = join(h.stateDir, 'crash-engines')
    mkdirSync(crashing, { recursive: true })
    symlinkSync(join(process.cwd(), 'tests/fixtures/engines/claude-crash'), join(crashing, 'claude'))
    process.env.ORCHESTRATOR_ENGINES_DIR = crashing
    const state = (await json(await h.get('/api/state'))).body
    const fresh = (await json(await h.post(`/api/worktree/${state.worktrees[1].id}/session`))).body
    await h.post(`/api/session/${fresh.id}/send`, { text: 'hello' })
    await waitFor(async () => (await items(fresh.id)).some((item: any) => item.role === 'error'), 8000)
    expect((await items(fresh.id)).filter((item: any) => item.role === 'error').every((item: any) => item.canRetry)).toBe(true)

    process.env.ORCHESTRATOR_ENGINES_DIR = join(h.stateDir, 'no-engines-here')
    const missing = (await json(await h.post(`/api/worktree/${state.worktrees[1].id}/session`))).body
    await h.post(`/api/session/${missing.id}/send`, { text: 'hello' })
    await waitFor(async () => (await items(missing.id)).some((item: any) => /Could not find/.test(item.text)), 8000)
    expect((await items(missing.id)).find((item: any) => /Could not find/.test(item.text)).canRetry).toBe(true)
    process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  })
})
