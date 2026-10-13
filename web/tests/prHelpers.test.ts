import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ago', () => {
  it('picks the shortest honest unit', async () => {
    const { ago } = await import('../src/lib/relativeTime.ts')
    const now = Date.parse('2026-09-03T12:00:00Z')
    const at = (iso: string) => ago(iso, now)
    expect(at('2026-09-03T11:59:30Z')).toBe('now')
    expect(at('2026-09-03T11:15:00Z')).toBe('45m')
    expect(at('2026-09-03T05:00:00Z')).toBe('7h')
    expect(at('2026-08-30T12:00:00Z')).toBe('4d')
    expect(at('2026-08-10T12:00:00Z')).toBe('3w')
    expect(at('2026-06-01T12:00:00Z')).toBe('3mo')
    expect(at('2024-01-01T12:00:00Z')).toBe('2y')
    expect(at(null)).toBe('—')
    expect(at('garbage')).toBe('—')
    expect(ago('2999-01-01T00:00:00Z', now)).toBe('now')
  })
})

describe('linear', () => {
  it('finds a ticket key in a title or branch and links it only with a workspace', async () => {
    const { linearKeyOf, linearURL } = await import('../server/github.ts')
    expect(linearKeyOf('[WID-12] Do the thing', 'feat/x')).toBe('WID-12')
    expect(linearKeyOf('plain title', 'fix/ab/WID-7/thing')).toBe('WID-7')
    expect(linearKeyOf('nothing here', null, undefined)).toBeNull()
    expect(linearKeyOf('sha1-abc', 'x')).toBeNull()
    expect(linearURL('WID-7', 'acme-co')).toBe('https://linear.app/acme-co/issue/WID-7')
    expect(linearURL('WID-7', null)).toBeNull()
    expect(linearURL(null, 'acme-co')).toBeNull()
  })
})

