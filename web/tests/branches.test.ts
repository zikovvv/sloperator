import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeLine, parseCodexLine, killTree, spawnAgent, binary, agentEnv } from '../server/engines.ts'
import { parseDiff } from '../server/diff.ts'
import * as git from '../server/git.ts'
import { planLabel, labelFor } from '../server/planUsage.ts'
import { titleFromMessage } from '../server/titles.ts'
import { pidIsAlive, readRunningRecord } from '../server/orphans.ts'
import { blocksFrom, collectEvents, reportFrom, usageBlocks, DEFAULT_CLAUDE_PRICING, projectOf } from '../server/usage.ts'
import { resetsIn } from '../src/lib/usageFormat.ts'
import { encodeWav } from '../src/lib/wav.ts'
import { skillCatalog, infraItems, readInfraFile, writeInfraFile } from '../server/infra.ts'
import { openTerminal, closeTerminal, listTerminals, getTerminal, closeAllTerminals } from '../server/terminals.ts'
import { makeRepo } from './helpers/server.ts'

describe('engines: parser branches', () => {
  it('claude: tool_use without id/name, tool_result string and array, result without usage/cost, unknown types', () => {
    const start = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/a' } }, { type: 'text', text: '' }, { type: 'thinking' }] } }))
    expect(start[0]).toMatchObject({ type: 'toolStart', name: 'tool' })
    const end = parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' , content: 'plain' }, { type: 'text' }] } }))
    expect(end[0]).toMatchObject({ type: 'toolEnd', id: '', output: 'plain', failed: false })
    const numeric = parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 42 }] } }))
    expect(numeric[0]).toMatchObject({ output: null })
    const bare = parseClaudeLine(JSON.stringify({ type: 'result' }))
    expect(bare[0]).toMatchObject({ type: 'done', summary: null, usage: { costUSD: null, input: 0, cached: 0, output: 0 } })
    const failed = parseClaudeLine(JSON.stringify({ type: 'result', is_error: true, errors: [{ message: 'm' }, { error: 'e' }, 5], result: 'fallback' }))
    expect(failed[0]).toMatchObject({ type: 'failed', message: 'm\ne' })
    expect(parseClaudeLine(JSON.stringify({ type: 'result', is_error: true }))[0]).toMatchObject({ message: 'Turn failed' })
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'other' }))).toEqual([])
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant' }))).toEqual([])
    expect(parseClaudeLine('null')).toEqual([])
  })
  it('codex: every item type and the odd ones', () => {
    const started = new Set<string>()
    const line = (item: any, type = 'item.completed') => parseCodexLine(JSON.stringify({ type, item }), started)
    expect(line({ type: 'agent_message' })).toEqual([])
    expect(line({ type: 'reasoning', text: 'hmm' })[0]).toMatchObject({ type: 'thinking' })
    expect(line({ type: 'reasoning', text: 'hmm' }, 'item.started')).toEqual([])
    expect(line({ type: 'file_change', changes: [{ kind: 'add', path: 'a' }, { path: 'b' }] })[0]).toMatchObject({ detail: 'add a\nedit b' })
    expect(line({ type: 'file_change' }, 'item.started')).toEqual([])
    const mcp = line({ id: 'm', type: 'mcp_tool_call', server: 's', tool: 't', status: 'failed' })
    expect(mcp.map((e) => e.type)).toEqual(['toolStart', 'toolEnd']); expect(mcp[1]).toMatchObject({ failed: true })
    expect(line({ id: 'm2', type: 'mcp_tool_call' })[0]).toMatchObject({ name: 'mcp' })
    expect(line({ type: 'web_search', query: 'q' }).map((e) => e.type)).toEqual(['toolStart', 'toolEnd'])
    expect(line({ type: 'web_search' }, 'item.started')).toEqual([])
    expect(line({ type: 'command_execution' }, 'item.started')[0]).toMatchObject({ detail: '' })
    expect(line({ type: 'error' })[0]).toMatchObject({ message: 'error' })
    expect(line({ type: 'mystery' })).toEqual([])
    expect(parseCodexLine(JSON.stringify({ type: 'turn.failed' }), started)[0]).toMatchObject({ message: 'Turn failed' })
    expect(parseCodexLine(JSON.stringify({ type: 'error' }), started)[0]).toMatchObject({ message: 'error' })
    expect(parseCodexLine(JSON.stringify({ type: 'turn.completed' }), started)[0]).toMatchObject({ usage: { input: 0 } })
    expect(parseCodexLine(JSON.stringify({ type: 'other' }), started)).toEqual([])
    expect(parseCodexLine('{', started)).toEqual([])
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed' }), started)).toEqual([])
  })
  it('killTree kills a whole tree and survives a dead pid; spawnAgent detaches', async () => {
    const child = spawnAgent('/bin/bash', ['-c', 'sleep 30 & wait'], tmpdir())
    await new Promise((resolve) => setTimeout(resolve, 300))
    const kids = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')
      .filter((row) => row.trim().endsWith(` ${child.pid}`)).length
    expect(kids).toBeGreaterThan(0)
    killTree(child.pid!, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(pidIsAlive(child.pid!)).toBe(false)
    killTree(999999, 'SIGTERM')   // nothing there: must not throw
  })
  it('binary honours the override dir, otherwise the fallback or the bare name', () => {
    const saved = process.env.ORCHESTRATOR_BIN_DIR
    process.env.ORCHESTRATOR_BIN_DIR = '/fake'
    expect(binary('gh')).toBe('/fake/gh')
    delete process.env.ORCHESTRATOR_BIN_DIR
    expect(binary('gh')).toBe('gh'); expect(binary('security', '/usr/bin/security')).toBe('/usr/bin/security')
    const env = agentEnv(); expect(env.PATH).toContain('/opt/homebrew/bin'); expect(env.CLAUDECODE).toBeUndefined()
    if (saved) process.env.ORCHESTRATOR_BIN_DIR = saved
  })
})

