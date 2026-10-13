import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { agoText } from '../lib/relativeTime.ts'
import { reportError, toast } from '../lib/toast.ts'
import type { CheckRun, Participant, PRActivity, PRResult, PRRow, Project, Session, Worktree } from '../../shared/types.ts'

const REVIEW_STATE: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'you approved', className: 'text-ok' },
  CHANGES_REQUESTED: { label: 'you requested changes', className: 'text-bad' },
  COMMENTED: { label: 'you commented', className: 'text-warn' },
}

/** What you personally have done on a PR, and what is still waiting for you. */
function PRActivityLine({ activity }: { activity: PRActivity }) {
  const state = activity.reviewState ? REVIEW_STATE[activity.reviewState] : null
  const parts: Array<[string, string, string]> = [
    ['inline', activity.inlineComments ? `${activity.inlineComments} inline` : '', 'Inline review comments you wrote'],
    ['notes', activity.discussionComments ? plural(activity.discussionComments, 'note') : '', 'General comments you wrote'],
    // Only the last 100 commits are inspected, so 100 means "at least".
    ['commits', activity.commits ? (activity.commits >= 100 ? '100+ commits' : plural(activity.commits, 'commit')) : '', 'Commits authored by you'],
    ['reviews', activity.reviews ? plural(activity.reviews, 'review') : '', 'Reviews you submitted'],
  ].filter(([, text]) => text) as Array<[string, string, string]>
  if (!parts.length && !state && !activity.threadsForMe && !activity.threadsOpen && !activity.threadsResolved) return null
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-500">
      <span className="text-ink-600">you:</span>
      {parts.map(([label, text, title]) => (
        <span key={label} title={title}>{text}</span>))}
      {state && <span className={state.className} title="Your latest review">{state.label}</span>}
      {activity.threadsForMe > 0 && (
        <span className="text-warn" title="Unresolved conversations where the last word is not yours">
          {activity.threadsForMe} to handle
        </span>)}
      {activity.threadsOpen > 0 && (
        <span title="Unresolved conversations on this PR">{activity.threadsOpen} open</span>)}
      {activity.threadsResolved > 0 && (
        <span title="Resolved conversations on this PR">{activity.threadsResolved} handled</span>)}
    </div>
  )
}

function Avatar({ login, url, size }: { login: string; url: string; size: number }) {
  return url
    ? <img src={url} alt={login} title={login} width={size} height={size}
           className="shrink-0 rounded-full bg-ink-800" />
    : <span title={login} style={{ width: size, height: size }}
            className="grid shrink-0 place-items-center rounded-full bg-ink-800 text-[10px] uppercase text-ink-300">
        {login.slice(0, 2)}
      </span>
}

const CHECKS_RANK: Record<string, number> = { fail: 0, pending: 1, '': 2, pass: 3 }
const STATE_RANK: Record<string, number> = { open: 0, draft: 1, merged: 2, closed: 3 }

/** GitHub's own colours: open green, draft grey, merged purple, closed red. */
const PR_STATE: Record<string, { label: string; className: string }> = {
  open: { label: 'Open', className: 'text-ok' },
  draft: { label: 'Draft', className: 'text-ink-500' },
  merged: { label: 'Merged', className: 'text-purple-400' },
  closed: { label: 'Closed', className: 'text-bad' },
}

const VERDICT: Record<string, { label: string; ring: string }> = {
  APPROVED: { label: 'approved', ring: 'ring-ok' },
  CHANGES_REQUESTED: { label: 'requested changes', ring: 'ring-bad' },
  COMMENTED: { label: 'commented', ring: 'ring-warn' },
  requested: { label: 'review requested, not yet reviewed', ring: 'ring-ink-600' },
}

/** "Merged 3 Sep 2026, 14:02" — GitHub omits the timestamp for a PR in the other state. */
const when = (iso: string | null, verb: string) => (iso ? `${verb} ${new Date(iso).toLocaleString()}` : verb)

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Teammates' verdicts as ringed avatars, with what each of them said on hover. */
type Reviewer = Omit<Participant, 'verdict'> & { verdict: Participant['verdict'] | 'requested' }

