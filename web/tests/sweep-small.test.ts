import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('the api client wrappers', () => {
  it('sends each new call to its own route, with the body the server expects', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([String(url), init])
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { api } = await import('../src/lib/api.ts')
    await api.prs('p')
    await api.prs('p', true)
    await api.prDetails('p')
    await api.retry('s1')
    await api.switchBranch('w1', { rename: 'orch/next' })
    await api.renameGroup('p', 'a folder/x', 'reviews')
    await api.prWorktree('p', 7, 'feature/one')
    await api.tree('/w', 'branch', 'main')
    await api.tree('/w', 'commit', null, 'abc')
    await api.references('/w', '/w/a.py', 3, 4)
    expect(api.rawFileURL('/w/out/a b.png')).toBe('/api/file/raw?path=%2Fw%2Fout%2Fa%20b.png')
    expect(calls.map(([url]) => url)).toEqual([
      '/api/prs?project=p',
      '/api/prs?project=p&refresh=1',
      '/api/prs/details?project=p',
      '/api/session/s1/retry',
      '/api/worktree/w1/branch',
      '/api/project/p/group/a%20folder%2Fx',
      '/api/pr/worktree',
      '/api/tree?path=%2Fw&scope=branch&base=main',
      '/api/tree?path=%2Fw&scope=commit&sha=abc',
      '/api/lsp/references',
    ])
    expect(JSON.parse(String(calls[9][1]!.body))).toEqual({ workspace: '/w', path: '/w/a.py', line: 3, character: 4 })
    expect(JSON.parse(String(calls[4][1]!.body))).toEqual({ rename: 'orch/next' })
    expect(calls[5][1]!.method).toBe('PATCH')
    expect(JSON.parse(String(calls[5][1]!.body))).toEqual({ name: 'reviews' })
    expect(JSON.parse(String(calls[6][1]!.body))).toEqual({ projectID: 'p', prNumber: 7, branch: 'feature/one' })
  })
})

describe('loadState', () => {
  it('reads a file that has none of the collections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-bare-'))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: {} }))
    process.env.ORCHESTRATOR_STATE_DIR = dir
    vi.resetModules()
    const { loadState } = await import('../server/state.ts')
    const state = loadState()
    expect(state).toMatchObject({ projects: [], worktrees: [], sessions: [], queuedMessages: {}, drafts: {} })
  })
})

describe('allowedRoots', () => {
  it('falls back to the home directory when no claude home is pointed at', async () => {
    const saved = process.env.ORCHESTRATOR_CLAUDE_HOME
    delete process.env.ORCHESTRATOR_CLAUDE_HOME
    try {
      const { allowedRoots } = await import('../server/guard.ts')
      const { homedir } = await import('node:os')
      expect(allowedRoots(['/a'], ['/b'])).toEqual([join(homedir(), '.claude'), '/a', '/b'])
    } finally {
      process.env.ORCHESTRATOR_CLAUDE_HOME = saved
    }
  })

  it('resolves a path it cannot follow to its absolute form', async () => {
    const { isInsideAny } = await import('../server/guard.ts')
    // A root that cannot be resolved at all still confines by its literal path.
    expect(isInsideAny('/definitely/not/here/file.txt', ['/definitely/not/here'])).toBe(true)
    expect(isInsideAny('/definitely/not/here/file.txt', ['/somewhere/else'])).toBe(false)
  })
})

describe('plan usage', () => {
  it('asks Anthropic directly when nothing points it elsewhere', async () => {
    const saved = process.env.ORCHESTRATOR_USAGE_URL
    delete process.env.ORCHESTRATOR_USAGE_URL
    process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ limits: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const { planUsage, resetPlanUsageCache } = await import('../server/planUsage.ts')
      resetPlanUsageCache()
      await planUsage()
      expect(seen).toEqual(['https://api.anthropic.com/api/oauth/usage'])
      resetPlanUsageCache()
    } finally {
      process.env.ORCHESTRATOR_USAGE_URL = saved
    }
  })
})

describe('codex mcp tool calls', () => {
  it('closes a completed mcp call and reports a failed one', async () => {
    const { parseCodexLine } = await import('../server/engines.ts')
    const started = new Set<string>()
    const start = parseCodexLine(JSON.stringify({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'tracker', tool: 'search' } }), started)
    expect(start.some((event) => event.type === 'toolStart')).toBe(true)
    const done = parseCodexLine(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'tracker', tool: 'search', status: 'failed' } }), started)
    expect(done).toContainEqual({ type: 'toolEnd', id: 'm1', output: null, failed: true })
  })
})

describe('titles', () => {
  it('gives up when a message is nothing but noise', async () => {
    const { titleFromMessage } = await import('../server/titles.ts')
    expect(titleFromMessage('   ')).toBeNull()
  })
})
