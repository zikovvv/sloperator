import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnv, binary } from './engines.ts'
import { splitTotals } from '../shared/testPaths.ts'
import type {
  CheckResult, CheckRun, GitHubUser, Participant, PRActivity, PRState, PullRequest, SplitTotals,
} from '../shared/types.ts'

export type { CheckResult, CheckRun, GitHubUser, Participant, PRActivity, PRState, PullRequest }
import type { PRConversationResult, PRThread, PRThreadComment } from '../shared/types.ts'

const run = promisify(execFile)

/** The branch a pull request is opened against; null when GitHub cannot be asked. */
export async function pullRequestBase(projectPath: string, number: number): Promise<string | null> {
  try {
    const parsed = JSON.parse(await gh(projectPath, ['pr', 'view', String(number), '--json', 'baseRefName']))
    return parsed.baseRefName || null
  } catch {
    return null
  }
}

/**
 * The base of the open pull request a branch belongs to, from a listing already in hand. A PR
 * checked out for review lives on `orch/pr-<number>`; one checked out by name is its own head.
 */
export function pullRequestBaseFor(branch: string | null, prs: PullRequest[]): string | null {
  if (!branch) return null
  const pr = prs.find((candidate) => (candidate.state === 'open' || candidate.state === 'draft')
    && (candidate.headRefName === branch || `orch/pr-${candidate.number}` === branch))
  return pr?.baseRefName || null
}

async function gh(cwd: string, args: string[]): Promise<string> {
  // ENOENT from execFile is ambiguous between a missing binary and a missing cwd.
  if (!existsSync(cwd)) throw new Error(`Project folder is missing: ${cwd}`)
  const { stdout } = await run(binary('gh'), args, { cwd, env: agentEnv(), maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

const viewerCache = new Map<string, string>()
export function resetGitHubCaches() { viewerCache.clear(); repoCache.clear() }

/** The logged-in GitHub user, so "mine" and "foreign" can be told apart. */
export async function viewerLogin(projectPath: string): Promise<string | null> {
  if (viewerCache.has(projectPath)) return viewerCache.get(projectPath)!
  try {
    const login = (await gh(projectPath, ['api', 'user', '--jq', '.login'])).trim()
    if (login) viewerCache.set(projectPath, login)
    return login || null
  } catch {
    return null
  }
}


const LIGHT_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN, MERGED, CLOSED], first: 60, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft state mergedAt closedAt createdAt updatedAt headRefName baseRefName
        additions deletions changedFiles
        author { login avatarUrl }
        assignees(first: 5) { nodes { login avatarUrl } }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } }
        }
        commits(last: 1) {
          totalCount
          nodes { commit { committedDate statusCheckRollup { state contexts(first: 40) { nodes {
            __typename
            ... on CheckRun { name conclusion status detailsUrl }
            ... on StatusContext { context state targetUrl }
          } } } } }
        }
      }
    }
  }
}`

const DETAIL_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN, MERGED, CLOSED], first: 60, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number bodyText
        author { login }
        files(first: 100) { nodes { path additions deletions } }
        commits(last: 100) { nodes { commit { author { user { login } } } } }
        comments(last: 50) { nodes { author { __typename login avatarUrl } } }
        reviews(last: 50) { nodes { author { __typename login avatarUrl } state } }
        reviewThreads(first: 50) {
          nodes { isResolved comments(first: 20) { nodes { author { __typename login avatarUrl } } } }
        }
      }
    }
  }
}`

const LINEAR_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/
const LINEAR_URL = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)/

/** The ticket key a PR carries in its title or branch, e.g. "WID-42". */
export function linearKeyOf(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const match = LINEAR_KEY.exec(text ?? '')
    if (match) return match[1]
  }
  return null
}

export function linearURL(key: string | null, workspace: string | null): string | null {
  return key && workspace ? `https://linear.app/${workspace}/issue/${key}` : null
}

