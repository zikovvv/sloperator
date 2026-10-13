import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => response.json()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await pause(100)
  }
}
const stateOf = async () => json(await h.get('/api/state'))
const sessionOf = async (id: string) => (await stateOf()).sessions.find((entry: any) => entry.id === id)
const worktreeOf = async (id: string) => (await stateOf()).worktrees.find((entry: any) => entry.id === id)
const transcript = async (id: string) => json(await h.get(`/api/transcript/${id}`)) as Promise<any[]>
const replied = (id: string, count: number) =>
  until(() => transcript(id), (items) => items.filter((item) => item.role === 'assistant' || item.role === 'error').length >= count, `reply ${count}`)
const newSession = async (worktreeID: string) => {
  const session = await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}
const newWorktree = async () => (await json(await h.post(`/api/project/${projectID}/worktree`, {}))).worktree
const mainID = async () => (await stateOf()).worktrees.find((entry: any) => entry.isMain).id

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await stateOf()).projects[0].id
})
afterAll(async () => { await h.stop() })

describe('session names from Claude', () => {
  it('renames a session from each of its first three messages, and its worktree after it; later only on request', async () => {
    const worktree = await newWorktree()
    const id = await newSession(worktree.id)
    const named = (title: string) => until(async () => [(await sessionOf(id)).title, (await worktreeOf(worktree.id)).name],
      ([session, place]) => session === title && place === title, `the name ${title}`)
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME explore the branch' })
    await named('Named: explore the branch')
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME fix the login test' })
    await named('Named: fix the login test')
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME write the release notes' })
    await named('Named: write the release notes')
    await replied(id, 1)
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME a fourth thing' })
    await until(() => transcript(id), (items) => items.at(-1).role !== 'user', 'the fourth message to be answered')
    await pause(400)
    expect((await sessionOf(id)).title).toBe('Named: write the release notes')
    // Asked for, it is named from the whole conversation, however long.
    expect(await json(await h.post(`/api/session/${id}/name`))).toEqual({ ok: true, title: 'Named: a fourth thing' })
    await named('Named: a fourth thing')
    // A later session is not what its worktree is called after.
    const second = await newSession(worktree.id)
    await h.post(`/api/session/${second}/send`, { text: 'NAMEME the other one' })
    await until(async () => (await sessionOf(second)).title, (title) => title === 'Named: the other one', 'the second name')
    expect((await worktreeOf(worktree.id)).name).toBe('Named: a fourth thing')
  })

  it('never renames a name typed by hand on its own, does when asked, and leaves a worktree named by hand alone', async () => {
    const worktree = await newWorktree()
    const id = await newSession(worktree.id)
    await h.patch(`/api/session/${id}`, { title: 'Hand named' })
    expect(await sessionOf(id)).toMatchObject({ title: 'Hand named', titleIsManual: true })
    expect((await worktreeOf(worktree.id)).name).toBe('Hand named')   // the worktree follows its first session
    await h.post(`/api/session/${id}/send`, { text: 'NAMEME do not rename me' })
    await replied(id, 1)
    await pause(400)
    expect((await sessionOf(id)).title).toBe('Hand named')
    await h.patch(`/api/worktree/${worktree.id}`, { name: 'kept' })
    expect(await json(await h.post(`/api/session/${id}/name`))).toEqual({ ok: true, title: 'Named: do not rename me' })
    expect(await sessionOf(id)).toMatchObject({ title: 'Named: do not rename me', titleIsManual: false })
    expect(await worktreeOf(worktree.id)).toMatchObject({ name: 'kept', nameIsManual: true })
  })

  it('drops an answer nobody wants any more: a newer request, a name typed meanwhile, a deleted session', async () => {
    const main = await mainID()
    const newer = await newSession(main)
    await h.post(`/api/session/${newer}/send`, { text: 'NAMEME NAMEWAIT first idea' })
    await h.post(`/api/session/${newer}/send`, { text: 'NAMEME second idea' })
    await until(async () => (await sessionOf(newer)).title, (title) => title === 'Named: second idea', 'the newer name')
    // The main checkout keeps its own name whatever its sessions are called.
    expect((await worktreeOf(main)).name).not.toContain('Named')

    const typed = await newSession(main)
    await h.post(`/api/session/${typed}/send`, { text: 'NAMEME NAMEWAIT slow one' })
    await h.patch(`/api/session/${typed}`, { title: 'Typed meanwhile' })
    await pause(2000)
    expect((await sessionOf(typed)).title).toBe('Typed meanwhile')

    const gone = await newSession(main)
    await h.post(`/api/session/${gone}/send`, { text: 'NAMEME NAMEWAIT gone soon' })
    expect((await h.del(`/api/session/${gone}`)).status).toBe(200)
    await pause(2000)
    expect((await stateOf()).sessions.some((entry: any) => entry.id === gone)).toBe(false)
  })

  it('says so when no name comes back, and keeps the name it had', async () => {
    const main = await mainID()
    const id = await newSession(main)
    expect((await h.post(`/api/session/${id}/name`)).status).toBe(502)   // nothing asked yet
    await h.post(`/api/session/${id}/send`, { text: 'NAMEBROKEN FAIL here' })   // the turn fails too: no reply to read
    await replied(id, 1)
    const refused = await h.post(`/api/session/${id}/name`)
    expect(refused.status).toBe(502)
    expect((await refused.json()).error).toMatch(/No name came back/)
    expect((await sessionOf(id)).title).toBe('NAMEBROKEN FAIL here')
    const engines = process.env.ORCHESTRATOR_ENGINES_DIR
    process.env.ORCHESTRATOR_ENGINES_DIR = mkdtempSync(join(tmpdir(), 'orch-no-engines-'))
    try { expect((await h.post(`/api/session/${id}/name`)).status).toBe(502) } finally { process.env.ORCHESTRATOR_ENGINES_DIR = engines }
    expect((await h.post('/api/session/nope/name')).status).toBe(404)
  })
})
