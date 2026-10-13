import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let worktreeID = ''
const notices: any[] = []
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => Promise<boolean>, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  ;(globalThis as any).orchestratorNotify = (notice: any) => notices.push(notice)
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = (await json(await h.get('/api/state'))).body
  worktreeID = state.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { delete (globalThis as any).orchestratorNotify; await h.stop() })

const transcript = async (id: string) => (await json(await h.get(`/api/transcript/${id}`))).body as any[]
const sessionRecord = async (id: string) =>
  (await json(await h.get('/api/state'))).body.sessions.find((entry: any) => entry.id === id)
const newSession = async (engine: 'claude' | 'codex') => {
  const created = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
  await h.patch(`/api/session/${created.id}`, { engine })
  return created.id as string
}
const finished = (id: string) => async () => {
  const items = await transcript(id)
  return items.some((item) => item.role === 'info' && /\$|tokens/.test(item.text)) || items.some((item) => item.role === 'error')
}

describe('a claude turn end to end (fake engine)', () => {
  it('streams tools, thinking and text; records cost, tokens, session id; names the session; notifies', async () => {
    const id = await newSession('claude')
    notices.length = 0
    await h.post('/api/attention', { sessionID: null, focused: false })
    expect((await h.post(`/api/session/${id}/send`, { text: 'Summarise the readme for me' })).status).toBe(200)
    await waitFor(finished(id))
    const items = await transcript(id)
    const roles = items.map((item) => item.role)
    expect(roles).toContain('tool'); expect(roles).toContain('thinking'); expect(roles).toContain('assistant')
    expect(items.find((item) => item.role === 'assistant').text).toContain('FAKE-REPLY')
    const tool = items.find((item) => item.role === 'tool')
    expect(tool.toolName).toBe('Bash'); expect(tool.toolOutput).toBe('hi')
    const record = await sessionRecord(id)
    expect(record.title).toBe('Summarise the readme for me')
    expect(record.totalCostUSD).toBeCloseTo(0.25, 6)
    expect(record.inputTokens).toBe(10); expect(record.cachedInputTokens).toBe(105); expect(record.outputTokens).toBe(7)
    expect(record.claudeSessionID).toMatch(/^fake-/)
    expect(notices.some((notice) => /finished/.test(notice.title) && notice.sessionID === id)).toBe(true)
  })

  it('stays quiet when the user is watching that very session', async () => {
    const id = await newSession('claude')
    notices.length = 0
    await h.post('/api/attention', { sessionID: id, focused: true })
    await h.post(`/api/session/${id}/send`, { text: 'quiet please' })
    await waitFor(finished(id))
    expect(notices.some((notice) => notice.sessionID === id)).toBe(false)
    await h.post('/api/attention', { sessionID: null, focused: false })
  })

  it('reports a failed turn as an error item and a failure notice', async () => {
    const id = await newSession('claude')
    notices.length = 0
    await h.post(`/api/session/${id}/send`, { text: 'please FAIL now' })
    await waitFor(finished(id))
    const items = await transcript(id)
    expect(items.some((item) => item.role === 'error' && /401/.test(item.text))).toBe(true)
    expect(notices.some((notice) => /failed/.test(notice.title))).toBe(true)
  })

  it('resumes its own thread on the second message', async () => {
    const id = await newSession('claude')
    await h.post(`/api/session/${id}/send`, { text: 'first' }); await waitFor(finished(id))
    await h.post(`/api/session/${id}/send`, { text: 'second' })
    await waitFor(async () => (await transcript(id)).filter((item) => item.role === 'assistant').length >= 2)
    const replies = (await transcript(id)).filter((item) => item.role === 'assistant')
    expect(replies[0].text).toContain('resume=0'); expect(replies[1].text).toContain('resume=1')
    // Same engine, own thread: no bridge, the prompt is just the message.
    expect(replies[1].text).toContain('prompt=second')
  })
})

describe('engine switch carries context', () => {
  it('the other engine receives the turns it missed, and the same engine does not', async () => {
    const id = await newSession('claude')
    await h.post(`/api/session/${id}/send`, { text: 'remember the word pineapple' }); await waitFor(finished(id))
    await h.patch(`/api/session/${id}`, { engine: 'codex' })
    await h.post(`/api/session/${id}/send`, { text: 'what was the word' })
    await waitFor(async () => (await transcript(id)).some((item) => /CODEX-REPLY/.test(item.text ?? '')))
    const codexReply = (await transcript(id)).find((item) => /CODEX-REPLY/.test(item.text ?? ''))
    // The fake codex echoes the start of its prompt: the bridge comes first.
    expect(codexReply.text).toContain("bridge=1")
    const record = await sessionRecord(id)
    expect(record.codexThreadID).toBe('thread-fake')
    expect(record.totalCostUSD).toBeGreaterThan(0.25)   // codex priced from settings on top of claude's own figure
  })
})

