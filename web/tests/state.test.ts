import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each test gets a fresh state directory; the module reads the env at import time.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-state-'))
  process.env.ORCHESTRATOR_STATE_DIR = dir
  vi.resetModules()
})

const load = async () => (await import('../server/state.ts'))

describe('loadState', () => {
  it('starts empty with default settings when nothing exists', async () => {
    const { loadState } = await load()
    const state = loadState()
    expect(state.projects).toEqual([])
    expect(state.settings.codexPricing).toEqual({ input: 1.25, cached: 0.125, output: 10 })
    expect(state.settings.worktreeRoot).toBeNull()
  })

  it('fills every missing key from an older state file instead of crashing', async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      projects: [{ id: 'p', name: 'x', path: '/x' }],
      worktrees: [{ id: 'w', projectID: 'p', name: 'main', path: '/x', isMain: true }],
      sessions: [{ id: 's', worktreeID: 'w', title: 't' }],
      settings: { codexPricing: { output: 3 } },
    }))
    const { loadState } = await load()
    const state = loadState()
    // Every project has the "main" folder from the start; older records gain it on load.
    expect(state.projects[0]).toMatchObject({ isGit: expect.any(Boolean), isExpanded: true, worktreeGroups: ['main'] })
    expect(state.worktrees[0]).toMatchObject({ isPinned: false, isArchived: false, group: null })
    expect(state.sessions[0]).toMatchObject({ engine: expect.any(String), totalCostUSD: 0, isPinned: false })
    expect(state.settings.codexPricing).toEqual({ input: 1.25, cached: 0.125, output: 3 })
    expect(state.queuedMessages).toEqual({})
  })

  it('sets a corrupt file aside rather than overwriting it', async () => {
    writeFileSync(join(dir, 'state.json'), '{not json')
    const { loadState } = await load()
    const state = loadState()
    expect(state.projects).toEqual([])
    const files = readdirSync(dir)
    expect(files.some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
    expect(files).not.toContain('state.json')
  })
})

describe('loadState', () => {
  it('gives an old session file the steering mode it never had', async () => {
    // Not a legacy file (it knows per-engine defaults), so the session is taken as it is, mode and all.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ projects: [], worktrees: [], settings: { sessionDefaults: { models: {} } }, sessions: [
      { id: 'old', worktreeID: 'w', title: 'Old', engine: 'claude', accessMode: 'edits' },
    ], lastTurn: { w: { before: 'a', after: 'b', sessionID: 'old', endedAt: 1 } } }))
    const { loadState, DEFAULT_SESSION_SETTINGS } = await load()
    const state = loadState()
    expect(state.sessions[0].steeringMode).toBe(DEFAULT_SESSION_SETTINGS.steeringMode)
    expect(state.lastTurn.w).toEqual({ before: 'a', after: 'b', sessionID: 'old', endedAt: 1 })
  })
})

describe('loadTranscript', () => {
  it('converts Swift 2001-epoch seconds into JS milliseconds', async () => {
    mkdirSync(join(dir, 'transcripts'))
    // 0 seconds after 2001-01-01 == 978307200000 ms after 1970-01-01
    writeFileSync(join(dir, 'transcripts', 's1.json'),
      JSON.stringify([{ id: 'a', role: 'user', text: 'hi', timestamp: 0 }]))
    const { loadTranscript } = await load()
    expect(loadTranscript('s1')[0].timestamp).toBe(978307200000)
  })

  it('keeps what a tool was given and what Claude asked, so a restart does not lose them', async () => {
    mkdirSync(join(dir, 'transcripts'), { recursive: true })
    const permission = { id: 'p1', toolName: 'AskUserQuestion', input: { questions: [] }, toolUseID: 't', status: 'pending' }
    writeFileSync(join(dir, 'transcripts', 's2.json'), JSON.stringify([
      { id: 'a', role: 'tool', text: 'ls', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 1e12 },
      { id: 'b', role: 'permission', text: 'asked', permission, timestamp: 1e12 },
      { id: 'c', role: 'user', text: 'old', timestamp: 1e12 },
    ]))
    const { loadTranscript } = await load()
    const [tool, asked, plain] = loadTranscript('s2')
    expect(tool.toolInput).toEqual({ command: 'ls' })
    expect(asked.permission).toEqual(permission)
    expect(plain.toolInput).toBeUndefined(); expect(plain.permission).toBeUndefined()
  })

  it('returns an empty transcript for a missing or corrupt file', async () => {
    const { loadTranscript } = await load()
    expect(loadTranscript('nope')).toEqual([])
  })
})

