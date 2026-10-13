import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Harness {
  port: number
  base: string
  stateDir: string
  repo: string
  stop: () => Promise<void>
  get: (path: string, init?: RequestInit) => Promise<Response>
  post: (path: string, body?: unknown) => Promise<Response>
  put: (path: string, body?: unknown) => Promise<Response>
  patch: (path: string, body?: unknown) => Promise<Response>
  del: (path: string) => Promise<Response>
}

/** A git repo with one commit and two branches, so worktree routes have something real. */
export function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'orch-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  mkdirSync(join(repo, 'tests'))
  writeFileSync(join(repo, 'tests', 'test_a.py'), 'def test_a(): pass\n')
  git('add', '-A'); git('commit', '-qm', 'initial')
  git('branch', 'feature/one')
  // A bare "origin" with a pull-request head ref, so PR routes can fetch pull/7/head for real.
  const origin = mkdtempSync(join(tmpdir(), 'orch-origin-'))
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main', 'feature/one')
  git('checkout', '-q', '-b', 'pr-head'); writeFileSync(join(repo, 'src.py'), 'print(7)\n'); git('add', '-A'); git('commit', '-qm', 'pr change')
  git('push', '-q', 'origin', 'pr-head:refs/pull/7/head', 'pr-head:refs/pull/8/head'); git('checkout', '-q', 'main'); git('branch', '-q', '-D', 'pr-head')
  git('branch', '-q', '--set-upstream-to=origin/main', 'main')
  return repo
}

/**
 * Starts the real server in-process on a free port against a throwaway state directory.
 * The state module reads its directory at import time, so it is set before the dynamic import.
 */
export async function startHarness(): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-state-'))
  process.env.ORCHESTRATOR_STATE_DIR = stateDir
  process.env.ORCHESTRATOR_WORKTREE_ROOT = join(stateDir, 'worktrees')
  const { startServer } = await import('../../server/app.ts')
  const started = await startServer({ port: 0, background: false, signals: false })
  const base = `http://127.0.0.1:${started.port}`
  const headers = { 'content-type': 'application/json', Origin: base }
  const send = (method: string) => (path: string, body?: unknown) =>
    fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return {
    port: started.port, base, stateDir, repo: makeRepo(),
    stop: started.stop,
    get: (path, init) => fetch(base + path, { headers: { Origin: base }, ...init }),
    post: send('POST'), put: send('PUT'), patch: send('PATCH'), del: send('DELETE'),
  }
}
