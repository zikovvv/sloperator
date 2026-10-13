import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let mainID = ''
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
const diffOf = async (scope: string, path = h.repo) => json(await h.get(`/api/diff?path=${encodeURIComponent(path)}&scope=${scope}`))
const tasks = async () => (await json(await h.get('/api/tasks'))).tasks as any[]
const newSession = async (worktreeID: string) => {
  const session = await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
  return session.id as string
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  mainID = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
  sessionID = await newSession(mainID)
})
afterAll(async () => { await h.stop() })

describe('what the last turn changed', () => {
  it('is its own view: the turn\'s files, not everything uncommitted, and it survives a restart', async () => {
    writeFileSync(join(h.repo, 'README.md'), '# probe, edited by hand before the turn\n')
    expect(await diffOf('turn')).toEqual({ files: [], base: null, turn: null })
    await h.post(`/api/session/${sessionID}/send`, { text: 'please TOUCH a file' })
    const seen = await until(() => diffOf('turn'), (result) => result.turn !== null, 'the turn to be recorded')
    expect(seen.files.map((file: any) => file.path)).toEqual(['touched.txt'])
    expect(seen.turn).toMatchObject({ sessionID, endedAt: expect.any(Number) })
    expect((await diffOf('uncommitted')).files.map((file: any) => file.path).sort()).toEqual(['README.md', 'touched.txt'])
    expect(JSON.parse(readFileSync(join(h.stateDir, 'state.json'), 'utf8')).lastTurn[mainID]).toMatchObject({ sessionID })
    // A path inside the project that is not a worktree has no turn to show.
    expect(await diffOf('turn', join(h.repo, 'tests'))).toEqual({ files: [], base: null, turn: null })
  })

  it('records nothing for a worktree that is gone by the time its turn ends', async () => {
    const created = (await json(await h.post(`/api/project/${(await json(await h.get('/api/state'))).projects[0].id}/worktree`, {}))).worktree
    const id = await newSession(created.id)
    await h.post(`/api/session/${id}/send`, { text: 'STALL' })
    await until(tasks, (all) => all.some((entry) => entry.sessionID === id), 'the stalled turn to start')
    rmSync(created.path, { recursive: true, force: true })
    await h.post(`/api/session/${id}/stop`, {})
    // The turn leaves the task list before its snapshot settles; the state file is written after.
    const saved = await until(async () => JSON.parse(readFileSync(join(h.stateDir, 'state.json'), 'utf8')),
      (state) => Boolean(state.lastSeen[id]), 'the ended turn to be saved')
    expect(saved.lastTurn[created.id]).toBeUndefined()
  })
})
