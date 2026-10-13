import { describe, expect, it } from 'vitest'
import { parseDiff } from '../server/diff.ts'

const header = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n`

describe('parseDiff', () => {
  it('keeps an SQL "-- " comment inside a hunk as a deletion, not a file header', () => {
    const text = header('q.sql') + '@@ -1,2 +1,2 @@\n-select 1;\n+select 2;\n--- old comment\n'
    const [file] = parseDiff(text)
    expect(file.path).toBe('q.sql')
    const body = file.hunks[0].lines.filter((line) => line.kind !== 'hunkHeader')
    expect(body.map((line) => line.kind)).toEqual(['deletion', 'addition', 'deletion'])
    expect(body[2].text).toBe('-- old comment')
  })

  it('does not invent a trailing empty context line from the final newline', () => {
    const text = header('a.txt') + '@@ -1 +1 @@\n-x\n+y\n'
    const [file] = parseDiff(text)
    expect(file.hunks[0].lines.filter((line) => line.kind !== 'hunkHeader')).toHaveLength(2)
  })

  it('takes the path from +++ with the tab git appends after a path containing spaces', () => {
    const text = 'diff --git a/sp ace.py b/sp ace.py\n--- a/sp ace.py\t\n+++ b/sp ace.py\t\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(text)[0].path).toBe('sp ace.py')
  })

  it('decodes the octal escapes git uses for non-ASCII paths', () => {
    const text = 'diff --git "a/\\303\\274n\\303\\257.py" "b/\\303\\274n\\303\\257.py"\n--- "a/\\303\\274n\\303\\257.py"\n+++ "b/\\303\\274n\\303\\257.py"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(text)[0].path).toBe('ünï.py')
  })

  it('strips CRLF and counts additions/removals', () => {
    const text = header('w.txt').replace(/\n/g, '\r\n') + '@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n c\r\n'
    const [file] = parseDiff(text)
    expect(file.added).toBe(1)
    expect(file.removed).toBe(1)
    expect(file.hunks[0].lines.every((line) => !line.text.includes('\r'))).toBe(true)
  })

  it('marks new and deleted files by status', () => {
    const added = 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n'
    const deleted = 'diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
    expect(parseDiff(added)[0]).toMatchObject({ path: 'n.ts', status: 'A' })
    expect(parseDiff(deleted)[0]).toMatchObject({ path: 'd.ts', status: 'D' })
  })
})

describe('diff scope', () => {
  it('rejects an unknown scope with a clear error instead of building a broken git argv', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { diff } = await import('../server/git.ts')
    const repo = mkdtempSync(`${tmpdir()}/orch-diff-scope-`)
    execFileSync('git', ['-C', repo, 'init', '-q'])
    await expect(diff(repo, { kind: 'nope' } as any)).rejects.toThrow(/unknown diff scope/i)
  })
})

describe('a turn as two trees', () => {
  it('snapshots the working tree without touching the index, and diffs two snapshots', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { diff, snapshotTree } = await import('../server/git.ts')
    const { parseDiff } = await import('../server/diff.ts')
    const repo = mkdtempSync(join(tmpdir(), 'orch-turn-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'E2E')
    writeFileSync(join(repo, 'a.txt'), 'one\n'); writeFileSync(join(repo, 'b.txt'), 'two\n')
    git('add', '-A'); git('commit', '-qm', 'start')
    const before = await snapshotTree(repo)
    expect(before).toMatch(/^[0-9a-f]{40}$/)
    writeFileSync(join(repo, 'a.txt'), 'one, changed\n'); writeFileSync(join(repo, 'c.txt'), 'three\n'); rmSync(join(repo, 'b.txt'))
    const after = await snapshotTree(repo)
    expect(after).not.toBe(before)
    // The real index saw none of it: nothing is staged.
    expect(git('status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' D b.txt', ' M a.txt', '?? c.txt'])
    const files = parseDiff(await diff(repo, { kind: 'turn', before: before!, after: after! }))
    expect(files.map((file) => [file.path, file.status])).toEqual([['a.txt', 'M'], ['b.txt', 'D'], ['c.txt', 'A']])
    // A repository with no commit yet still has a working tree to snapshot; a folder that is not one has nothing.
    const fresh = mkdtempSync(join(tmpdir(), 'orch-fresh-'))
    execFileSync('git', ['-C', fresh, 'init', '-q'])
    writeFileSync(join(fresh, 'x.txt'), 'x\n')
    expect(await snapshotTree(fresh)).toMatch(/^[0-9a-f]{40}$/)
    expect(await snapshotTree('/nowhere/at/all')).toBeNull()
  })
})

describe('a branch against its base, and against main', () => {
  it('shows only what the branch adds over the branch it was opened on, and everything over main', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { diff, resolveRef } = await import('../server/git.ts')
    const { parseDiff } = await import('../server/diff.ts')
    const repo = mkdtempSync(join(tmpdir(), 'orch-stack-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'E2E')
    writeFileSync(join(repo, 'base.txt'), 'main\n'); git('add', '-A'); git('commit', '-qm', 'main')
    // feature/one adds one.py; stack, opened against feature/one, adds top.py on top of it.
    git('checkout', '-q', '-b', 'feature/one'); writeFileSync(join(repo, 'one.py'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'one')
    git('checkout', '-q', '-b', 'stack'); writeFileSync(join(repo, 'top.py'), 'top\n'); git('add', '-A'); git('commit', '-qm', 'top')
    const paths = async (scope: any, base: string | null) => parseDiff(await diff(repo, scope, base)).map((file) => file.path)
    expect(await paths({ kind: 'branch' }, 'feature/one')).toEqual(['top.py'])
    expect(await paths({ kind: 'main' }, 'main')).toEqual(['one.py', 'top.py'])
    expect(await paths({ kind: 'branch' }, null)).toEqual([])   // nothing to measure against: the working tree alone
    // The remote's copy of a branch is preferred when there is one: that is the history GitHub compares with.
    expect(await resolveRef(repo, 'feature/one')).toBe('feature/one')
    git('update-ref', 'refs/remotes/origin/feature/one', git('rev-parse', 'feature/one').trim())
    expect(await resolveRef(repo, 'feature/one')).toBe('origin/feature/one')
    expect(await paths({ kind: 'branch' }, 'feature/one')).toEqual(['top.py'])
    // A local copy of the base left behind changes neither the diff nor the commit list.
    const { commits } = await import('../server/git.ts')
    git('branch', '-f', 'feature/one', 'main')
    expect(await paths({ kind: 'branch' }, 'feature/one')).toEqual(['top.py'])
    expect((await commits(repo, 'feature/one')).map((commit) => commit.subject)).toEqual(['top'])
  })
})
