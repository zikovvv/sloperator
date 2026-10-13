import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let worktreeA = ''
let worktreeB = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })

beforeAll(async () => {
  process.env.ORCHESTRATOR_ENGINES_DIR = join(process.cwd(), 'tests/fixtures/engines')
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  const state = (await json(await h.get('/api/state'))).body
  projectID = state.projects[0].id
  worktreeA = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'a', branch: 'orch/a' }))).body.worktree.id
  worktreeB = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'b', branch: 'orch/b' }))).body.worktree.id
})
afterAll(async () => { await h.stop() })

describe('a new session starts with the settings you last chose', () => {
  it('is always Claude on the model last used with Claude, with the access and steering last chosen', async () => {
    const first = (await json(await h.post(`/api/worktree/${worktreeA}/session`))).body
    expect(first).toMatchObject({ engine: 'claude', accessMode: 'edits', steeringMode: 'queue', model: 'claude-fable-5-1', effort: null })

    await h.patch(`/api/session/${first.id}`, { model: 'claude-opus-5', effort: 'high', accessMode: 'full', steeringMode: 'steer' })
    const sibling = (await json(await h.post(`/api/worktree/${worktreeA}/session`))).body
    expect(sibling).toMatchObject({ engine: 'claude', model: 'claude-opus-5', effort: 'high', accessMode: 'full', steeringMode: 'steer' })

    // Switching to Codex lands on Codex's own remembered model — the strongest, never used yet.
    const switched = (await json(await h.patch(`/api/session/${sibling.id}`, { engine: 'codex' }))).body
    expect(switched).toMatchObject({ engine: 'codex', model: 'gpt-5.5', effort: null })
    await h.patch(`/api/session/${sibling.id}`, { model: 'gpt-5.2-codex', effort: 'xhigh' })
    // Back to Claude: Claude's last model, not Codex's.
    const back = (await json(await h.patch(`/api/session/${sibling.id}`, { engine: 'claude' }))).body
    expect(back).toMatchObject({ engine: 'claude', model: 'claude-opus-5', effort: 'high' })

    // The next session anywhere is still Claude, even though Codex was used in between.
    const elsewhere = (await json(await h.post(`/api/worktree/${worktreeB}/session`))).body
    expect(elsewhere).toMatchObject({ engine: 'claude', model: 'claude-opus-5' })
    const fresh = (await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'c', branch: 'orch/c' }))).body
    expect(fresh.session).toMatchObject({ engine: 'claude', model: 'claude-opus-5', accessMode: 'full', steeringMode: 'steer' })

    expect((await json(await h.get('/api/settings'))).body.sessionDefaults).toEqual({
      accessMode: 'full', steeringMode: 'steer',
      models: { claude: { model: 'claude-opus-5', effort: 'high' }, codex: { model: 'gpt-5.2-codex', effort: 'xhigh' } },
    })
    // A patch that touches nothing preference-shaped leaves the defaults alone.
    await h.patch(`/api/session/${fresh.session.id}`, { title: 'Renamed' })
    expect((await json(await h.get('/api/settings'))).body.sessionDefaults.models.claude.model).toBe('claude-opus-5')
  })

  it('survives a restart, and an old file with one engine/model pair is carried over', async () => {
    const { startServer } = await import('../server/app.ts')
    const restarted = await startServer({ port: 0, background: false, signals: false })
    const settings = await (await fetch(`http://127.0.0.1:${restarted.port}/api/settings`,
      { headers: { Origin: `http://127.0.0.1:${restarted.port}` } })).json()
    expect(settings.sessionDefaults.models.claude.model).toBe('claude-opus-5')
    await restarted.stop()

    const { loadState } = await import('../server/state.ts')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(h.stateDir, 'state.json'), JSON.stringify({ settings: { sessionDefaults: { engine: 'codex', model: 'gpt-5.2', effort: 'low', accessMode: 'safe' } } }))
    const old = loadState().settings.sessionDefaults
    expect(old).toEqual({ accessMode: 'safe', steeringMode: 'queue',
      models: { claude: { model: 'claude-fable-5-1', effort: null }, codex: { model: 'gpt-5.2', effort: 'low' } } })
  })
})
