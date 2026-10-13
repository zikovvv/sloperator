import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let sessionID = ''
const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
const json = async (response: Response) => response.json()
const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const tasks = async () => (await json(await h.get('/api/tasks'))).tasks as any[]

beforeAll(async () => {
  process.env.FAKE_ARGS_LOG = log
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const mainID = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
  sessionID = (await json(await h.post(`/api/worktree/${mainID}/session`, {}))).id
  await h.patch(`/api/session/${sessionID}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue', model: 'claude-sonnet-5', effort: 'low' })
})
afterAll(async () => { await h.stop(); delete process.env.FAKE_ARGS_LOG })

describe('settings changed while a turn runs', () => {
  it('restart the turn with the new model, effort and access, resuming where it was', async () => {
    await h.post(`/api/session/${sessionID}/send`, { text: 'STALL for a while' })
    await until(tasks, (all) => all.some((entry) => entry.sessionID === sessionID), 'the turn to start')
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('--model claude-sonnet-5 --effort low')
    // Long enough for a person to answer an approval: longer than the app's own 15-minute wait.
    expect(lines()[0]).toMatch(/ MCP_TOOL_TIMEOUT=960000$/)
    // Steering is not on the command line: changing it interrupts nothing.
    await h.patch(`/api/session/${sessionID}`, { steeringMode: 'steer' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(lines()).toHaveLength(1)

    await h.patch(`/api/session/${sessionID}`, { model: 'claude-opus-5', effort: 'max', accessMode: 'full' })
    await until(async () => lines(), (all) => all.length === 2, 'the turn to restart')
    const restarted = lines()[1]
    expect(restarted).toContain('--resume fake-')
    expect(restarted).toContain('--model claude-opus-5 --effort max')
    expect(restarted).toContain('--dangerously-skip-permissions')
    expect(restarted).toContain('Continue exactly where you left off')
    const transcript = await json(await h.get(`/api/transcript/${sessionID}`))
    expect(transcript.some((item: any) => item.role === 'info' && /Applying mid-turn: model claude-opus-5, effort max, access full/.test(item.text))).toBe(true)
    // The continuation is the engine's prompt, not a message the person wrote.
    expect(transcript.filter((item: any) => item.role === 'user')).toHaveLength(1)
    // The continuation does not stall, so that turn ends on its own; each later change needs a running turn.
    await until(tasks, (all) => !all.some((entry) => entry.sessionID === sessionID), 'the continuation to end')
    await h.patch(`/api/session/${sessionID}`, { steeringMode: 'queue' })
    await h.post(`/api/session/${sessionID}/send`, { text: 'STALL again' })
    await until(async () => lines(), (all) => all.length === 3, 'the second turn to start')
    // Back to the defaults is a change too.
    await h.patch(`/api/session/${sessionID}`, { model: null, effort: null })
    await until(async () => lines(), (all) => all.length === 4, 'the turn to restart without a model')
    expect(lines()[3]).not.toContain('--model'); expect(lines()[3]).not.toContain('--effort')
    await until(tasks, (all) => !all.some((entry) => entry.sessionID === sessionID), 'that continuation to end')
    // Another engine resumes its own way.
    await h.post(`/api/session/${sessionID}/send`, { text: 'STALL once more' })
    await until(async () => lines(), (all) => all.length === 5, 'the third turn to start')
    await h.patch(`/api/session/${sessionID}`, { engine: 'codex' })
    await until(async () => lines(), (all) => all.length >= 6, 'codex to take over')
    expect(lines()[5]).toContain('exec --json')
    const infos = (await json(await h.get(`/api/transcript/${sessionID}`))).filter((item: any) => item.role === 'info').map((item: any) => item.text)
    expect(infos).toContainEqual(expect.stringMatching(/Applying mid-turn: model default, effort default\./))
    expect(infos).toContainEqual(expect.stringMatching(/Applying mid-turn: engine codex/))
    await h.post(`/api/session/${sessionID}/stop`, {})
    await until(tasks, (all) => !all.some((entry) => entry.sessionID === sessionID), 'the turn to end')
  })

  it('changes nothing about an idle session but its record', async () => {
    await until(tasks, (all) => !all.some((entry) => entry.sessionID === sessionID), 'everything to end')
    const launches = lines().length
    await h.patch(`/api/session/${sessionID}`, { effort: 'high' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(lines()).toHaveLength(launches)
  })
})
