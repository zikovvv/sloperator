import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Starts the real server (fake engines, throwaway state, a real temp git repo) and a Vite dev
 * server proxying to it, both on their own ports, so the UI tests click the real page.
 */
export default async function globalSetup() {
  // Everything this run creates under the temp directory, the server's and the browsers' files
  // included, goes in one folder that the teardown removes.
  const runDir = mkdtempSync(join(tmpdir(), 'orch-e2e-run-'))
  process.env.TMPDIR = runDir
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-e2e-state-'))
  const repo = mkdtempSync(join(tmpdir(), 'orch-e2e-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'app.py'), 'def greet(name):\n    return name\n')
  const long = Array.from({ length: 30 }, (_, index) => `line_${index + 1} = ${index + 1}`)
  writeFileSync(join(repo, 'src', 'long.py'), long.join('\n') + '\n')
  mkdirSync(join(repo, 'tests')); writeFileSync(join(repo, 'tests', 'test_app.py'), 'def test_greet(): pass\n')
  git('add', '-A'); git('commit', '-qm', 'initial')
  git('branch', 'feature/login'); git('branch', 'feature/search')
  const origin = mkdtempSync(join(tmpdir(), 'orch-e2e-origin-'))
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main', 'feature/login', 'feature/search')
  git('checkout', '-q', '-b', 'pr-head'); writeFileSync(join(repo, 'src', 'widget.py'), 'x = 7\n'); git('add', '-A'); git('commit', '-qm', 'widgets')
  git('push', '-q', 'origin', 'pr-head:refs/pull/7/head', 'pr-head:refs/pull/8/head'); git('checkout', '-q', 'main'); git('branch', '-q', '-D', 'pr-head')
  git('branch', '-q', '--set-upstream-to=origin/main', 'main')
  // A dirty file so the review panel has something to show.
  writeFileSync(join(repo, 'src', 'long.py'), long.map((line, index) => (index === 24 ? 'line_25 = 250' : line)).join('\n') + '\n')
  writeFileSync(join(repo, 'src', 'app.py'), 'def greet(name):\n    return "hi " + name\n')
  writeFileSync(join(repo, 'tests', 'test_app.py'), 'def test_greet(): assert True\n')
  // Memory + skill files under a private HOME-like tree are not needed: infra reads ~/.claude, which is real.
  const model = join(stateDir, 'ggml.bin'); writeFileSync(model, 'fake')
  // A throwaway ~/.claude so the Infra tab never shows, let alone edits, the user's real files.
  const claudeHome = join(stateDir, 'claude-home')
  mkdirSync(join(claudeHome, 'skills/e2e-skill'), { recursive: true })
  mkdirSync(join(claudeHome, 'projects/-tmp-e2e/memory'), { recursive: true })
  mkdirSync(join(claudeHome, 'hooks'), { recursive: true }); mkdirSync(join(claudeHome, 'commands'), { recursive: true }); mkdirSync(join(claudeHome, 'agents'), { recursive: true })
  writeFileSync(join(claudeHome, 'CLAUDE.md'), '# Global rules for the e2e run\n\nSee [[e2e-memory]] and [local notes](notes.md).\n\n- one\n- two\n\n```sh\necho hi\n```\n')
  writeFileSync(join(claudeHome, 'notes.md'), '# Notes\n\nlinked document\n')
  writeFileSync(join(claudeHome, 'skills/e2e-skill/SKILL.md'), '---\nname: e2e-skill\ndescription: a skill for tests\n---\nbody\n')
  writeFileSync(join(claudeHome, 'commands/e2e-command.md'), 'run things\n')
  writeFileSync(join(claudeHome, 'agents/e2e-agent.md'), '---\nname: e2e-agent\ndescription: an agent for tests\n---\nbody\n')
  writeFileSync(join(claudeHome, 'projects/-tmp-e2e/memory/MEMORY.md'), '- [thing](thing.md) — a memory\n')
  writeFileSync(join(claudeHome, 'projects/-tmp-e2e/memory/thing.md'), '---\nname: thing\n---\nremembered\n')
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }] } }))
  // A throwaway ~/.codex too: one session log, so the Usage tab's Codex side has a plan and a spend to show.
  const codexHome = join(stateDir, 'codex-home')
  const codexLog = join(codexHome, 'sessions', '2026', '01', '01')
  mkdirSync(codexLog, { recursive: true })
  const recent = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(join(codexLog, 'rollout-e2e.jsonl'), [
    { timestamp: recent, type: 'session_meta', payload: { cwd: '/work/e2e-codex-project' } },
    { timestamp: recent, type: 'turn_context', payload: { model: 'gpt-e2e' } },
    { timestamp: recent, type: 'event_msg', payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 3_000_000 }, last_token_usage: { input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      rate_limits: { limit_id: 'codex', plan_type: 'plus',
        primary: { used_percent: 21, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
        secondary: { used_percent: 64, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 50 * 3600 } },
    } },
  ].map((entry) => JSON.stringify(entry)).join('\n'))
  const usageServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ limits: [
      { kind: 'session', group: 'session', percent: 30, resets_at: new Date(Date.now() + 4 * 3600e3).toISOString() },
      { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: new Date(Date.now() + 26 * 3600e3).toISOString() },
      { kind: 'weekly_scoped', group: 'weekly', percent: 56, scope: { model: { display_name: 'Fable' } }, resets_at: new Date(Date.now() + 26 * 3600e3).toISOString() },
    ], extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 15000, utilization: 8, decimal_places: 2 } }))
  })
  await new Promise<void>((resolve) => usageServer.listen(0, '127.0.0.1', resolve))
  const usagePort = (usageServer.address() as any).port

  const env = {
    ...process.env,
    ORCHESTRATOR_STATE_DIR: stateDir,
    ORCHESTRATOR_WORKTREE_ROOT: join(stateDir, 'worktrees'),
    ORCHESTRATOR_ENGINES_DIR: join(process.cwd(), 'tests/fixtures/engines'),
    ORCHESTRATOR_BIN_DIR: join(process.cwd(), 'tests/fixtures/bin'),
    ORCHESTRATOR_USAGE_URL: `http://127.0.0.1:${usagePort}/usage`,
    ORCHESTRATOR_WHISPER_MODEL: model,
    ORCHESTRATOR_CLAUDE_HOME: claudeHome,
    ORCHESTRATOR_CODEX_HOME: codexHome,
    // The folder browser starts here, never in the real home directory.
    ORCHESTRATOR_BROWSE_HOME: stateDir,
    ORCHESTRATOR_CLAUDE_PROJECTS: join(claudeHome, 'projects'),
    PORT: '8797',
  }
  const server = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  server.stderr.on('data', (chunk) => { try { process.stderr.write(`[server] ${chunk}`) } catch { /* detached */ } })
  await waitFor('http://127.0.0.1:8797/api/state', 'server')

  const seed = await fetch('http://127.0.0.1:8797/api/project', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1:8797' },
    body: JSON.stringify({ path: repo }),
  })
  if (!seed.ok) throw new Error(`seeding the project failed: ${seed.status}`)

  const ui = spawn('npx', ['vite', '--port', '5299', '--strictPort'],
    { env: { ...env, API_PORT: '8797', VITE_COVERAGE: process.env.UI_COVERAGE ? '1' : '' }, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
  await waitFor('http://localhost:5299/', 'vite')

  process.env.UI_BASE_URL = 'http://localhost:5299'
  process.env.E2E_REPO = repo
  process.env.E2E_STATE_DIR = stateDir
  ;(globalThis as any).__e2e = { server, ui, stateDir, repo }
  writeFileSync(join(runDir, 'orch-e2e.json'), JSON.stringify({ serverPid: server.pid, uiPid: ui.pid }))
  process.env.E2E_RUN_DIR = runDir
  ;(globalThis as any).__usageServer = usageServer
}

async function waitFor(url: string, name: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url, { headers: { Origin: 'http://localhost:5299' } })).status < 500) return } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${name} did not come up at ${url}`)
}

export function killTree(child: ChildProcess | undefined) {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } } }
}

export function cleanup(stateDir: string, repo: string) {
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
}