/** Unread GitHub notifications, counted per pull request. Needs the notifications scope. */
async function unreadByPR(projectPath: string, repo: { owner: string; name: string }) {
  const counts = new Map<number, number>()
  try {
    const raw = JSON.parse(await gh(projectPath, ['api', '/notifications?per_page=100']))
    const prefix = `/repos/${repo.owner}/${repo.name}/pulls/`
    for (const entry of raw as any[]) {
      if (!entry?.unread || entry.subject?.type !== 'PullRequest') continue
      const url = String(entry.subject?.url ?? '')
      const at = url.indexOf(prefix)
      if (at < 0) continue
      const number = Number(url.slice(at + prefix.length))
      if (number) counts.set(number, (counts.get(number) ?? 0) + 1)
    }
  } catch { /* no notifications scope: the counts are simply absent */ }
  return counts
}

const checksOf = (state: string | undefined): PullRequest['checks'] =>
  !state ? '' : state === 'SUCCESS' ? 'pass'
    : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending'

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

/** One line per check on the head commit, in GitHub's own vocabulary reduced to four outcomes. */
export function checkRunsOf(contexts: any[]): CheckRun[] {
  return contexts.flatMap((node) => {
    if (!node) return []
    const isRun = node.__typename === 'CheckRun'
    const outcome = String((isRun ? node.conclusion : node.state) ?? '').toUpperCase()
    const result: CheckResult = FAILED.has(outcome) ? 'fail' : PASSED.has(outcome) ? 'pass'
      : SKIPPED.has(outcome) ? 'skipped' : 'pending'
    const name = String((isRun ? node.name : node.context) ?? '') || 'check'
    return [{ name, result, url: (isRun ? node.detailsUrl : node.targetUrl) ?? null }]
  })
}

const stateOf = (raw: any): PRState =>
  raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.isDraft ? 'draft' : 'open'

/**
 * The first tier: everything a row needs, in one GraphQL round trip plus the notifications
 * feed. Bodies, files, commits and threads wait for the second tier.
 */
export async function listPullRequests(projectPath: string, linearWorkspace: string | null): Promise<
  { ok: true; prs: PullRequest[]; viewer: string | null } | { ok: false; message: string }
