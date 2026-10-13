import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeLine, claudeArgs, agentEnv } from '../server/engines.ts'
import * as git from '../server/git.ts'
import { makeRepo } from './helpers/server.ts'

const gitRun = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

describe('engines leftovers', () => {
  it('summarises tool input by preferred key, JSON fallback, and empty for non-objects', () => {
    const start = (input: any) => (parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'T', input }] } }))[0] as any).detail
    expect(start({ file_path: '/a', command: 'ls' })).toBe('ls')
    expect(start({ pattern: 'p' })).toBe('p'); expect(start({ description: 'd' })).toBe('d'); expect(start({ prompt: 'q' })).toBe('q')
    expect(start({ other: 1 })).toBe('{"other":1}')
    expect(start('string')).toBe(''); expect(start(null)).toBe('')
    expect(start({ command: 'x'.repeat(400) }).length).toBe(300)
  })
  it('claudeArgs covers safe/full access and model/effort flags; agentEnv fills a missing PATH', () => {
    const base = { id: 's', worktreeID: 'w', title: 't', engine: 'claude', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } as any
    expect(claudeArgs({ ...base, accessMode: 'safe' }, 'p', null, 'n')).toContain('default')
    expect(claudeArgs({ ...base, accessMode: 'full', model: 'm', effort: 'high' }, 'p', null, 'n')).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--model', 'm', '--effort', 'high']))
    const saved = process.env.PATH; delete process.env.PATH
    expect(agentEnv().PATH).toContain('/usr/bin:/bin')
    process.env.PATH = saved
  })
})

describe('git leftovers', () => {
  it('defaultBranch prefers origin/HEAD, falls back to main/master, else an empty guess; commits without a merge base', async () => {
    const repo = makeRepo()
    gitRun(repo, 'remote', 'set-head', 'origin', 'main')
    expect(await git.defaultBranch(repo)).toBe('main')
    gitRun(repo, 'remote', 'set-head', 'origin', '--delete')
    expect(await git.defaultBranch(repo)).toBe('main')
    const bare = mkdtempSync(join(tmpdir(), 'bare-')); execFileSync('git', ['init', '-q', '-b', 'trunk', bare])
    execFileSync('git', ['-C', bare, 'config', 'user.email', 'a@b']); execFileSync('git', ['-C', bare, 'config', 'user.name', 'a'])
    execFileSync('git', ['-C', bare, 'commit', '-q', '--allow-empty', '-m', 'x'])
    expect(typeof await git.defaultBranch(bare)).toBe('string')
    execFileSync('git', ['-C', bare, 'branch', 'master'])
    expect(await git.defaultBranch(bare)).toBe('master')
    expect((await git.commits(repo, 'no-such-base')).length).toBeGreaterThan(0)
    expect(await git.diff(repo, { kind: 'branch' }, 'no-such-base', 3)).toBeTypeOf('string')
    expect(await git.diff(repo, { kind: 'remote' }, null, 0)).toBeTypeOf('string')
  })
})

