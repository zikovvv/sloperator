import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeAllTerminals, getTerminal } from '../server/terminals.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let mainID = ''
const json = async (response: Response) => response.json()
const printed = async (id: string, text: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getTerminal(id)?.scrollback.includes(text)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  mainID = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { closeAllTerminals(); await h.stop() })

describe('signing an engine in again', () => {
  it("opens a terminal in the worktree running Claude's login, and Codex's", async () => {
    const claude = await json(await h.post(`/api/worktree/${mainID}/terminals`, { login: 'claude' }))
    expect(claude.title).toBe('Sign in to Claude')
    expect(await printed(claude.id, 'FAKE-LOGIN')).toBe(true)
    const codex = await json(await h.post(`/api/worktree/${mainID}/terminals`, { login: 'codex' }))
    expect(codex.title).toBe('Sign in to Codex')
    expect(await printed(codex.id, 'FAKE-CODEX-LOGIN')).toBe(true)
  })

  it('opens a plain terminal for anything else, and says so when the engine is not installed', async () => {
    const plain = await json(await h.post(`/api/worktree/${mainID}/terminals`, { login: 'rm -rf /' }))
    expect(plain.title).toMatch(/^Terminal \d+$/)
    const engines = process.env.ORCHESTRATOR_ENGINES_DIR
    process.env.ORCHESTRATOR_ENGINES_DIR = mkdtempSync(join(tmpdir(), 'orch-no-engines-'))
    try {
      const missing = await h.post(`/api/worktree/${mainID}/terminals`, { login: 'claude' })
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toBe('Could not find `claude` on PATH.')
    } finally { process.env.ORCHESTRATOR_ENGINES_DIR = engines }
  })
})
