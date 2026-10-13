import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const BIN = join(process.cwd(), 'tests/fixtures/bin')

describe('planUsage (fake keychain + local usage endpoint)', () => {
  let server: ReturnType<typeof createServer>
  let mode = 'ok'
  beforeAll(async () => {
    process.env.ORCHESTRATOR_BIN_DIR = BIN
    server = createServer((request, response) => {
      if (mode === '401') { response.statusCode = 401; return response.end() }
      if (mode === '500') { response.statusCode = 500; return response.end() }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        limits: [
          { kind: 'session', group: 'session', percent: 30, resets_at: '2026-09-02T20:29:59Z', is_active: false },
          { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: '2026-09-03T20:59:59Z' },
          { kind: 'weekly_scoped', group: 'weekly', percent: 56, scope: { model: { display_name: 'Fable' } }, is_active: true },
        ],
        extra_usage: { is_enabled: false, used_credits: 0, monthly_limit: 15000, utilization: 0, decimal_places: 2, disabled_reason: 'out_of_credits' },
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.ORCHESTRATOR_USAGE_URL = `http://127.0.0.1:${(server.address() as any).port}/usage`
  })
  afterAll(() => { server.close(); delete process.env.ORCHESTRATOR_USAGE_URL })
  beforeEach(async () => { (await import('../server/planUsage.ts')).resetPlanUsageCache(); delete process.env.FAKE_SECURITY_EMPTY })

  it('reads the tier from the keychain and the limits from the API, then caches', async () => {
    const { planUsage } = await import('../server/planUsage.ts')
    mode = 'ok'
    const first = await planUsage() as any
    expect(first.plan).toBe('Max (20x)')
    expect(first.limits.map((limit: any) => limit.label)).toEqual(['Current session', 'All models', 'Fable'])
    expect(first.extra).toMatchObject({ enabled: false, limitUSD: 150, disabledReason: 'out_of_credits' })
    mode = '500'
    expect(await planUsage()).toBe(first)   // cached: the 500 is never seen
  })
  it('explains an expired login and a failed request', async () => {
    const { planUsage, resetPlanUsageCache } = await import('../server/planUsage.ts')
    mode = '401'; resetPlanUsageCache()
    expect((await planUsage() as any).error).toMatch(/expired/)
    mode = '500'; resetPlanUsageCache()
    expect((await planUsage() as any).error).toMatch(/500/)
  })
  it('explains a missing keychain entry', async () => {
    const { planUsage, resetPlanUsageCache } = await import('../server/planUsage.ts')
    process.env.FAKE_SECURITY_EMPTY = '1'; resetPlanUsageCache()
    expect((await planUsage() as any).error).toMatch(/Not signed in/)
  })
  it('handles a payload with no extra usage or limits', async () => {
    const { planUsage, resetPlanUsageCache } = await import('../server/planUsage.ts')
    const bare = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{}') })
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    process.env.ORCHESTRATOR_USAGE_URL = `http://127.0.0.1:${(bare.address() as any).port}/`
    resetPlanUsageCache()
    const result = await planUsage() as any
    expect(result.limits).toEqual([]); expect(result.extra).toBeNull()
    bare.close()
    process.env.ORCHESTRATOR_USAGE_URL = `http://127.0.0.1:${(server.address() as any).port}/usage`
  })
})

describe('github (fake gh)', () => {
  let repo: string
  beforeAll(() => { process.env.ORCHESTRATOR_BIN_DIR = BIN; repo = mkdtempSync(join(tmpdir(), 'gh-')) })
  beforeEach(async () => { delete process.env.FAKE_GH_MODE; (await import('../server/github.ts')).resetGitHubCaches() })

  it('first tier: ownership, draft, CI, requested review, ages, sizes and the ticket key; second tier: split totals and Linear', async () => {
    const { listPullRequests, pullRequestDetails } = await import('../server/github.ts')
    const result = await listPullRequests(repo, null) as any
    expect(result.ok).toBe(true); expect(result.viewer).toBe('octo')
    const [widgets, mine, broken] = result.prs
    expect(widgets).toMatchObject({ isMine: false, checks: 'pass', reviewRequested: true, reviewers: ['octo', 'core'], linearKey: 'WID-7', linearURL: null, unread: 2, commitCount: 6 })
    expect(mine).toMatchObject({ isMine: true, checks: 'pending', isDraft: true, reviewRequested: false })
    expect(broken).toMatchObject({ checks: '', lastCommitAt: null, authorAvatar: '' })
    expect(widgets.totals).toBeNull(); expect(widgets.activity).toBeNull()
    // With a workspace known up front, keys link before the second tier answers.
    expect((await listPullRequests(repo, 'acme-co') as any).prs[0].linearURL).toBe('https://linear.app/acme-co/issue/WID-7')

    const { details, linearWorkspace } = await pullRequestDetails(repo, 'octo')
    expect(linearWorkspace).toBe('acme-co')
    expect(details.get(7)!.totals.source).toEqual({ files: 1, added: 10, removed: 2 })
    expect(details.get(7)!.totals.tests).toEqual({ files: 1, added: 30, removed: 0 })
    expect(details.get(7)!.linearURL).toBe('https://linear.app/acme-co/issue/WID-7')
    expect(details.get(8)!.linearURL).toBeNull()
    expect(details.has(9)).toBe(false)
  })
  it('keeps only human comments by others, across comments, reviews and threads', async () => {
    const { listMyPRComments } = await import('../server/github.ts')
    const result = await listMyPRComments(repo) as any
    expect(result.ok).toBe(true)
    expect(result.comments.map((comment: any) => comment.id)).toEqual(['review-t1', 'discussion-c1', 'review-r1'])
    expect(result.comments[0].path).toBe('src/w.py')
  })
  it('reports gh missing and gh unauthenticated', async () => {
    const { listPullRequests, listMyPRComments, viewerLogin, resetGitHubCaches } = await import('../server/github.ts')
    process.env.FAKE_GH_MODE = 'unauth'; resetGitHubCaches()
    expect((await listPullRequests(repo, null) as any).ok).toBe(false)
    expect((await listMyPRComments(repo) as any).message).toMatch(/Not signed in/)
    expect(await viewerLogin(repo)).toBeNull()
    process.env.ORCHESTRATOR_BIN_DIR = join(tmpdir(), 'no-such-bin-dir'); resetGitHubCaches()
    expect((await listPullRequests(repo, null) as any).message).toMatch(/not installed/)
    process.env.ORCHESTRATOR_BIN_DIR = BIN
    expect((await listPullRequests('/no/such/folder', null) as any).message).toMatch(/missing/)
  })
  it('picks the project reviewer when one exists, else the generic one', async () => {
    const { reviewerCommand } = await import('../server/github.ts')
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    expect(reviewerCommand('Widgets', repo, home)).toBe('/code-review')
    mkdirSync(join(home, '.claude/skills/code-review-widgets'), { recursive: true })
    writeFileSync(join(home, '.claude/skills/code-review-widgets/SKILL.md'), '#')
    expect(reviewerCommand('Widgets', repo, home)).toBe('/code-review-widgets')
  })
})

describe('lsp (fake language server)', () => {
  let workspace: string
  beforeAll(() => {
    process.env.ORCHESTRATOR_BIN_DIR = BIN
    workspace = mkdtempSync(join(tmpdir(), 'lsp-'))
    writeFileSync(join(workspace, 'main.py'), 'from other import greet\nprint(greet("x"))\n')
    writeFileSync(join(workspace, 'other.py'), 'def greet(name):\n    return name\n')
  })
  afterAll(async () => { (await import('../server/lsp.ts')).stopAllLanguageServers() })

  it('reports support and installation per file type', async () => {
    const { lspStatus } = await import('../server/lsp.ts')
    expect(lspStatus(join(workspace, 'main.py'))).toEqual({ supported: true, installed: true, command: 'pyright-langserver' })
    expect(lspStatus('x.ts').command).toBe('typescript-language-server')
    expect(lspStatus('x.ts').installed).toBe(false)
    expect(lspStatus('x.txt').supported).toBe(false)
  })
  it('resolves definitions and hovers in their various shapes, and re-syncs on later calls', async () => {
    const { definition, hover } = await import('../server/lsp.ts')
    const file = join(workspace, 'main.py')
    const same = await definition(workspace, file, 1, 6)
    expect(same.locations[0]).toEqual({ path: file, line: 2, character: 4 })
    const link = await definition(workspace, file, 96, 0)
    expect(link.locations[0].path).toBe(join(workspace, 'other.py')); expect(link.locations).toHaveLength(1)
    expect((await definition(workspace, file, 99, 0)).locations).toEqual([])
    expect((await definition(workspace, file, 98, 0)).error).toBe('boom')
    expect((await hover(workspace, file, 1, 6)).text).toContain('def greet')
    expect((await hover(workspace, file, 98, 0)).text).toBe('plain text hover')
    expect((await hover(workspace, file, 97, 0)).text).toBe('part one\n\npart two')
    expect((await hover(workspace, file, 99, 0)).text).toBeNull()
  })
  it('gives up on a request the server never answers', async () => {
    const { definition } = await import('../server/lsp.ts')
    const result = await definition(workspace, join(workspace, 'main.py'), 97, 0)
    expect(result.error).toMatch(/timed out/)
  }, 20_000)
  it('says so when there is no server for the file or the binary is missing', async () => {
    const { definition, hover } = await import('../server/lsp.ts')
    expect(await definition(workspace, join(workspace, 'notes.txt'), 0, 0)).toEqual({ locations: [], error: null })
    expect(await hover(workspace, join(workspace, 'notes.txt'), 0, 0)).toEqual({ text: null, error: null })
    const ts = join(workspace, 'x.ts'); writeFileSync(ts, 'let a = 1\n')
    expect((await definition(workspace, ts, 0, 0)).error).toMatch(/not installed/)
  })
})

describe('voice (fake whisper)', () => {
  const wav = () => {
    const buffer = Buffer.alloc(44 + 3200)
    buffer.write('RIFF', 0); buffer.write('WAVE', 8); buffer.write('fmt ', 12); buffer.write('data', 36)
    return buffer
  }
  beforeAll(() => { process.env.ORCHESTRATOR_BIN_DIR = BIN })
  it('is unavailable without a model or a binary, with a hint each', async () => {
    const { voiceStatus } = await import('../server/voice.ts')
    process.env.ORCHESTRATOR_WHISPER_MODEL = '/no/model.bin'
    expect(voiceStatus()).toMatchObject({ available: false, hint: expect.stringMatching(/Download a model/) })
    process.env.ORCHESTRATOR_BIN_DIR = join(tmpdir(), 'no-such-bin-dir')
    expect(voiceStatus()).toMatchObject({ available: false, hint: expect.stringMatching(/Install/) })
    process.env.ORCHESTRATOR_BIN_DIR = BIN
  })
  it('transcribes a WAV through the binary, from the file or from stdout', async () => {
    const { transcribe, voiceStatus } = await import('../server/voice.ts')
    const model = join(mkdtempSync(join(tmpdir(), 'wm-')), 'ggml.bin'); writeFileSync(model, 'x')
    process.env.ORCHESTRATOR_WHISPER_MODEL = model
    expect(voiceStatus().available).toBe(true)
    expect(await transcribe(wav())).toBe('hello from whisper')
    process.env.FAKE_WHISPER_STDOUT_ONLY = '1'
    expect(await transcribe(wav())).toBe('spoken via stdout')
    delete process.env.FAKE_WHISPER_STDOUT_ONLY
    await expect(transcribe(Buffer.from('nope'))).rejects.toThrow(/WAV/)
    process.env.ORCHESTRATOR_WHISPER_MODEL = '/no/model.bin'
    await expect(transcribe(wav())).rejects.toThrow(/model/)
  })
})