describe('github leftovers (fake gh with edge payloads)', () => {
  const BIN = mkdtempSync(join(tmpdir(), 'gh-edge-'))
  beforeEach(async () => { process.env.ORCHESTRATOR_BIN_DIR = BIN; (await import('../server/github.ts')).resetGitHubCaches() })
  afterEach(() => { process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin') })
  it('handles an empty viewer, null connections, unknown check states and junk notifications', async () => {
    writeFileSync(join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo ""; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
if [ "$1" = "api" ] && [[ "$2" == /notifications* ]]; then echo '[null,{"unread":true,"subject":null},{"unread":true,"subject":{"type":"PullRequest","url":"https://api.github.com/repos/o/r/pulls/1"}}]'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ] && [[ "$*" == *reviewRequests* ]]; then echo '{"data":{"repository":{"pullRequests":{"nodes":[null,{"number":1,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"WEIRD"}}}]},"author":null,"assignees":null,"reviewRequests":{"nodes":[null,{"requestedReviewer":{}}]}},{"number":2,"commits":null,"author":{"login":"x"}}]}}}}'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then echo '{"data":{"search":{"nodes":[null,{"number":5,"title":"x","headRefName":"h","comments":null,"reviews":{"nodes":[{"id":"r","author":null,"body":"anon","url":"u","createdAt":"2026-01-01T00:00:00Z"}]},"reviewThreads":{"nodes":[{"comments":null}]}}]}}}'; exit 0; fi
exit 2
`); chmodSync(join(BIN, 'gh'), 0o755)
    const { listPullRequests, listMyPRComments, viewerLogin } = await import('../server/github.ts')
    expect(await viewerLogin('/tmp')).toBeNull()
    const prs = (await listPullRequests('/tmp', null)) as any
    expect(prs.ok).toBe(true); expect(prs.viewer).toBeNull()
    expect(prs.prs[0]).toMatchObject({ checks: 'pending', author: '', authorAvatar: '', assignees: [], reviewers: [], reviewRequested: false, unread: 1, title: '', commitCount: 0 })
    expect(prs.prs[1]).toMatchObject({ checks: '', lastCommitAt: null, unread: 0 })
    const comments = (await listMyPRComments('/tmp')) as any
    expect(comments.message).toMatch(/Not signed in/)
  })
  it('lists comments when the viewer exists and the payload is sparse; a failed first tier reports gh’s words; sparse details count as zero', async () => {
    writeFileSync(join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
if [ "$1" = "api" ] && [[ "$2" == /notifications* ]]; then echo 'not even json'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ] && [[ "$*" == *search=* ]]; then echo '{"data":{"search":{"nodes":[null,{"number":5,"title":"x","headRefName":"h","comments":null,"reviews":{"nodes":[{"id":"r","author":null,"body":"anon","url":"u","createdAt":"2026-01-01T00:00:00Z"}]},"reviewThreads":{"nodes":[{"comments":null}]}}]}}}'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ] && [[ "$*" == *reviewThreads* ]]; then echo '{"data":{"repository":{"pullRequests":{"nodes":[null,{"number":5,"author":null,"bodyText":null,"files":null,"comments":null,"reviews":null,"commits":{"nodes":[null,{"commit":null}]},"reviewThreads":{"nodes":[{"isResolved":false,"comments":null},{"isResolved":false,"comments":{"nodes":[{"author":{"login":"other"}}]}}]}}]}}}}'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then echo "boom" >&2; exit 1; fi
exit 2
`); chmodSync(join(BIN, 'gh'), 0o755)
    const { listPullRequests, listMyPRComments, pullRequestDetails } = await import('../server/github.ts')
    const comments = (await listMyPRComments('/tmp')) as any
    expect(comments.ok).toBe(true); expect(comments.comments).toHaveLength(1); expect(comments.comments[0].author).toBe('')
    const prs = (await listPullRequests('/tmp', null)) as any
    expect(prs.message).toBe('boom')
    const { details, linearWorkspace } = await pullRequestDetails('/tmp', 'me')
    expect(linearWorkspace).toBeNull()
    expect(details.get(5)).toEqual({
      totals: { source: { files: 0, added: 0, removed: 0 }, tests: { files: 0, added: 0, removed: 0 } },
      linearURL: null,
      participants: [{ login: 'other', avatarUrl: '', verdict: null, inlineComments: 1, discussionComments: 0 }],
      activity: { inlineComments: 0, discussionComments: 0, commits: 0, reviews: 0, reviewState: null, threadsOpen: 2, threadsResolved: 0, threadsForMe: 0 },
    })
    writeFileSync(join(BIN, 'gh'), `#!/bin/bash\nif [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi\necho '{}' \n`); chmodSync(join(BIN, 'gh'), 0o755)
    ;(await import('../server/github.ts')).resetGitHubCaches()
    expect(((await listMyPRComments('/tmp')) as any).ok).toBe(false)
    expect(((await listPullRequests('/tmp', null)) as any).ok).toBe(false)
    // A payload with no data at all is an empty repository, not a crash — for both tiers.
    writeFileSync(join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
echo '{}'
`); chmodSync(join(BIN, 'gh'), 0o755)
    ;(await import('../server/github.ts')).resetGitHubCaches()
    expect(((await listPullRequests('/tmp', null)) as any).prs).toEqual([])
    expect((await pullRequestDetails('/tmp', 'me')).details.size).toBe(0)
  })
  it('marks failed checks, tolerates notifications without a subject url, files and assignees with holes', async () => {
    writeFileSync(join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
if [ "$1" = "api" ] && [[ "$2" == /notifications* ]]; then echo '[{"unread":true,"subject":{"type":"PullRequest"}}]'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ] && [[ "$*" == *reviewRequests* ]]; then echo '{"data":{"repository":{"pullRequests":{"nodes":[{"number":1,"commits":{"totalCount":2,"nodes":[{"commit":{"committedDate":"2026-01-01T00:00:00Z","statusCheckRollup":{"state":"FAILURE","contexts":{"nodes":[{"__typename":"CheckRun","conclusion":"SUCCESS"}]}}}}]},"author":{"login":"me"},"assignees":{"nodes":[{"login":"a"}]}}]}}}}'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then echo '{"data":{"repository":{"pullRequests":{"nodes":[{"number":1,"author":{"login":"me"},"files":{"nodes":[{}]},"reviewThreads":null}]}}}}'; exit 0; fi
exit 2
`); chmodSync(join(BIN, 'gh'), 0o755)
    const { listPullRequests, pullRequestDetails } = await import('../server/github.ts')
    const prs = (await listPullRequests('/tmp', null)) as any
    expect(prs.prs[0]).toMatchObject({ checks: 'fail', unread: 0, isMine: true, assignees: [{ login: 'a', avatarUrl: '' }], checkRuns: [{ name: 'check', result: 'pass', url: null }] })
    const { details } = await pullRequestDetails('/tmp', 'me')
    expect(details.get(1)!.totals.source).toEqual({ files: 1, added: 0, removed: 0 })
    expect(details.get(1)!.activity.threadsOpen).toBe(0)
  })
})

describe('infra leftovers', () => {
  it('plugin skills, malformed frontmatter, hook summaries, project files that exist, long descriptions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
    process.env.ORCHESTRATOR_CLAUDE_HOME = home
    mkdirSync(join(home, 'plugins/cache/vendor/pack/skills/deep-skill'), { recursive: true })
    writeFileSync(join(home, 'plugins/cache/vendor/pack/skills/deep-skill/SKILL.md'), '---\nname: deep-skill\ndescription: "A very long description that keeps going past the twenty character mark. And more."\n---\n')
    mkdirSync(join(home, 'skills/broken'), { recursive: true }); writeFileSync(join(home, 'skills/broken/SKILL.md'), 'no frontmatter here')
    mkdirSync(join(home, 'commands'), { recursive: true }); writeFileSync(join(home, 'commands/notes.txt'), 'ignored'); writeFileSync(join(home, 'commands/go.md'), 'go')
    writeFileSync(join(home, 'settings.json'), '{"hooks":{}}')
    mkdirSync(join(home, 'hooks'), { recursive: true }); writeFileSync(join(home, 'hooks/pre.sh'), '#!/bin/sh')
    mkdirSync(join(home, 'projects/-x/memory'), { recursive: true }); writeFileSync(join(home, 'projects/-x/memory/MEMORY.md'), '- a')
    const project = mkdtempSync(join(tmpdir(), 'proj-')); writeFileSync(join(project, 'CLAUDE.md'), '# p'); writeFileSync(join(project, 'CLAUDE.local.md'), '# local')
    mkdirSync(join(project, '.claude'), { recursive: true }); writeFileSync(join(project, '.claude/settings.json'), 'not json')
    const { skillCatalog, infraItems } = await import('../server/infra.ts')
    const catalog = skillCatalog([project])
    expect(catalog.some((skill) => skill.name === 'deep-skill' && skill.description.endsWith('.'))).toBe(true)
    expect(catalog.some((skill) => skill.name === 'broken')).toBe(true)
    for (const category of ['claudemd', 'memories', 'hooks', 'skills', 'agents', 'commands'] as const) {
      const items = infraItems(category, [{ name: 'p', path: project }] as any)
      expect(Array.isArray(items)).toBe(true)
    }
    const hooks = infraItems('hooks', [{ name: 'p', path: project }] as any) as any[]
    expect(hooks.some((item) => /No hooks/.test(item.subtitle ?? ''))).toBe(true)
    delete process.env.ORCHESTRATOR_CLAUDE_HOME
  })
})
