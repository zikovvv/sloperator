import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeArgs, parseClaudeLine } from '../server/engines.ts'
import type { Session } from '../shared/types.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let worktreeID = ''
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
const transcript = async (id: string) => json(await h.get(`/api/transcript/${id}`)) as Promise<any[]>
const activity = async (id: string) => json(await h.get(`/api/session/${id}/activity`))
const tasks = async () => (await json(await h.get('/api/tasks'))).tasks as any[]
const idle = (id: string) => until(tasks, (list) => !list.some((task) => task.sessionID === id), 'the turn to end')
const newSession = async () => {
  const session = await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  worktreeID = (await json(await h.get('/api/state'))).worktrees[0].id
})
afterAll(async () => { await h.stop() })

describe('what the CLI says about background work', () => {
  it('reads the list of what is still running, commands and subagents, each time it changes', () => {
    const line = (tasks: unknown[]) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks })
    expect(parseClaudeLine(line([{ task_id: 'b1', task_type: 'local_bash', description: 'run the suite' }, { task_id: 'a1', task_type: 'local_agent', description: 'review' }])))
      .toEqual([{ type: 'background', tasks: [{ id: 'b1', kind: 'command', description: 'run the suite' }, { id: 'a1', kind: 'agent', description: 'review' }] }])
    expect(parseClaudeLine(line([]))).toEqual([{ type: 'background', tasks: [] }])
    const notice = (status: string) => JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b1', status, summary: 'run the suite' })
    expect(parseClaudeLine(notice('stopped'))).toEqual([{ type: 'info', text: 'Stopped before it finished, in the background: run the suite' }])
    expect(parseClaudeLine(notice('completed'))).toEqual([])
  })

  it('has every Claude turn ask the app before it stops', () => {
    const session = { id: 's', worktreeID: 'w', title: 't', engine: 'claude', accessMode: 'edits', steeringMode: 'queue', model: null, effort: null,
      claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } as Session
    const args = claudeArgs(session, 'hi', null, 'new', 'http://127.0.0.1:1/mcp/tok')
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: "/usr/bin/curl -s -m 5 'http://127.0.0.1:1/mcp/tok/stop'" }] }] },
    })
    expect(claudeArgs(session, 'hi', null, 'new')).not.toContain('--settings')
  })
})

describe('a turn that started work in the background', () => {
  it('is held open while that work runs, shows it while it does, and ends once it is done', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'BGWAIT' })
    // The agent tried to end its turn on "waiting": it was told why not, and what would be lost.
    const held = (await until(() => transcript(id), (items) => items.some((item) => /^HELD: /.test(item.text)), 'the refusal')).find((item) => /^HELD: /.test(item.text))
    expect(held.text).toContain('Still running in the background: run the whole suite (command); review the change (subagent).')
    expect(held.text).toContain('when it ends they are killed')
    // Meanwhile anyone looking can see what is running, in the session and across sessions.
    const during = await activity(id)
    expect(during.running).toBe(true)
    expect(during.background).toEqual([
      { id: 'b1', kind: 'command', description: 'run the whole suite', startedAt: expect.any(Number) },
      { id: 'a1', kind: 'agent', description: 'review the change', startedAt: expect.any(Number) },
    ])
    expect(during.background[0].startedAt).toBeLessThanOrEqual(during.background[1].startedAt)   // the first keeps its start when the list grows
    expect((await tasks()).find((task) => task.sessionID === id).background).toHaveLength(2)
    await idle(id)
    const items = await transcript(id)
    expect(items.some((item) => item.text === 'ENDED after 1 refusals')).toBe(true)
    expect(items.some((item) => /^Stopped before it finished/.test(item.text))).toBe(false)
    expect((await activity(id)).background).toEqual([])
  })

  it('is let go after being told five times, and the chat says what was stopped with it', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'BGLEAVE' })
    await idle(id)
    const items = await transcript(id)
    expect(items.filter((item) => /^HELD: /.test(item.text))).toHaveLength(5)
    expect(items.some((item) => item.text === 'ENDED after 5 refusals')).toBe(true)
    // Only what was cut short is reported; what finished on its own is not.
    expect(items.filter((item) => /^Stopped before it finished/.test(item.text))).toMatchObject([
      { role: 'info', text: 'Stopped before it finished, in the background: run the whole suite' }])
  })

  it('lets a turn with nothing in the background, or no turn at all, stop', async () => {
    expect(await json(await h.get('/mcp/no-such-turn/stop'))).toEqual({})
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'hello' })
    await idle(id)
    expect((await transcript(id)).some((item) => /^HELD: |^Stopped before it finished/.test(item.text))).toBe(false)
  })
})
