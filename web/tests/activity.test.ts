import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeProjectDir } from '../server/agents.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let sessionID = ''
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
const activity = async () => json(await h.get(`/api/session/${sessionID}/activity`))

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = await json(await h.get('/api/state'))
  const worktree = state.worktrees.find((entry: any) => entry.isMain)
  const session = await json(await h.post(`/api/worktree/${worktree.id}/session`, {}))
  sessionID = session.id
  await h.patch(`/api/session/${sessionID}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
})
afterAll(async () => { await h.stop() })

describe('what a session is doing', () => {
  it('is nothing while it idles, and unknown for a session that does not exist', async () => {
    expect(await activity()).toEqual({ running: false, startedAt: null, tools: [], background: [], finished: [], processes: [], agents: [] })
    expect((await h.get('/api/session/nope/activity')).status).toBe(404)
  })

  it('shows the tool in flight and the processes under the agent, which can be killed', async () => {
    await h.post(`/api/session/${sessionID}/send`, { text: 'STALL a while' })
    const busy = await until(activity, (seen) => seen.tools.some((tool: any) => tool.name === 'Task')
      && seen.processes.some((process: any) => /sleep 30/.test(process.command)), 'the stalled tool')
    expect(busy.running).toBe(true)
    expect(busy.startedAt).toBeGreaterThan(0)
    expect(busy.tools[0]).toMatchObject({ name: 'Task', startedAt: expect.any(Number), input: { description: 'sub agent', prompt: 'look around' } })
    expect(busy.finished).toEqual([])
    expect(busy.processes[0]).toMatchObject({ elapsed: expect.any(Number), cpu: expect.any(Number) })
    const sleeper = busy.processes.find((process: any) => /sleep 30/.test(process.command))
    expect(sleeper.depth).toBeGreaterThanOrEqual(1)
    expect((await h.del(`/api/tasks/process/${sleeper.pid}`)).status).toBe(200)
    // Without its sleep the fake engine finishes the turn at once.
    const done = await until(activity, (seen) => !seen.running, 'the turn to end')
    expect(done).toMatchObject({ startedAt: null, tools: [], processes: [] })
    // What the turn ran stays readable after it: the subagent call, with what it returned.
    expect(done.finished.find((tool: any) => tool.name === 'Task')).toMatchObject({ output: 'done', failed: false, endedAt: expect.any(Number) })
    expect(done.finished.find((tool: any) => tool.name === 'Bash')).toMatchObject({ detail: 'echo hi', output: 'hi' })
  })

  it('lists the subagent transcripts Claude Code wrote for the session', async () => {
    const session = (await json(await h.get('/api/state'))).sessions.find((entry: any) => entry.id === sessionID)
    expect(session.claudeSessionID).toMatch(/^fake-/)
    const directory = join(claudeProjectDir(h.repo), session.claudeSessionID, 'subagents')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'agent-one.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'Check the tests' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green.' }] } }),
    ].join('\n') + '\n')
    const seen = await activity()
    expect(seen.agents).toHaveLength(1)
    expect(seen.agents[0]).toMatchObject({ id: 'one', prompt: 'Check the tests', rows: [{ role: 'assistant', text: 'All green.' }], truncated: false })
  })
})