> {
  try {
    const viewer = await viewerLogin(projectPath)
    const repo = await repoOf(projectPath)
    const [payload, unread] = await Promise.all([
      gh(projectPath, ['api', 'graphql', '-f', `query=${LIGHT_QUERY}`,
                       '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`]).then(JSON.parse),
      unreadByPR(projectPath, repo),
    ])
    const prs: PullRequest[] = []
    for (const raw of payload.data?.repository?.pullRequests?.nodes ?? []) {
      if (!raw?.number) continue
      const author = raw.author?.login ?? ''
      const reviewers = (raw.reviewRequests?.nodes ?? [])
        .map((node: any) => node?.requestedReviewer?.login ?? node?.requestedReviewer?.name ?? '')
        .filter(Boolean)
      const head = raw.commits?.nodes?.[0]?.commit
      const linearKey = linearKeyOf(raw.title, raw.headRefName)
      prs.push({
        number: raw.number, title: raw.title ?? '', url: raw.url ?? '',
        headRefName: raw.headRefName ?? '', baseRefName: raw.baseRefName ?? '',
        state: stateOf(raw), mergedAt: raw.mergedAt ?? null, closedAt: raw.closedAt ?? null,
        isDraft: !!raw.isDraft, author, authorAvatar: raw.author?.avatarUrl ?? '',
        assignees: (raw.assignees?.nodes ?? []).map((user: any) => ({ login: user.login, avatarUrl: user.avatarUrl ?? '' })),
        reviewers, reviewRequested: !!viewer && reviewers.includes(viewer),
        isMine: !!viewer && author === viewer,
        createdAt: raw.createdAt ?? '', updatedAt: raw.updatedAt ?? '',
        lastCommitAt: head?.committedDate ?? null,
        commitCount: raw.commits?.totalCount ?? 0,
        additions: raw.additions ?? 0, deletions: raw.deletions ?? 0, changedFiles: raw.changedFiles ?? 0,
        checks: checksOf(head?.statusCheckRollup?.state),
        checkRuns: checkRunsOf(head?.statusCheckRollup?.contexts?.nodes ?? []),
        unread: unread.get(raw.number) ?? 0,
        linearKey, linearURL: linearURL(linearKey, linearWorkspace),
        totals: null, activity: null, participants: null,
      })
    }
    return { ok: true, prs, viewer }
  } catch (error) {
    // An execFile failure always carries a message; stderr is git's own, better, words.
    const failure = error as { stderr?: string; message: string; code?: string }
    return {
      ok: false,
      message: failure.code === 'ENOENT'
        ? 'GitHub CLI (gh) is not installed or not on PATH.'
        : (failure.stderr || failure.message).trim(),
    }
  }
}

export interface PRDetails {
  totals: SplitTotals
  activity: PRActivity
  participants: Participant[]
  /** A Linear link found in the PR body itself. */
  linearURL: string | null
}

/** Everyone but the viewer who reviewed or commented, with their latest verdict and counts. */
export function participantsOf(pr: any, viewer: string): Participant[] {
  const people = new Map<string, Participant>()
  const person = (author: any): Participant | null => {
    const login = author?.login
    // Bots (Linear, CI) leave notes too; they are not teammates whose verdict you wait for.
    if (!login || login === viewer || author.__typename === 'Bot') return null
    if (!people.has(login)) {
      people.set(login, { login, avatarUrl: author.avatarUrl ?? '', verdict: null, inlineComments: 0, discussionComments: 0 })
    }
    return people.get(login)!
  }
  for (const review of pr.reviews?.nodes ?? []) {
    const who = person(review?.author)
    if (who && review.state !== 'PENDING' && review.state !== 'DISMISSED') who.verdict = review.state
  }
  for (const comment of pr.comments?.nodes ?? []) { const who = person(comment?.author); if (who) who.discussionComments += 1 }
  for (const thread of pr.reviewThreads?.nodes ?? []) {
    for (const comment of thread?.comments?.nodes ?? []) { const who = person(comment?.author); if (who) who.inlineComments += 1 }
  }
  return [...people.values()]
}

/**
 * The second tier: files, commits, comments and threads per PR. Also learns the Linear
 * workspace from any linear.app link in a body, so keys alone can be turned into links.
 */
export async function pullRequestDetails(projectPath: string, viewer: string): Promise<
  { details: Map<number, PRDetails>; linearWorkspace: string | null }
> {
  const details = new Map<number, PRDetails>()
  let linearWorkspace: string | null = null
  const repo = await repoOf(projectPath)
  const payload = JSON.parse(await gh(projectPath, [
    'api', 'graphql', '-f', `query=${DETAIL_QUERY}`, '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`]))
  for (const pr of payload.data?.repository?.pullRequests?.nodes ?? []) {
    if (!pr?.number) continue
    const mine = (node: any) => node?.author?.login === viewer
    const reviews = (pr.reviews?.nodes ?? []).filter(mine)
    const decisive = reviews.filter((review: any) => review.state !== 'PENDING' && review.state !== 'DISMISSED')
    const threads = pr.reviewThreads?.nodes ?? []
    const open = threads.filter((thread: any) => !thread.isResolved)
    const link = LINEAR_URL.exec(pr.bodyText ?? '')
    if (link) linearWorkspace = link[1]
    details.set(pr.number, {
      totals: splitTotals((pr.files?.nodes ?? []).map((file: any) => ({
        path: file.path ?? '', added: file.additions ?? 0, removed: file.deletions ?? 0,
      }))),
      linearURL: link?.[0] ?? null,
      participants: participantsOf(pr, viewer),
      activity: {
        inlineComments: threads.reduce((total: number, thread: any) =>
          total + (thread.comments?.nodes ?? []).filter(mine).length, 0),
        discussionComments: (pr.comments?.nodes ?? []).filter(mine).length,
        commits: (pr.commits?.nodes ?? []).filter((node: any) => node?.commit?.author?.user?.login === viewer).length,
        reviews: reviews.length,
        reviewState: decisive.at(-1)?.state ?? null,
        threadsOpen: open.length,
        threadsResolved: threads.length - open.length,
        // Yours to answer: it is your PR or you spoke in the thread, and someone else spoke last.
        threadsForMe: open.filter((thread: any) => {
          const comments = thread.comments?.nodes ?? []
          if (!comments.length || mine(comments[comments.length - 1])) return false
          return pr.author?.login === viewer || comments.some(mine)
        }).length,
      },
    })
  }
  return { details, linearWorkspace }
}

export interface PRComment {
  id: string
  prNumber: number
  prTitle: string
  prBranch: string
  author: string
  body: string
  url: string
  createdAt: string
  path?: string
  kind: 'review' | 'discussion'
}

const COMMENTS_QUERY = `
query($search: String!) {
  search(query: $search, type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number title headRefName author { login }
        comments(last: 40) { nodes { id author { login __typename } body url createdAt } }
        reviews(last: 30) { nodes { id author { login __typename } body url createdAt } }
        reviewThreads(last: 60) {
          nodes { comments(last: 30) { nodes { id author { login __typename } body url createdAt path } } }
        }
      }
    }
  }
}`

const repoCache = new Map<string, { owner: string; name: string }>()

async function repoOf(projectPath: string) {
  const cached = repoCache.get(projectPath)
  if (cached) return cached
  const raw = JSON.parse(await gh(projectPath, ['repo', 'view', '--json', 'owner,name']))
  const repo = { owner: raw.owner.login as string, name: raw.name as string }
  repoCache.set(projectPath, repo)
  return repo
}

/**
 * Comments other people left on the viewer's own open PRs, newest first. One GraphQL round
 * trip: discussion comments, review summaries and inline review threads together.
 */
export async function listMyPRComments(projectPath: string): Promise<
  { ok: true; comments: PRComment[] } | { ok: false; message: string }
> {
  try {
    const viewer = await viewerLogin(projectPath)
    if (!viewer) return { ok: false, message: 'Not signed in to GitHub (gh auth login).' }
    const repo = await repoOf(projectPath)
    const payload = JSON.parse(await gh(projectPath, [
      'api', 'graphql', '-f', `query=${COMMENTS_QUERY}`,
      '-F', `search=repo:${repo.owner}/${repo.name} is:pr is:open author:${viewer}`,
    ]))

    const comments: PRComment[] = []
    for (const pr of payload.data?.search?.nodes ?? []) {
      if (!pr?.number) continue
      const add = (raw: any, kind: PRComment['kind']) => {
        const author = raw.author?.login ?? ''
        // Your own replies and bot chatter are not things to action.
        if (!raw.body?.trim() || author === viewer || raw.author?.__typename === 'Bot') return
        comments.push({
          id: `${kind}-${raw.id}`, prNumber: pr.number, prTitle: pr.title,
          prBranch: pr.headRefName, author, body: raw.body, url: raw.url,
          createdAt: raw.createdAt, path: raw.path, kind,
        })
      }
      for (const comment of pr.comments?.nodes ?? []) add(comment, 'discussion')
      for (const review of pr.reviews?.nodes ?? []) add(review, 'review')
      for (const thread of pr.reviewThreads?.nodes ?? []) {
        for (const comment of thread.comments?.nodes ?? []) add(comment, 'review')
      }
    }
    comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    return { ok: true, comments }
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    return { ok: false, message: (failure.stderr || failure.message).trim() }
  }
}

/**
 * The reviewer to run for a project: its own `code-review-<project>` skill when one exists,
 * otherwise the generic reviewer.
 */
export function reviewerCommand(projectName: string, projectPath: string, home = homedir()): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const candidates = [
    join(projectPath, `.claude/skills/code-review-${slug}/SKILL.md`),
    join(projectPath, `.claude/commands/code-review-${slug}.md`),
    join(home, `.claude/skills/code-review-${slug}/SKILL.md`),
    join(home, `.claude/commands/code-review-${slug}.md`),
  ]
  return candidates.some(existsSync) ? `/code-review-${slug}` : '/code-review'
}


const THREADS_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url headRefOid
        comments(last: 50) { nodes { id author { login avatarUrl } body url createdAt } }
        reviewThreads(first: 100) {
          nodes {
            id isOutdated isResolved path line originalLine
            comments(first: 50) { nodes { id author { login avatarUrl } body url createdAt diffHunk } }
          }
        }
      }
    }
  }
}`

const commentsOf = (raw: any): PRThreadComment[] =>
  (raw?.nodes ?? []).filter((node: any) => node?.body?.trim()).map((node: any) => ({
    id: node.id,
    author: node.author?.login ?? 'ghost',
    avatarURL: node.author?.avatarUrl ?? null,
    body: node.body,
    createdAt: node.createdAt,
    url: node.url,
  }))

/**
 * Every conversation on the pull request for `branch`: the inline review threads with the line
 * they are anchored to, and the general comments. Threads GitHub marks outdated keep the diff
 * they were written against, because there is no line left to show them beside.
 */
export async function pullRequestConversations(projectPath: string, branch: string): Promise<PRConversationResult> {
  try {
    const repo = await repoOf(projectPath)
    const payload = JSON.parse(await gh(projectPath, [
      'api', 'graphql', '-f', `query=${THREADS_QUERY}`,
      '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`, '-F', `branch=${branch}`,
    ]))
    const pr = payload.data?.repository?.pullRequests?.nodes?.[0]
    if (!pr?.number) return { ok: false, message: `No pull request for ${branch}.` }

    const threads: PRThread[] = (pr.reviewThreads?.nodes ?? []).map((node: any) => {
      const comments = commentsOf(node.comments)
      return {
        id: node.id,
        path: node.path ?? null,
        // GitHub reports no line once a thread is outdated; keep where it was written.
        line: node.isOutdated ? null : node.line ?? null,
        originalLine: node.originalLine ?? node.line ?? null,
        outdated: !!node.isOutdated,
        resolved: !!node.isResolved,
        snippet: (node.comments?.nodes ?? [])[0]?.diffHunk ?? null,
        comments,
      }
    }).filter((thread: PRThread) => thread.comments.length)

    const general = commentsOf(pr.comments)
    if (general.length) {
      threads.push({ id: `pr-${pr.number}-discussion`, path: null, line: null, originalLine: null,
                     outdated: false, resolved: false, snippet: null, comments: general })
    }
    return { ok: true, number: pr.number, title: pr.title, url: pr.url, headSHA: pr.headRefOid, threads }
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    return { ok: false, message: (failure.stderr || failure.message).trim() }
  }
}

/** Posts a review comment on one line of the head commit. Only lines in that commit can carry one. */
export async function postLineComment(options: {
  projectPath: string; prNumber: number; commitSHA: string; file: string; line: number; body: string
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const repo = await repoOf(options.projectPath)
    const raw = JSON.parse(await gh(options.projectPath, [
      'api', '--method', 'POST',
      `/repos/${repo.owner}/${repo.name}/pulls/${options.prNumber}/comments`,
      '-f', `body=${options.body}`, '-f', `commit_id=${options.commitSHA}`,
      '-f', `path=${options.file}`, '-F', `line=${options.line}`, '-f', 'side=RIGHT',
    ]))
    return { ok: true, url: raw.html_url ?? '' }
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    return { ok: false, message: (failure.stderr || failure.message).trim() }
  }
}
