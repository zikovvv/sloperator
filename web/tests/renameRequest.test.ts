import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
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
const stateOf = async () => json(await h.get('/api/state'))
const sessionOf = async (id: string) => (await stateOf()).sessions.find((entry: any) => entry.id === id)
const transcript = async (id: string) => json(await h.get(`/api/transcript/${id}`)) as Promise<any[]>
const tasks = async () => (await json(await h.get('/api/tasks'))).tasks as any[]
const said = (id: string, pattern: RegExp) =>
  until(() => transcript(id), (items) => items.some((item) => item.role === 'assistant' && pattern.test(item.text)), `a reply matching ${pattern}`)
const newSession = async (worktreeID: string, patch: Record<string, unknown> = {}) => {
  const session = await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue', ...patch })
  return session.id as string
}
const mainID = async () => (await stateOf()).worktrees.find((entry: any) => entry.isMain).id

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await stateOf()).projects[0].id
})
afterAll(async () => { await h.stop() })

describe('renaming a session from the chat', () => {
  it('lets Claude rename it with the title the person gave, kept as theirs, its worktree following', async () => {
    const worktree = (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).worktree
    const id = await newSession(worktree.id)
    await h.post(`/api/session/${id}/send`, { text: 'RETITLE: Payment retries' })
    const items = await said(id, /^Renamed this session to "Payment retries"\.$/)
    expect(items.some((item) => item.role === 'info' && item.text === 'Session renamed to “Payment retries”')).toBe(true)
    expect(await sessionOf(id)).toMatchObject({ title: 'Payment retries', titleIsManual: true })
    expect((await stateOf()).worktrees.find((entry: any) => entry.id === worktree.id).name).toBe('Payment retries')
  })

  it('lets Claude have a name chosen from the conversation, in full access too, over a name typed by hand', async () => {
    const id = await newSession(await mainID(), { accessMode: 'full', title: 'Hand' })
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME RETITLE' })
    await said(id, /^Renamed this session to "Named: RETITLE"\.$/)
    expect(await sessionOf(id)).toMatchObject({ title: 'Named: RETITLE', titleIsManual: false })
  })

  it('tells the agent, and the person, when no name came back, and keeps the name as it was', async () => {
    const id = await newSession(await mainID(), { title: 'Hand' })
    await h.post(`/api/session/${id}/send`, { text: 'RETITLE' })
    const items = await said(id, /Ask the person what to call it/)
    expect(items.some((item) => item.role === 'info' && item.text === 'Could not get a name from Claude for this session.')).toBe(true)
    expect(await sessionOf(id)).toMatchObject({ title: 'Hand', titleIsManual: true })
  })

  it('lets Codex rename it through the same tool', async () => {
    const id = await newSession(await mainID(), { engine: 'codex' })
    await h.post(`/api/session/${id}/send`, { text: 'RETITLE: Codex cleanup' })
    await until(() => transcript(id), (items) => items.some((item) => item.role === 'assistant' && /Codex cleanup/.test(item.text)), 'the codex reply')
    expect(await sessionOf(id)).toMatchObject({ title: 'Codex cleanup', titleIsManual: true })
  })

  it('handles /rename itself for any engine, with or without a title, and never starts a turn for it', async () => {
    const id = await newSession(await mainID(), { engine: 'codex' })
    expect(await json(await h.post(`/api/session/${id}/send`, { text: '/rename   Release checklist' })))
      .toMatchObject({ ok: true, title: 'Release checklist' })
    expect(await sessionOf(id)).toMatchObject({ title: 'Release checklist', titleIsManual: true })
    expect((await tasks()).some((task) => task.sessionID === id)).toBe(false)
    expect((await transcript(id)).map((item) => [item.role, item.text])).toEqual([['info', 'Session renamed to “Release checklist”']])
    const claude = await newSession(await mainID(), { title: 'Hand' })
    await h.post(`/api/session/${claude}/send`, { text: 'NAMEME draft the changelog' })
    await said(claude, /FAKE-REPLY/)
    expect(await json(await h.post(`/api/session/${claude}/send`, { text: '/rename' })))
      .toMatchObject({ ok: true, title: 'Named: draft the changelog', message: 'Renamed this session to "Named: draft the changelog".' })
  })
})