describe('isolation guard', () => {
  it('refuses to load against the real state directory under vitest', async () => {
    const saved = process.env.ORCHESTRATOR_STATE_DIR
    delete process.env.ORCHESTRATOR_STATE_DIR
    vi.resetModules()
    try {
      await expect(import('../server/state.ts')).rejects.toThrow(/Refusing to touch the real state directory/)
    } finally {
      process.env.ORCHESTRATOR_STATE_DIR = saved
      vi.resetModules()
    }
  })
})

describe('sessions from older files', () => {
  it('gives a session that never chose a model the strongest one, per engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-nomodel-'))
    process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    const { loadState } = await import('../server/state.ts')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ sessions: [
      { id: 'a', worktreeID: 'w', title: 't', engine: 'claude' }, { id: 'b', worktreeID: 'w', title: 't', engine: 'codex' }, { id: 'c', worktreeID: 'w', title: 't', engine: 'claude', model: 'claude-haiku-4-5-20251001' },
    ] }))
    expect(loadState().sessions.map((session) => session.model)).toEqual(['claude-fable-5', 'gpt-5.5', 'claude-haiku-4-5-20251001'])
  })
})

describe('session defaults from older files', () => {
  it('fills in what an older file lacks: no effort, one engine remembered, a missing engine entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-old-'))
    process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    const { loadState } = await import('../server/state.ts')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { sessionDefaults: { engine: 'claude', model: 'claude-sonnet-5' } } }))
    expect(loadState().settings.sessionDefaults.models).toEqual({ claude: { model: 'claude-sonnet-5', effort: null }, codex: { model: 'gpt-5.5', effort: null } })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { sessionDefaults: { models: { codex: { model: '', effort: undefined }, claude: { model: '' } } } } }))
    expect(loadState().settings.sessionDefaults.models).toEqual({ claude: { model: 'claude-fable-5', effort: null }, codex: { model: 'gpt-5.5', effort: null } })
  })
})

describe('session defaults', () => {
  it('gives every fresh state its own defaults object, so a patch never rewrites the constant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-fresh-'))
    process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    const { loadState, DEFAULT_SESSION_SETTINGS } = await import('../server/state.ts')
    const first = loadState()
    first.settings.sessionDefaults.models.claude = { model: 'claude-haiku-4-5-20251001', effort: 'low' }
    expect(DEFAULT_SESSION_SETTINGS.models.claude.model).toBe('claude-fable-5')
    expect(loadState().settings.sessionDefaults.models.claude.model).toBe('claude-fable-5')
  })
})

describe('a state file from before per-engine defaults', () => {
  it('moves its defaults and every session to queue once: steer was never chosen there, it was the old default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-legacy-'))
    process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    const { loadState, saveState } = await import('../server/state.ts')
    const session = { id: 's', worktreeID: 'w', title: 'old', engine: 'claude', steeringMode: 'steer' }
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ sessions: [session],
      settings: { sessionDefaults: { engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null } } }))
    const migrated = loadState()
    expect(migrated.settings.sessionDefaults.steeringMode).toBe('queue')
    expect(migrated.sessions[0].steeringMode).toBe('queue')
    // Written back in the new shape, steer is a choice and stays one.
    migrated.settings.sessionDefaults.steeringMode = 'steer'; migrated.sessions[0].steeringMode = 'steer'
    saveState(migrated)
    const kept = loadState()
    expect(kept.settings.sessionDefaults.steeringMode).toBe('steer')
    expect(kept.sessions[0].steeringMode).toBe('steer')
  })
})