function Reviewers({ pr }: { pr: PRRow }) {
  const people: Reviewer[] = [...(pr.participants ?? [])]
  for (const login of pr.reviewers) {
    if (!people.some((person) => person.login === login)) {
      people.push({ login, avatarUrl: '', verdict: 'requested', inlineComments: 0, discussionComments: 0 })
    }
  }
  if (!people.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500" data-testid="reviewers">
      <span>reviews:</span>
      {people.map((person) => {
        const verdict = VERDICT[person.verdict ?? ''] ?? { label: 'commented, no verdict', ring: 'ring-ink-700' }
        const said = [
          person.inlineComments ? `${person.inlineComments} inline` : '',
          person.discussionComments ? plural(person.discussionComments, 'note') : '',
        ].filter(Boolean).join(', ')
        return (
          <span key={person.login} className={`flex items-center gap-1 rounded-full pr-1.5 ring-1 ${verdict.ring}`}
                title={`${person.login} — ${verdict.label}${said ? ` · ${said}` : ''}`}>
            <Avatar login={person.login} url={person.avatarUrl} size={18} />
            <span className="text-ink-300">{person.login}</span>
            {person.verdict === 'APPROVED' && <span className="text-ok">✓</span>}
            {person.verdict === 'CHANGES_REQUESTED' && <span className="text-bad">✗</span>}
            {person.verdict === 'COMMENTED' && <span className="text-warn">…</span>}
            {said && <span className="text-ink-500">{said}</span>}
          </span>)
      })}
    </div>
  )
}

/** CI at a glance, and every check by name on hover; failures are named inline. */
function Checks({ pr }: { pr: PRRow }) {
  const runs: CheckRun[] = pr.checkRuns
  const failed = runs.filter((run) => run.result === 'fail')
  const pending = runs.filter((run) => run.result === 'pending')
  const passed = runs.filter((run) => run.result === 'pass')
  const tone = pr.checks === 'pass' ? 'text-ok' : pr.checks === 'fail' ? 'text-bad' : pr.checks === 'pending' ? 'text-warn' : 'text-ink-500'
  const summary = !runs.length
    ? (pr.checks ? `CI ${pr.checks}` : 'no CI')
    : failed.length ? `CI ✗ ${failed.length} of ${runs.length} failing`
    : pending.length ? `CI ⋯ ${pending.length} of ${runs.length} running`
    : `CI ✓ ${passed.length}${runs.length > passed.length ? ` of ${runs.length}` : ''} passing`
  const detail = runs.map((run) => `${run.result === 'pass' ? '✓' : run.result === 'fail' ? '✗' : run.result === 'pending' ? '⋯' : '–'} ${run.name}`).join('\n')
  return (
    <span className={`flex flex-wrap items-center gap-x-1.5 ${tone}`} title={detail || 'No checks reported'} data-testid="checks">
      <span>{summary}</span>
      {failed.slice(0, 3).map((run) => run.url
        ? <a key={run.name} className="underline decoration-dotted" href={run.url} target="_blank" rel="noreferrer">{run.name}</a>
        : <span key={run.name}>{run.name}</span>)}
    </span>
  )
}

export const PR_STATES = ['open', 'draft', 'merged', 'closed'] as const
const STATES_KEY = 'orchestrator.prStates'

/** Number, title, branch, author, key, assignees, reviewers — one box, any of them. */
export function matchesPR(pr: PRRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    `#${pr.number}`, pr.title, pr.headRefName, pr.author, pr.linearKey ?? '',
    ...pr.assignees.map((user) => user.login),
    ...pr.reviewers,
    ...(pr.participants ?? []).map((person) => person.login),
  ].join(' ').toLowerCase()
  return needle.split(/\s+/).every((word) => haystack.includes(word))
}

