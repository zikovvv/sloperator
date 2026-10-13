import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDiff } from '../server/diff.ts'
import { parseClaudeLine, parseCodexLine } from '../server/engines.ts'
import * as git from '../server/git.ts'
import { isInsideAny } from '../server/guard.ts'
import { makeRepo } from './helpers/server.ts'
import { branchesInUse, createWorktree, moveCurrentWork, deleteWorktree } from '../server/worktrees.ts'
import { openTerminal, closeAllTerminals } from '../server/terminals.ts'
import { titleFromMessage } from '../server/titles.ts'

const gitRun = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const FAKE_BIN = join(process.cwd(), 'tests/fixtures/bin')
afterEach(() => { process.env.ORCHESTRATOR_BIN_DIR = FAKE_BIN })

describe('diff quoting and header edge cases', () => {
  it('decodes escaped quotes, backslashes, a trailing lone backslash, unknown escapes, and header orderings', () => {
    const quoted = 'diff --git "a/q\\"x.py" "b/q\\"x.py"\n--- "a/q\\"x.py"\n+++ "b/q\\"x.py"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(quoted)[0].path).toBe('q"x.py')
    const backslash = 'diff --git "a/b\\\\s.py" "b/b\\\\s.py"\n--- "a/b\\\\s.py"\n+++ "b/b\\\\s.py"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(backslash)[0].path).toBe('b\\s.py')
    const unknown = 'diff --git "a/u\\qz.py" "b/u\\qz.py"\n--- "a/u\\qz.py"\n+++ "b/u\\qz.py"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(unknown)[0].path).toBe('uqz.py')
    const trailing = 'diff --git "a/t\\" "b/t\\"\n--- "a/t\\"\n+++ "b/t\\"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(trailing)[0].path).toBe('t')
    // +++ without the b/ prefix, --- with the a/ prefix on a header that git could not name.
    const noPrefix = 'diff --git a/x b/x\n--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(noPrefix)[0].path).toBe('x')
    // A header git could not name (no " b/" marker): the path comes from the --- line.
    const minusFirst = 'diff --git weird\n--- a/m.py\n+++ b/m.py\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(minusFirst)[0].path).toBe('m.py')
    const minusPlain = 'diff --git weird\n--- m.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n'
    expect(parseDiff(minusPlain)[0].path).toBe('m.py')
    // An empty context line and a line before any hunk that is not a header.
    const empty = 'diff --git a/e b/e\n--- a/e\n+++ b/e\nsome stray line\n@@ -1,2 +1,2 @@\n\n-a\n+b\n'
    const file = parseDiff(empty)[0]
    expect(file.hunks[0].lines.find((line) => line.kind === 'context')?.text).toBe('')
  })
})

describe('engine parser defaults', () => {
  it('handles assistant/user without message content, command without exit code, file_change without changes, mcp completed first, web_search without query', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: {} }))).toEqual([])
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: {} }))).toEqual([])
    const started = new Set<string>()
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution' } }), started).at(-1)).toMatchObject({ failed: false })
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } }), started)[0]).toMatchObject({ detail: '' })
    const mcp = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', status: 'ok' } }), started)
    expect(mcp.map((event) => event.type)).toEqual(['toolStart', 'toolEnd'])
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call' } }), started).map((event) => event.type)).toEqual(['toolEnd'])
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'web_search' } }), started)[0]).toMatchObject({ detail: '' })
  })
})

describe('git service: failures without stderr, detached HEAD, branch ordering', () => {
  it('reports a failure with only a message, defaults the branch when nothing matches, orders the current branch first', async () => {
    const result = await git.gitResult('/definitely/missing/repo', ['status'])
    expect(result.ok).toBe(false); expect(result.stderr.length).toBeGreaterThan(0)
    const repo = makeRepo()
    gitRun(repo, 'checkout', '-q', '--detach')
    gitRun(repo, 'branch', '-D', 'main'); gitRun(repo, 'branch', '-D', 'feature/one')
    gitRun(repo, 'remote', 'remove', 'origin')
    expect(await git.defaultBranch(repo)).toBe('HEAD')   // detached and nothing to pick: whatever HEAD says
    const other = makeRepo()
    gitRun(other, 'checkout', '-q', 'feature/one')
    const listed = await git.branches(other)
    expect(listed[0]).toBe('feature/one')
    const localsOnly = await git.branches(other, false)
    expect(localsOnly.every((name) => !name.startsWith('origin/'))).toBe(true)
  })
})

describe('guard: a path whose parent does not exist', () => {
  it('resolves it under the root rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'g-'))
    expect(isInsideAny(join(root, 'missing-dir', 'file.txt'), [root])).toBe(true)
    expect(isInsideAny('/no/such/parent/at/all.txt', [root])).toBe(false)
  })
})

describe('terminals: env defaults', () => {
  it('falls back to zsh without SHELL and drops empty LC_ variables', async () => {
    const savedShell = process.env.SHELL; delete process.env.SHELL; process.env.LC_ALL = ''
    const handle = openTerminal('w', tmpdir(), 'T')
    expect(handle.process.pid).toBeGreaterThan(0)
    closeAllTerminals()
    process.env.SHELL = savedShell; delete process.env.LC_ALL
  })
})

describe('worktrees: remaining branches', () => {
  it('gitFailure with stdout only and with nothing, ref without a slash, branchesInUse on a bare list, stash apply failure path', async () => {
    const repo = makeRepo()
    process.env.ORCHESTRATOR_WORKTREE_ROOT = mkdtempSync(join(tmpdir(), 'wt-'))
    gitRun(repo, 'remote', 'remove', 'origin')
    await expect(createWorktree({ projectPath: repo, projectName: 'p', name: '', branch: 'nobranch', checkoutExisting: true })).rejects.toThrow(/worktree add failed/)
    const first = await createWorktree({ projectPath: repo, projectName: 'p', name: 'stashy' })
    // Make the apply fail outright: the target worktree folder is removed under us.
    writeFileSync(join(repo, 'README.md'), '# dirty\n')
    const { rmSync } = await import('node:fs'); rmSync(first.path, { recursive: true, force: true })
    const warning = await moveCurrentWork(repo, first.path)
    expect(warning).toMatch(/Could not apply|preserved/)
    expect((await branchesInUse(repo)).length).toBeGreaterThan(0)
    await deleteWorktree(repo, first.path).catch(() => {})
  })
})

describe('titles: unreachable guard is still a guard', () => {
  it('returns a title for filler-only text', () => { expect(titleFromMessage('so')).toBe('So') })
})