describe('steer, queue, stop, tasks', () => {
  it('steering interrupts the running turn and the new message runs next, with no error for the cut-off turn', async () => {
    const id = await newSession('claude')
    await h.patch(`/api/session/${id}`, { steeringMode: 'steer' })   // delivering on the next turn is the default
    await h.post(`/api/session/${id}/send`, { text: 'SLOW start' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id))
    await h.post(`/api/session/${id}/send`, { text: 'actually do this instead' })
    const items = await transcript(id)
    expect(items.some((item) => item.role === 'info' && /Steering/.test(item.text))).toBe(true)
    await waitFor(async () => (await transcript(id)).some((item) => /FAKE-REPLY.*actually do this/.test(item.text ?? '')), 15000)
    expect((await transcript(id)).filter((item) => item.role === 'error')).toEqual([])
  })

  it('an engine that catches the interrupt and reports it is still not shown as a failure — only a real one is', async () => {
    // The real CLI does not die of SIGINT: it prints a diagnostic result and exits non-zero.
    const { mkdirSync, symlinkSync } = await import('node:fs')
    const engines = join(h.stateDir, 'sigint-engines')
    mkdirSync(engines, { recursive: true })
    symlinkSync(join(process.cwd(), 'tests/fixtures/engines/claude-sigint'), join(engines, 'claude'))
    const saved = process.env.ORCHESTRATOR_ENGINES_DIR
    process.env.ORCHESTRATOR_ENGINES_DIR = engines
    try {
      const id = await newSession('claude')
      await h.post(`/api/session/${id}/send`, { text: 'work for a while' })
      await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id))
      await h.post(`/api/session/${id}/stop`, {})
      await waitFor(async () => !(await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id), 15000)
      const afterStop = await transcript(id)
      expect(afterStop.filter((item) => item.role === 'error')).toEqual([])
      expect(afterStop.some((item) => /ede_diagnostic/.test(item.text ?? ''))).toBe(false)

      // The same diagnostic without an interrupt from us is a genuine failure and says so.
      const other = await newSession('claude')
      await h.post(`/api/session/${other}/send`, { text: 'work for a while' })
      await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === other))
      const pid = (await json(await h.get('/api/tasks'))).body.tasks.find((task: any) => task.sessionID === other).pid
      process.kill(pid, 'SIGINT')   // someone else interrupted it
      await waitFor(async () => (await transcript(other)).some((item) => item.role === 'error'), 15000)
      expect((await transcript(other)).find((item) => item.role === 'error')).toMatchObject({ canRetry: true })
    } finally {
      process.env.ORCHESTRATOR_ENGINES_DIR = saved
    }
  })

  it('queue mode waits for the turn to end, then delivers', async () => {
    const id = await newSession('claude')
    await h.patch(`/api/session/${id}`, { steeringMode: 'queue' })
    await h.post(`/api/session/${id}/send`, { text: 'SLOW first' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id))
    await h.post(`/api/session/${id}/send`, { text: 'queued second' })
    expect((await transcript(id)).some((item) => item.role === 'info' && /Queued/.test(item.text))).toBe(true)
    // Stop the slow turn; the queued message must then run on its own.
    expect((await h.post(`/api/session/${id}/stop`, {})).status).toBe(200)
    await waitFor(async () => (await transcript(id)).some((item) => /FAKE-REPLY.*queued second/.test(item.text ?? '')), 15000)
  })

  it('tasks lists the running agent with its process tree, and can kill a process under it', async () => {
    const id = await newSession('claude')
    await h.post(`/api/session/${id}/send`, { text: 'SLOW hold' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id))
    const task = (await json(await h.get('/api/tasks'))).body.tasks.find((entry: any) => entry.sessionID === id)
    expect(task.engine).toBe('claude'); expect(task.pid).toBeGreaterThan(0)
    expect(task.tools).toEqual([])   // the fake engine reports no in-flight tool while sleeping
    expect((await h.del(`/api/tasks/process/${task.pid}`)).status).toBe(200)
    await waitFor(async () => !(await json(await h.get('/api/tasks'))).body.tasks.some((entry: any) => entry.sessionID === id))
  })

  it('deleting a running session kills its agent', async () => {
    const id = await newSession('claude')
    await h.post(`/api/session/${id}/send`, { text: 'SLOW doomed' })
    await waitFor(async () => (await json(await h.get('/api/tasks'))).body.tasks.some((task: any) => task.sessionID === id))
    const pid = (await json(await h.get('/api/tasks'))).body.tasks.find((entry: any) => entry.sessionID === id).pid
    expect((await h.del(`/api/session/${id}`)).status).toBe(200)
    await waitFor(async () => { try { process.kill(pid, 0); return false } catch { return true } })
  })
})

describe('running record', () => {
  it('mirrors running agents to disk and clears when they finish', async () => {
    const id = await newSession('claude')
    await h.post(`/api/session/${id}/send`, { text: 'SLOW recorded' })
    await waitFor(async () => Object.keys(JSON.parse(readFileSync(join(h.stateDir, 'running.json'), 'utf8'))).includes(id))
    await h.post(`/api/session/${id}/stop`, {})
    await waitFor(async () => !Object.keys(JSON.parse(readFileSync(join(h.stateDir, 'running.json'), 'utf8'))).includes(id))
  })
})