/** Every order the list can take. `dir` is the natural direction; the arrow button flips it. */
export const PR_SORTS: Array<{ id: string; label: string; dir: 'asc' | 'desc'; key: (pr: PRRow) => number | string }> = [
  { id: 'updated', label: 'Last activity', dir: 'desc', key: (pr) => Date.parse(pr.updatedAt) || 0 },
  { id: 'created', label: 'Opened', dir: 'desc', key: (pr) => Date.parse(pr.createdAt) || 0 },
  { id: 'lastCommit', label: 'Last commit', dir: 'desc', key: (pr) => Date.parse(pr.lastCommitAt ?? '') || 0 },
  { id: 'number', label: 'Number', dir: 'desc', key: (pr) => pr.number },
  { id: 'title', label: 'Title', dir: 'asc', key: (pr) => String(pr.title).toLowerCase() },
  { id: 'author', label: 'Author', dir: 'asc', key: (pr) => String(pr.author).toLowerCase() },
  { id: 'unread', label: 'Unread notifications', dir: 'desc', key: (pr) => pr.unread },
  { id: 'toHandle', label: 'Waiting on you', dir: 'desc', key: (pr) => pr.activity?.threadsForMe ?? 0 },
  { id: 'open', label: 'Open conversations', dir: 'desc', key: (pr) => pr.activity?.threadsOpen ?? 0 },
  { id: 'requested', label: 'Review requested', dir: 'desc', key: (pr) => (pr.reviewRequested ? 1 : 0) },
  { id: 'mine', label: 'Yours first', dir: 'desc', key: (pr) => (pr.isMine ? 1 : 0) },
  { id: 'draft', label: 'Ready before drafts', dir: 'asc', key: (pr) => (pr.isDraft ? 1 : 0) },
  { id: 'checks', label: 'CI status', dir: 'asc', key: (pr) => CHECKS_RANK[pr.checks] ?? 2 },
  { id: 'commits', label: 'Commits', dir: 'desc', key: (pr) => pr.commitCount },
  { id: 'additions', label: 'Lines added', dir: 'desc', key: (pr) => pr.additions },
  { id: 'deletions', label: 'Lines removed', dir: 'desc', key: (pr) => pr.deletions },
  { id: 'files', label: 'Files changed', dir: 'desc', key: (pr) => pr.changedFiles },
  { id: 'myCommits', label: 'Your commits', dir: 'desc', key: (pr) => pr.activity?.commits ?? 0 },
  { id: 'myComments', label: 'Your comments', dir: 'desc',
    key: (pr) => (pr.activity?.inlineComments ?? 0) + (pr.activity?.discussionComments ?? 0) },
  { id: 'state', label: 'State (open, draft, merged, closed)', dir: 'asc', key: (pr) => STATE_RANK[pr.state] },
  { id: 'merged', label: 'Merged or closed', dir: 'desc', key: (pr) => Date.parse(pr.mergedAt ?? pr.closedAt ?? '') || 0 },
  { id: 'reviewers', label: 'Reviewers', dir: 'desc',
    key: (pr) => (pr.participants ?? []).length + pr.reviewers.length },
  { id: 'approvals', label: 'Approvals', dir: 'desc',
    key: (pr) => (pr.participants ?? []).filter((person) => person.verdict === 'APPROVED').length },
]

export function sortPRs(prs: PRRow[], sortID: string, flipped: boolean): PRRow[] {
  const sort = PR_SORTS.find((candidate) => candidate.id === sortID) ?? PR_SORTS[0]
  const direction = (sort.dir === 'desc') !== flipped ? -1 : 1
  return [...prs].sort((a, b) => {
    const [ka, kb] = [sort.key(a), sort.key(b)]
    const order = ka < kb ? -1 : ka > kb ? 1 : 0
    // Ties fall back to most recent activity so the order is stable and meaningful.
    return order ? order * direction : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
  })
}

const SORT_KEY = 'orchestrator.prSort'

