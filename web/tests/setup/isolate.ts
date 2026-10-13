import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

/**
 * Every seam the server has, pointed at throwaway places before any test module loads. A test
 * that forgets to isolate itself therefore still cannot reach the user's running instance,
 * their state, their worktrees, their ~/.claude, their binaries, or the network.
 */
const root = mkdtempSync(join(tmpdir(), 'orch-test-'))
for (const folder of ['state', 'worktrees', 'claude-home', 'claude-projects']) mkdirSync(join(root, folder))

export const ISOLATED_ENV = {
  ORCHESTRATOR_STATE_DIR: join(root, 'state'),
  ORCHESTRATOR_WORKTREE_ROOT: join(root, 'worktrees'),
  ORCHESTRATOR_CLAUDE_HOME: join(root, 'claude-home'),
  ORCHESTRATOR_CLAUDE_PROJECTS: join(root, 'claude-projects'),
  ORCHESTRATOR_BIN_DIR: join(process.cwd(), 'tests/fixtures/bin'),
  ORCHESTRATOR_ENGINES_DIR: join(process.cwd(), 'tests/fixtures/engines'),
  // Port 9 (discard) refuses at once: no test ever waits on Anthropic's real endpoint.
  ORCHESTRATOR_USAGE_URL: 'http://127.0.0.1:9/usage',
  ORCHESTRATOR_WHISPER_MODEL: join(root, 'no-model.bin'),
  // A server started without an explicit port must never land on the user's 8787.
  PORT: '0',
}

const sink = () => {}

/** Fills in whatever a test removed; a file's own overrides (its fake server, its collector) stay. */
const restore = () => {
  for (const [key, value] of Object.entries(ISOLATED_ENV)) process.env[key] ??= value
  // No native notification may fire from a test; without a collector, the hook is a sink.
  const scope = globalThis as Record<string, unknown>
  if (typeof scope.orchestratorNotify !== 'function') scope.orchestratorNotify = sink
}

Object.assign(process.env, ISOLATED_ENV)
restore()
afterEach(restore)