describe('diff: rename, binary, no newline, quoting', () => {
  it('handles renames, binaries and the no-newline marker', () => {
    const text = [
      'diff --git a/old.py b/new.py', 'similarity index 90%', 'rename from old.py', 'rename to new.py',
      '--- a/old.py', '+++ b/new.py', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file',
      'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
      'diff --git a/x.txt b/x.txt', 'old mode 100644', 'new mode 100755', 'index 1..2', '--- a/x.txt', '+++ b/x.txt', '@@ -1,0 +2 @@', '+added',
    ].join('\n')
    const files = parseDiff(text)
    expect(files[0]).toMatchObject({ path: 'new.py', oldPath: 'old.py', status: 'R' })
    expect(files[0].hunks[0].lines.some((line) => line.text.includes('No newline'))).toBe(false)
    expect(files[1]).toMatchObject({ path: 'img.png', isBinary: true })
    expect(files[2].hunks[0].lines.find((line) => line.kind === 'addition')?.newLine).toBe(2)
  })
  it('decodes C escapes other than octal, and a lone diff header with nothing after it', () => {
    const text = 'diff --git "a/t\\tab.py" "b/t\\tab.py"\n--- "a/t\\tab.py"\n+++ "b/t\\tab.py"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseDiff(text)[0].path).toBe('t\tab.py')
    expect(parseDiff('diff --git a/only b/only\n')[0]).toMatchObject({ path: 'only', hunks: [] })
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('junk line\n')).toEqual([])
  })
})

describe('git service branches', () => {
  it('lists untracked files capped, tolerates a missing upstream and a non-repo', async () => {
    const repo = makeRepo()
    for (let index = 0; index < 65; index += 1) writeFileSync(join(repo, `u${index}.txt`), 'x')
    const uncommitted = parseDiff(await git.diff(repo, { kind: 'uncommitted' }, null, 3))
    expect(uncommitted.filter((file) => file.status === 'A').length).toBeLessThanOrEqual(60)
    execFileSync('git', ['-C', repo, 'branch', '--unset-upstream'])
    expect(typeof await git.diff(repo, { kind: 'remote' }, null, 3)).toBe('string')
    expect(await git.isGitRepo('/tmp')).toBe(false)
    expect(await git.currentBranch('/nope')).toBeNull()
    expect(typeof await git.defaultBranch(repo)).toBe('string')
    expect(await git.diff(repo, { kind: 'commit', sha: 'nonexistent' }, null, 3)).toBe('')
    expect((await git.commits('/nope', null)).length).toBe(0)
  })
})