export function PullRequestsTab({
  projects, worktrees, sessions, defaultProjectID, onOpenSession, onChanged, initialQuery,
}: {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  defaultProjectID: string | null
  onOpenSession: (id: string) => void
  onChanged: () => void
  /** Opens already narrowed to one branch, for the session that is working on it. */
  initialQuery?: string
}) {
  // The tab can mount before the socket has delivered any project — as it does whenever this is the
  // remembered tab. Holding the id in state alone left it stuck at '' forever, so nothing was ever
  // fetched while the picker showed a project (a select with an unmatched value shows its first
  // option). Only an explicit choice is state; the rest is derived, so it follows the projects in.
  const [chosen, setProjectID] = useState('')
  const projectID = chosen || defaultProjectID || projects[0]?.id || ''
  const [result, setResult] = useState<PRResult>({ ok: true, viewer: null, prs: [], fetchedAt: 0, pending: false })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ id: string; flipped: boolean }>(() => {
    try { return JSON.parse(localStorage.getItem(SORT_KEY) ?? '') } catch { return { id: 'updated', flipped: false } }
  })
  useEffect(() => { try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)) } catch { /* private mode */ } }, [sort])
  const [states, setStates] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(STATES_KEY) ?? '')) } catch { return new Set(['open', 'draft']) }
  })
  useEffect(() => { try { localStorage.setItem(STATES_KEY, JSON.stringify([...states])) } catch { /* private mode */ } }, [states])
  const toggleState = (state: string) => setStates((current) => {
    const next = new Set(current)
    next.has(state) ? next.delete(state) : next.add(state)
    return next
  })
  const [query, setQuery] = useState(initialQuery ?? '')

  // Two tiers: whatever is cached paints at once; the detailed rows replace it when they land.
  // The counter outlives renders so an answer to an older request can never overwrite a newer one.
  // Whether GitHub has answered at all yet. Counts of zero before that read as "you have none".
  const [answered, setAnswered] = useState(false)
  const generation = useRef(0)
  const load = (refresh = false) => {
    if (!projectID) return
    setLoading(true)
    const mine = ++generation.current
    const settle = (next: PRResult) => {
      if (generation.current !== mine) return
      setResult(next)
      setAnswered(true)
    }
    void api.prs(projectID, refresh)
      .then((first) => {
        settle(first)
        if (first.ok && first.pending) return api.prDetails(projectID).then(settle)
      })
      .catch((failure) => settle({ ok: false, message: failure.message }))
      .finally(() => { if (generation.current === mine) setLoading(false) })
  }
  useEffect(load, [projectID])

  // The server matches PRs to worktrees by live branch; stored branches go stale.
  const worktreeFor = (pr: PRRow) =>
    worktrees.find((worktree) => worktree.id === pr.worktreeID) ?? null

  const latestSessionIn = (worktreeID: string) =>
    sessions.filter((session) => session.worktreeID === worktreeID && !session.isArchived).at(-1)

  const open = (worktreeID: string) => {
    const session = latestSessionIn(worktreeID)
    if (session) onOpenSession(session.id)
    else void api.newSession(worktreeID).then((created: any) => { onChanged(); onOpenSession(created.id) }).catch(reportError)
  }

  // No worktree holds this branch yet: check it out, or take a copy of the head when git cannot.
  const openWorktree = async (pr: PRRow) => {
    setBusy(pr.number)
    setError(null)
    try {
      const created = await api.prWorktree(projectID, pr.number, pr.headRefName)
      onChanged()
      // A toast, because the next line leaves this tab for the new session.
      if (created.copied) {
        toast(`#${pr.number}: ${pr.headRefName} could not be checked out here, `
          + `so ${created.worktree.branch} holds a copy of the pull request head.`, 'info')
      }
      open(created.worktree.id)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const review = async (pr: PRRow) => {
    setBusy(pr.number)
    setError(null)
    try {
      const created = await api.reviewPR(projectID, pr.number, pr.title)
      onChanged()
      onOpenSession(created.session.id)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const all: PRRow[] = result.ok === false ? [] : result.prs
  const prs = sortPRs(all.filter((pr: any) => states.has(pr.state) && matchesPR(pr, query)), sort.id, sort.flipped)
  const settled = answered
  const unreadTotal = prs.reduce((total, pr) => total + pr.unread, 0)
  const countOf = (state: string) => all.filter((pr) => pr.state === state).length

  return (
    <div className="mx-auto w-full max-w-4xl space-y-3 overflow-y-auto p-5">
      <div className="flex flex-wrap items-center gap-2">
        <select className="field w-auto" value={projectID} aria-label="Project"
                onChange={(event) => setProjectID(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <select className="field w-auto" value={sort.id} aria-label="Sort by"
                onChange={(event) => setSort({ id: event.target.value, flipped: false })}>
          {PR_SORTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <button className="btn-quiet" aria-label="Reverse order" title="Reverse the order"
                onClick={() => setSort((current) => ({ ...current, flipped: !current.flipped }))}>
          {(PR_SORTS.find((option) => option.id === sort.id)?.dir === 'desc') !== sort.flipped ? '↓' : '↑'}
        </button>
        <button className="btn-quiet" aria-label="Refresh" title="Ask GitHub again" onClick={() => load(true)}>↻</button>
        {loading && <span className="dot-running h-2 w-2 rounded-full bg-accent" />}
        {result.ok && result.fetchedAt > 0 && !loading && (
          <span className="text-[11px] text-ink-500" title={new Date(result.fetchedAt).toLocaleString()}>
            as of {agoText(new Date(result.fetchedAt).toISOString())}
          </span>)}
        {unreadTotal > 0 && (
          <span className="rounded-md bg-warn/20 px-2 py-0.5 text-[12px] font-semibold text-warn"
                title="Unread GitHub notifications on these pull requests">
            {unreadTotal} unread
          </span>)}
        {result.ok && result.viewer && <span className="chip ml-auto">signed in as {result.viewer}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="field w-64" type="search" placeholder="Search number, title, branch, author, key, people…"
               aria-label="Search pull requests" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="flex gap-1" role="group" aria-label="States">
          {PR_STATES.map((state) => (
            <button key={state} aria-pressed={states.has(state)}
                    className={`btn text-[11px] ${states.has(state) ? 'bg-ink-700 text-white' : 'bg-ink-850 text-ink-400'}`}
                    onClick={() => toggleState(state)}>
              <span className={PR_STATE[state].className}>●</span> {PR_STATE[state].label}{settled ? ` ${countOf(state)}` : ''}
            </button>))}
        </div>
      </div>

      {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-red-200">{error}</div>}

      {result.ok === false
        ? <div className="panel p-4 text-ink-300">{result.message}</div>
        : !settled
          ? <div className="panel p-4 text-ink-400">
              <span className="dot-running mr-2 inline-block h-2 w-2 rounded-full bg-accent" />
              Asking GitHub for this project's pull requests…
            </div>
        : !prs.length
          ? <div className="panel p-4 text-ink-400">
              {all.length ? 'Nothing matches that search and those states.' : 'No pull requests.'}
            </div>
          : prs.map((pr) => {
            const worktree = worktreeFor(pr)
            return (
              <div key={pr.number} data-testid={`pr-${pr.number}`}
                   className={`panel flex items-start gap-3 p-3 ${pr.unread ? 'border-warn/60' : ''}`}>
                <Avatar login={pr.author} url={pr.authorAvatar} size={36} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span title={PR_STATE[pr.state].label} data-testid="state" className={PR_STATE[pr.state].className}>●</span>
                    <span className="font-mono text-ink-400">#{pr.number}</span>
                    <span className="truncate font-medium">{pr.title}</span>
                    {pr.unread > 0 && (
                      <span className="rounded-md bg-warn px-2 py-0.5 text-[12px] font-bold text-ink-900"
                            title="Unread GitHub notifications for you on this PR">
                        {pr.unread} unread
                      </span>)}
                    {pr.reviewRequested && (
                      <span className="rounded-md bg-accent/25 px-2 py-0.5 text-[11px] font-semibold text-accent"
                            title="Your review was requested">review requested</span>)}
                    {pr.state === 'draft' && <span className="chip" title="Draft: not ready for review">draft</span>}
                    {pr.state === 'open' && <span className="chip text-ok" title="Ready for review">ready</span>}
                    {pr.state === 'merged' && <span className="chip text-purple-400" title={when(pr.mergedAt, 'Merged')}>merged {agoText(pr.mergedAt)}</span>}
                    {pr.state === 'closed' && <span className="chip text-bad" title={when(pr.closedAt, 'Closed')}>closed {agoText(pr.closedAt)}</span>}
                    {pr.isMine && <span className="chip">yours</span>}
                    <Checks pr={pr} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-500">
                    <span className="font-mono">{pr.headRefName}</span>
                    <span>→ {pr.baseRefName}</span>
                    <span>· by <span className="text-ink-300">{pr.author}</span></span>
                    {pr.assignees?.length > 0 && (
                      <span className="flex items-center gap-1" title={`Assigned to ${pr.assignees.map((user) => user.login).join(', ')}`}>
                        · assigned to
                        {pr.assignees.map((user) => <Avatar key={user.login} login={user.login} url={user.avatarUrl} size={16} />)}
                        <span className="text-ink-300">{pr.assignees.map((user) => user.login).join(', ')}</span>
                      </span>)}
                    {pr.reviewers?.length > 0 && (
                      <span title="Reviewers requested">· reviewers {pr.reviewers.join(', ')}</span>)}
                    {worktree && <span className="text-accent">· worktree {worktree.name}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-500">
                    <span title={`${pr.commitCount} commits`}>{pr.commitCount} commits</span>
                    <span title={`Opened ${new Date(pr.createdAt).toLocaleString()}`}>· opened {agoText(pr.createdAt)}</span>
                    <span title={pr.lastCommitAt ? `Last commit ${new Date(pr.lastCommitAt).toLocaleString()}` : 'No commits'}>
                      · last commit {agoText(pr.lastCommitAt)}
                    </span>
                    <span title={`Last activity ${new Date(pr.updatedAt).toLocaleString()}`}>· active {agoText(pr.updatedAt)}</span>
                  </div>
                  <Reviewers pr={pr} />
                  {pr.activity && <PRActivityLine activity={pr.activity} />}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[10px]">
                  {pr.totals ? (
                    <>
                      <span title="Source changes">
                        <span className="text-ok">+{pr.totals.source.added}</span>{' '}
                        <span className="text-bad">−{pr.totals.source.removed}</span>
                        <span className="text-ink-500"> · {pr.totals.source.files} files</span>
                      </span>
                      {pr.totals.tests.files > 0 && (
                        <span className="text-ink-500" title="Test changes, counted separately">
                          tests +{pr.totals.tests.added} −{pr.totals.tests.removed} · {pr.totals.tests.files} files
                        </span>)}
                    </>
                  ) : (
                    <span title="All changes; tests are split out once details load">
                      <span className="text-ok">+{pr.additions}</span>{' '}
                      <span className="text-bad">−{pr.deletions}</span>
                      <span className="text-ink-500"> · {pr.changedFiles} files</span>
                    </span>)}
                </div>

                <div className="flex shrink-0 flex-col items-stretch gap-1">
                  {worktree ? (
                    <button className="btn-primary" onClick={() => open(worktree.id)}>Open worktree</button>
                  ) : (
                    <button className="btn-primary" disabled={busy === pr.number}
                            title={`Check out ${pr.headRefName} in its own worktree — or a copy of the `
                              + 'pull request head if git cannot check that branch out here'}
                            onClick={() => void openWorktree(pr)}>
                      {busy === pr.number ? 'Setting up…' : 'Worktree'}
                    </button>)}
                  {!worktree && !pr.isMine && (
                    <button className="btn-quiet" disabled={busy === pr.number}
                            title="New worktree under PR Reviews, then run the project's reviewer"
                            onClick={() => void review(pr)}>Review</button>)}
                  <a className="btn-quiet text-center" href={pr.url} target="_blank" rel="noreferrer">GitHub</a>
                  {pr.linearURL
                    ? <a className="btn-quiet text-center" href={pr.linearURL} target="_blank" rel="noreferrer"
                         title={`Open ${pr.linearKey} in Linear`}>{pr.linearKey}</a>
                    : pr.linearKey
                      ? <span className="chip text-center" title="Linear workspace not known yet — set it in Settings">{pr.linearKey}</span>
                      : null}
                </div>
              </div>)
          })}
    </div>
  )
}



/** GitHub's own colours for a pull request's state, so the dot means the same thing everywhere. */
export const PR_STATE_TONE: Record<string, { dot: string; label: string }> = {
  open: { dot: 'bg-ok', label: 'Open' },
  draft: { dot: 'bg-ink-400', label: 'Draft' },
  merged: { dot: 'bg-purple-400', label: 'Merged' },
  closed: { dot: 'bg-bad', label: 'Closed' },
}