describe('sortPRs', () => {
  const prs = [
    { number: 1, title: 'b', author: 'zed', updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', lastCommitAt: null, unread: 0, isMine: false, isDraft: true, checks: 'pass', commitCount: 3, additions: 5, deletions: 1, changedFiles: 2, activity: null, reviewRequested: false },
    { number: 2, title: 'a', author: 'amy', updatedAt: '2026-09-02T00:00:00Z', createdAt: '2026-08-02T00:00:00Z', lastCommitAt: '2026-09-02T00:00:00Z', unread: 4, isMine: true, isDraft: false, checks: 'fail', commitCount: 1, additions: 50, deletions: 9, changedFiles: 7, activity: { threadsForMe: 2, threadsOpen: 3, commits: 1, inlineComments: 1, discussionComments: 2 }, reviewRequested: true },
    { number: 3, title: 'c', author: 'bob', updatedAt: '2026-09-02T00:00:00Z', createdAt: '2026-08-03T00:00:00Z', lastCommitAt: '2026-08-20T00:00:00Z', unread: 1, isMine: false, isDraft: false, checks: '', commitCount: 9, additions: 0, deletions: 0, changedFiles: 0, activity: { threadsForMe: 0, threadsOpen: 1, commits: 0, inlineComments: 0, discussionComments: 0 }, reviewRequested: false },
  ]
  it('treats an unparsable date or an unknown check state as the bottom, never as NaN', async () => {
    const { sortPRs } = await import('../src/components/PullRequests.tsx')
    const odd = [{ ...prs[0], number: 9, createdAt: 'nope', updatedAt: 'nope', checks: 'weird' }, prs[1]]
    expect(sortPRs(odd, 'created', false).map((pr) => pr.number)).toEqual([2, 9])
    expect(sortPRs(odd, 'checks', false).map((pr) => pr.number)).toEqual([2, 9])
    expect(sortPRs(odd, 'updated', false).map((pr) => pr.number)).toEqual([2, 9])
  })
  it('orders by every key in its natural direction, ties on last activity, and flips', async () => {
    const { sortPRs, PR_SORTS } = await import('../src/components/PullRequests.tsx')
    const order = (id: string, flipped = false) => sortPRs(prs, id, flipped).map((pr) => pr.number)
    expect(order('updated')).toEqual([2, 3, 1])
    expect(order('updated', true)).toEqual([1, 2, 3])
    expect(order('created')).toEqual([3, 2, 1])
    expect(order('lastCommit')).toEqual([2, 3, 1])
    expect(order('number')).toEqual([3, 2, 1])
    expect(order('title')).toEqual([2, 1, 3])
    expect(order('author')).toEqual([2, 3, 1])
    expect(order('unread')).toEqual([2, 3, 1])
    expect(order('toHandle')).toEqual([2, 3, 1])
    expect(order('open')).toEqual([2, 3, 1])
    expect(order('requested')).toEqual([2, 3, 1])
    expect(order('mine')).toEqual([2, 3, 1])
    expect(order('draft')).toEqual([2, 3, 1])
    expect(order('checks')).toEqual([2, 3, 1])
    expect(order('commits')).toEqual([3, 1, 2])
    expect(order('additions')).toEqual([2, 1, 3])
    expect(order('deletions')).toEqual([2, 1, 3])
    expect(order('files')).toEqual([2, 1, 3])
    expect(order('myCommits')).toEqual([2, 3, 1])
    expect(order('myComments')).toEqual([2, 3, 1])
    expect(order('nonsense')).toEqual(order('updated'))
    expect(PR_SORTS.map((sort) => sort.id)).toHaveLength(new Set(PR_SORTS.map((sort) => sort.id)).size)
  })
})

describe('PRCache', () => {
  let dir = ''
  const light = vi.fn()
  const details = vi.fn()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-prcache-'))
    vi.resetModules()
    light.mockReset(); details.mockReset()
    vi.doMock('../server/github.ts', async () => {
      const real = await vi.importActual<any>('../server/github.ts')
      return { ...real, listPullRequests: light, pullRequestDetails: details }
    })
  })
  afterEach(() => { vi.doUnmock('../server/github.ts'); vi.useRealTimers() })

  const row = (number: number, extra: Record<string, unknown> = {}) => ({
    number, title: `pr ${number}`, url: '', headRefName: `b${number}`, baseRefName: 'main', isDraft: false,
    author: 'alice', authorAvatar: '', assignees: [], reviewers: [], reviewRequested: false, isMine: false,
    createdAt: '', updatedAt: '', lastCommitAt: null, commitCount: 0, additions: 0, deletions: 0, changedFiles: 0,
    checks: '', unread: 0, linearKey: 'WID-1', linearURL: null, totals: null, activity: null, ...extra,
  })
  const detail = (linearURL: string | null = null) => ({
    totals: { source: { added: 1, removed: 0, files: 1 }, tests: { added: 0, removed: 0, files: 0 } },
    activity: { inlineComments: 0, discussionComments: 0, commits: 0, reviews: 0, reviewState: null, threadsOpen: 0, threadsResolved: 0, threadsForMe: 0 },
    linearURL,
  })

  it('answers cold from the first tier, then fills in the second, learns Linear, and persists', async () => {
    light.mockResolvedValue({ ok: true, viewer: 'octo', prs: [row(1), row(2)] })
    let release!: () => void
    details.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ details: new Map([[1, detail('https://linear.app/acme-co/issue/WID-1')]]), linearWorkspace: 'acme-co' })
    }))
    const learned: string[] = []
    const { PRCache } = await import('../server/prCache.ts')
    const file = join(dir, 'prs.json')
    let workspace: string | null = null
    const cache = new PRCache(file, () => workspace, (value) => { workspace = value; learned.push(value) })

    const first = await cache.list('p', '/repo')
    expect(first.ok && first.pending).toBe(true)
    expect(first.ok && first.prs[0].activity).toBeNull()
    expect(light).toHaveBeenCalledTimes(1)

    // A second ask while the refresh runs joins it rather than starting another.
    const again = await cache.list('p', '/repo')
    expect(again.ok && again.pending).toBe(true)
    expect(light).toHaveBeenCalledTimes(1)

    release()
    const full = await cache.details('p', '/repo')
    expect(full.ok && full.pending).toBe(false)
    expect(full.ok && full.prs[0].activity).not.toBeNull()
    expect(full.ok && full.prs[0].linearURL).toBe('https://linear.app/acme-co/issue/WID-1')
    // Row 2 had no link in its body: the learned workspace turns its key into one.
    expect(full.ok && full.prs[1].linearURL).toBe('https://linear.app/acme-co/issue/WID-1')
    expect(learned).toEqual(['acme-co'])
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.version).toBe(1)
    expect(stored.entries.p.prs).toHaveLength(2)

    // A fresh instance paints from disk without asking GitHub.
    const reborn = new PRCache(file, () => workspace, () => {})
    const cached = await reborn.list('p', '/repo')
    expect(cached.ok && cached.prs).toHaveLength(2)
    expect(light).toHaveBeenCalledTimes(1)
  })

  it('serves a stale listing at once and refreshes behind it, carrying old details until new ones land', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-03T12:00:00Z') })
    light.mockResolvedValue({ ok: true, viewer: 'octo', prs: [row(1)] })
    details.mockResolvedValue({ details: new Map([[1, detail()]]), linearWorkspace: null })
    const { PRCache, FRESH_FOR } = await import('../server/prCache.ts')
    const cache = new PRCache(join(dir, 'prs.json'), () => null, () => {})
    await cache.list('p', '/repo'); await cache.details('p', '/repo')
    expect(light).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + FRESH_FOR + 1)
    let release!: () => void
    details.mockReturnValueOnce(new Promise((resolve) => { release = () => resolve({ details: new Map(), linearWorkspace: null }) }))
    const stale = await cache.list('p', '/repo')
    expect(stale.ok && stale.pending).toBe(true)
    expect(stale.ok && stale.prs[0].activity).not.toBeNull()
    expect(light).toHaveBeenCalledTimes(2)
    release()
    const refreshed = await cache.details('p', '/repo')
    expect(refreshed.ok && refreshed.prs[0].activity).not.toBeNull()
    expect(refreshed.ok && refreshed.pending).toBe(false)
  })

  it('reports a first-tier failure when there is nothing cached, and keeps the first tier when the second fails', async () => {
    light.mockResolvedValue({ ok: false, message: 'gh is sulking' })
    const { PRCache } = await import('../server/prCache.ts')
    const cache = new PRCache(join(dir, 'prs.json'), () => null, () => {})
    expect(await cache.list('p', '/repo')).toEqual({ ok: false, message: 'gh is sulking' })
    expect(await cache.details('p', '/repo')).toEqual({ ok: false, message: 'gh is sulking' })

    light.mockResolvedValue({ ok: true, viewer: 'octo', prs: [row(1)] })
    details.mockRejectedValue(new Error('graphql exploded'))
    const first = await cache.list('p', '/repo', true)
    expect(first.ok && first.prs).toHaveLength(1)
    const after = await cache.details('p', '/repo')
    expect(after.ok && after.prs[0].activity).toBeNull()
    expect(after.ok && after.pending).toBe(false)

    // Not signed in: there is no second tier to wait for.
    light.mockResolvedValue({ ok: true, viewer: null, prs: [row(1)] })
    const anonymous = await cache.list('q', '/repo')
    expect(anonymous.ok && anonymous.pending).toBe(false)
    await cache.details('q', '/repo')
    expect(details).toHaveBeenCalledTimes(1)
    cache.warm('q', '/repo')
    await cache.details('q', '/repo')
  })

  it('lets details() outlive a refresh that fails, and warm() never throws', async () => {
    let fail!: (error: Error) => void
    light.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const { PRCache } = await import('../server/prCache.ts')
    const cache = new PRCache(join(dir, 'prs.json'), () => null, () => {})
    const cold = cache.list('p', '/repo')
    const waiting = cache.details('p', '/repo')
    fail(new Error('network gone'))
    expect(await cold).toEqual({ ok: false, message: 'network gone' })
    light.mockResolvedValue({ ok: false, message: 'still gone' })
    expect(await waiting).toEqual({ ok: false, message: 'still gone' })
    cache.warm('p', '/repo')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(light).toHaveBeenCalledTimes(3)
  })

  it('shrugs off an unreadable cache file and refuses one written by another version', async () => {
    const file = join(dir, 'prs.json'); writeFileSync(file, '{not json')
    light.mockResolvedValue({ ok: true, viewer: null, prs: [] })
    const { PRCache } = await import('../server/prCache.ts')
    expect((await new PRCache(file, () => null, () => {}).list('p', '/repo')).ok).toBe(true)
    // Rows from another shape would be rendered unchecked: a cold start is worth more.
    writeFileSync(file, JSON.stringify({ version: 99, entries: { p: { viewer: null, prs: [{ number: 1 }], fetchedAt: Date.now(), detailed: true } } }))
    expect((await new PRCache(file, () => null, () => {}).list('p', '/repo')).prs).toEqual([])
  })

  it('never lets a failing background refresh reject into nobody’s hands', async () => {
    const rejections: unknown[] = []
    const watch = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', watch)
    try {
      light.mockResolvedValueOnce({ ok: true, viewer: null, prs: [row(1)] })
      const { PRCache, FRESH_FOR } = await import('../server/prCache.ts')
      const cache = new PRCache(join(dir, 'prs.json'), () => null, () => {})
      await cache.list('p', '/repo')
      vi.useFakeTimers({ now: Date.now() + FRESH_FOR + 1 })
      vi.useRealTimers()
      // Stale cache + a first tier that fails: the caller is answered from cache and returns early.
      light.mockRejectedValue(new Error('gh is not logged in'))
      const served = await cache.list('p', '/repo')
      expect(served.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', watch)
    }
  })
})
