import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let sessionID = ''
const json = async (response: Response) => response.json()
const transcript = async (id = sessionID) => (await json(await h.get(`/api/transcript/${id}`))) as any[]
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const pendingItem = (toolName: string, id = sessionID) => until(() => transcript(id),
  (items) => items.some((item) => item.role === 'permission' && item.permission.toolName === toolName && item.permission.status === 'pending'),
  `a ${toolName} request`).then((items) => items.find((item) => item.role === 'permission' && item.permission.toolName === toolName && item.permission.status === 'pending')!)
const finished = (id: string, turns: number) => until(() => transcript(id),
  (all) => all.filter((entry) => entry.role === 'info' && /\$/.test(entry.text)).length >= turns, `turn ${turns} of ${id} to finish`)
const lastReport = (items: any[]) => items.filter((entry) => entry.role === 'assistant').at(-1).text as string

const newSession = async () => {
  const state = await json(await h.get('/api/state'))
  const worktree = state.worktrees.find((entry: any) => entry.isMain)
  const session = await json(await h.post(`/api/worktree/${worktree.id}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  sessionID = await newSession()
})
afterAll(async () => { await h.stop() })

describe('a question from Claude', () => {
  it('shows up as a permission item, is answered from the API, and the answer reaches the engine', async () => {
    // Listen for who is waiting, the way the sidebar does.
    const asking: string[][] = []
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { Origin: h.base } })
    socket.on('message', (raw) => { const event = JSON.parse(String(raw)); if (event.type === 'running') asking.push(event.asking ?? []) })
    await new Promise((resolve) => socket.on('open', resolve))

    await h.post(`/api/session/${sessionID}/send`, { text: 'please ASK me' })
    const item = await pendingItem('AskUserQuestion')
    expect(item.permission.input.questions[0]).toMatchObject({ question: 'Continue?', header: 'Confirm', multiSelect: false })
    expect(item.permission.input.questions[0].options.map((option: any) => option.label)).toEqual(['Yes', 'No'])
    expect(item.permission.toolUseID).toBe('t9')
    await until(async () => asking, (seen) => seen.some((list) => list.includes(sessionID)), 'the asking signal')

    const answered = await h.post(`/api/permission/${item.permission.id}`, { behavior: 'allow', answers: { 'Continue?': 'Yes' } })
    expect(answered.status).toBe(200)
    const items = await until(transcript, (all) => all.some((entry) => entry.role === 'assistant' && /HOST-SAID/.test(entry.text)), 'the engine to report')
    expect(items.find((entry) => entry.role === 'assistant').text).toContain('answered: {"Continue?": "Yes"}')
    const settled = items.find((entry) => entry.id === item.id)
    expect(settled.permission).toMatchObject({ status: 'allowed', answers: { 'Continue?': 'Yes' } })
    // Once answered, nobody is waiting any more.
    await until(async () => asking, (seen) => seen.length > 1 && !seen.at(-1)!.includes(sessionID), 'the asking signal to clear')
    socket.close()
    // Answering again finds nothing.
    expect((await h.post(`/api/permission/${item.permission.id}`, { behavior: 'allow' })).status).toBe(404)
  })

  it('carries a denial and its reason back to the engine', async () => {
    await until(transcript, (all) => all.some((entry) => entry.role === 'info' && /\$/.test(entry.text)), 'the previous turn to finish')
    await h.post(`/api/session/${sessionID}/send`, { text: 'APPROVE this' })
    const item = await pendingItem('Bash')
    expect(item.permission.input).toEqual({ command: 'python3 -c "print(1)"', description: 'Probe' })
    expect((await h.post(`/api/permission/${item.permission.id}`, { behavior: 'deny', message: 'not now' })).status).toBe(200)
    const items = await until(transcript, (all) => all.filter((entry) => entry.role === 'assistant').length >= 2, 'the second report')
    expect(items.filter((entry) => entry.role === 'assistant').at(-1).text).toContain('denied: not now')
    expect(items.find((entry) => entry.id === item.id).permission).toMatchObject({ status: 'denied', message: 'not now' })
  })

  it('expires what was still waiting when the turn is stopped', async () => {
    await until(transcript, (all) => all.filter((entry) => entry.role === 'info' && /\$/.test(entry.text)).length >= 2, 'the previous turn to finish')
    await h.post(`/api/session/${sessionID}/send`, { text: 'ASK again' })
    const item = await pendingItem('AskUserQuestion')
    await h.post(`/api/session/${sessionID}/stop`, {})
    const items = await until(transcript, (all) => all.find((entry) => entry.id === item.id)?.permission.status === 'expired', 'the request to expire')
    expect(items.find((entry) => entry.id === item.id).permission.status).toBe('expired')
  })
})

describe('the other decisions', () => {
  it('allows a command as proposed, and answers a question with nothing chosen', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'APPROVE this' })
    const bash = await pendingItem('Bash', id)
    expect((await h.post(`/api/permission/${bash.permission.id}`, { behavior: 'allow' })).status).toBe(200)
    expect(lastReport(await finished(id, 1))).toContain('answered: {"command": "python3 -c \\"print(1)\\"", "description": "Probe"}')
    expect((await transcript(id)).find((entry) => entry.id === bash.id).permission).toMatchObject({ status: 'allowed' })
    await h.post(`/api/session/${id}/send`, { text: 'ASK me' })
    const question = await pendingItem('AskUserQuestion', id)
    expect((await h.post(`/api/permission/${question.permission.id}`, { behavior: 'allow' })).status).toBe(200)
    expect(lastReport(await finished(id, 2))).toContain('answered: {"questions": [')
  })

  it('denies with a stock reason when none is given, and shows what Claude Code refused by itself', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'APPROVE this' })
    const bash = await pendingItem('Bash', id)
    expect((await h.post(`/api/permission/${bash.permission.id}`, { behavior: 'deny' })).status).toBe(200)
    expect(lastReport(await finished(id, 1))).toContain('denied: The user denied this.')
    await h.post(`/api/session/${id}/send`, { text: 'REFUSE it' })
    const items = await finished(id, 2)
    expect(items.find((entry) => entry.role === 'info' && /Permission denied/.test(entry.text)).text)
      .toBe('Permission denied by Claude Code for Bash: This command requires approval')
  })

  it('forgets a request whose session was deleted while it asked', async () => {
    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'ASK me' })
    const question = await pendingItem('AskUserQuestion', id)
    expect((await h.del(`/api/session/${id}`)).status).toBe(200)
    // The engine is killed, its turn closes, and the request goes with the session.
    await until(async () => (await h.post(`/api/permission/${question.permission.id}`, { behavior: 'allow' })).status, (status) => status === 404, 'the request to be forgotten')
    expect((await json(await h.get('/api/state'))).sessions.some((entry: any) => entry.id === id)).toBe(false)
  })
})

describe('the host endpoint itself', () => {
  it('answers only the turn that owns the token, and only over POST', async () => {
    expect((await h.post('/mcp/not-a-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404)
    // GET and DELETE are simply not offered, whatever the token — nothing to learn from them.
    expect((await h.get('/mcp/not-a-token')).status).toBe(405)
    expect((await h.del('/mcp/not-a-token')).status).toBe(405)
    expect((await h.post('/api/permission/nothing', { behavior: 'allow' })).status).toBe(404)
  })
})
