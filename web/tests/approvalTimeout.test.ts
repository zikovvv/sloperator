import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
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
const permissionOf = async (id: string) => (await transcript(id)).find((item) => item.role === 'permission')?.permission
const newSession = async () => {
  const main = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
  const session = await json(await h.post(`/api/worktree/${main}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
})
afterAll(async () => { await h.stop() })

describe('an approval the engine stopped waiting for', () => {
  it('is closed as expired instead of left asking, while every other request keeps waiting', async () => {
    const other = await newSession()
    await h.post(`/api/session/${other}/send`, { text: 'APPROVE this one' })
    await until(() => permissionOf(other), (permission) => permission?.status === 'pending', 'the other request')

    const id = await newSession()
    await h.post(`/api/session/${id}/send`, { text: 'GIVEUP now' })
    await until(() => transcript(id), (items) => items.some((item) => item.role === 'assistant' && item.text === 'GAVE-UP'), 'the turn to go on')
    // Still mid-turn: the turn's own end, which closes every card, has not happened yet.
    expect((await json(await h.get('/api/tasks'))).tasks.some((task: any) => task.sessionID === id)).toBe(true)
    expect(await permissionOf(id)).toMatchObject({ toolName: 'Bash', toolUseID: 't11', status: 'expired' })
    expect((await permissionOf(other)).status).toBe('pending')

    const waiting = await permissionOf(other)
    await h.post(`/api/permission/${waiting.id}`, { behavior: 'deny', message: 'not now' })
    await until(() => transcript(other), (items) => items.some((item) => /HOST-SAID denied: not now/.test(item.text ?? '')), 'the other turn to end')
  })
})