describe('small modules', () => {
  it('planLabel and labelFor cover their branches', () => {
    expect(planLabel('weird_tier', undefined)).toBe('Plan'); expect(planLabel('default_claude_pro', undefined)).toBe('Pro')
    expect(labelFor({ kind: 'weekly_scoped', scope: null })).toBe('weekly_scoped')
    expect(labelFor({ kind: 'weekly_scoped', scope: { model: null } })).toBe('weekly_scoped')
  })
  it('titleFromMessage: filler-only, long single word, punctuation trimming', () => {
    expect(titleFromMessage('please')).toBe('Please')
    expect(titleFromMessage('x'.repeat(80))!.endsWith('…')).toBe(true)
    expect(titleFromMessage('fix it, now!!')).toBe('Fix it, now!!')
    expect(titleFromMessage('so, do the thing:')).toBe('Do the thing')
  })
  it('orphans: alive pid, dead pid, unreadable record', () => {
    expect(pidIsAlive(process.pid)).toBe(true); expect(pidIsAlive(999999)).toBe(false)
    const path = join(mkdtempSync(join(tmpdir(), 'rr-')), 'running.json'); writeFileSync(path, '{broken')
    expect(readRunningRecord(path)).toEqual({})
  })
  it('usage: unkeyed and corrupt lines, cache reuse and eviction, walk depth, project fallback, blocks helper', () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-home-'))
    const deep = join(home, '.claude/projects/-Users-jane-Projects-acme/a/b/c/d/e/f/g')
    mkdirSync(deep, { recursive: true })
    const file = join(home, '.claude/projects/-Users-jane-Projects-acme/s.jsonl')
    const line = (extra: any = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } }, ...extra })
    writeFileSync(file, [line({ message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 1 } }, requestId: 'r1' }), line({ message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 9 } }, requestId: 'r1' }), line(), 'not json at all but long enough to be parsed as a line', JSON.stringify({ type: 'user' }), line({ message: { model: '<synthetic>', usage: {} } }), line({ timestamp: 'garbage' }), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: {} })].join('\n'))
    writeFileSync(join(deep, 'too-deep.jsonl'), line())
    process.env.ORCHESTRATOR_CLAUDE_PROJECTS = join(home, '.claude/projects')
    const first = collectEvents(Date.now() - 3600e3)
    expect(first.events.length).toBe(2)               // m1 merged (max), one unkeyed
    expect(first.events.find((e) => e.key)?.output).toBe(9)
    const second = collectEvents(Date.now() - 3600e3)  // cache hit
    expect(second.events.length).toBe(2)
    rmSync(file); collectEvents(Date.now() - 3600e3)   // eviction path
    expect(projectOf(join(home, '.claude/projects/-Users-jane-Projects-acme/x.jsonl'), '/Users/jane')).toBe('acme')
    delete process.env.ORCHESTRATOR_CLAUDE_PROJECTS
    expect(projectOf('/elsewhere/x.jsonl', '/Users/jane')).toBe('elsewhere')
    expect(projectOf('/Users/jane/.claude/projects/-/x.jsonl', '/Users/jane')).toBe('-')
    const report = reportFrom([], DEFAULT_CLAUDE_PRICING, 0)
    expect(report.daily).toEqual([]); expect(blocksFrom([], DEFAULT_CLAUDE_PRICING)).toEqual([])
    expect(Array.isArray(usageBlocks())).toBe(true)
  })
  it('usageFormat and wav edge branches', () => {
    expect(resetsIn(null)).toBe(''); expect(resetsIn('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:30Z'))).toBe('Resets in 0 min')
    expect(new DataView(encodeWav(new Float32Array([-0.5]), 8000)).getInt16(44, true)).toBe(-16384)
  })
})

describe('infra branches', () => {
  it('reads and writes with and without a known mtime, lists every category for a project without .claude', () => {
    const project = mkdtempSync(join(tmpdir(), 'infra-'))
    mkdirSync(join(project, '.claude/skills/local-skill'), { recursive: true })
    writeFileSync(join(project, '.claude/skills/local-skill/SKILL.md'), '---\nname: local-skill\ndescription: d\n---\nbody')
    mkdirSync(join(project, '.claude/commands'), { recursive: true }); writeFileSync(join(project, '.claude/commands/go.md'), 'go')
    mkdirSync(join(project, '.claude/agents'), { recursive: true }); writeFileSync(join(project, '.claude/agents/bot.md'), '---\nname: bot\ndescription: helps\n---')
    const catalog = skillCatalog([project, '/nope'])
    expect(catalog.some((skill) => skill.name === 'local-skill')).toBe(true)
    for (const category of ['claudemd', 'memories', 'hooks', 'skills', 'agents', 'commands'] as const) {
      expect(Array.isArray(infraItems(category, [{ name: 'p', path: project }, { name: 'q', path: '/nope' }] as any))).toBe(true)
    }
    const file = join(project, 'note.md')
    const modified = writeInfraFile(file, 'one')
    expect(writeInfraFile(file, 'two', modified)).toBeGreaterThanOrEqual(modified)
    expect(readInfraFile(file).text).toBe('two')
    expect(() => readInfraFile(join(project, 'missing.md'))).toThrow()
  })
})

describe('terminals branches', () => {
  it('drops a terminal whose shell exits, lists by worktree, closes all', async () => {
    const handle = openTerminal('w1', tmpdir(), 'T')
    handle.process.write('exit\r')
    for (let attempt = 0; attempt < 50 && getTerminal(handle.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(getTerminal(handle.id)).toBeUndefined()
    const other = openTerminal('w2', tmpdir(), 'U')
    expect(listTerminals('w2')).toHaveLength(1); expect(listTerminals()).toHaveLength(1)
    closeAllTerminals(); expect(listTerminals()).toHaveLength(0)
    expect(closeTerminal(other.id)).toBe(false)
  })
})
