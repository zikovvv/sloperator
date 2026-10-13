import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { git, gitResult, currentBranch, defaultBranch, type GitResult } from './git.ts'
import { suggestBranchName } from '../shared/branchName.ts'

/** git puts its reason on stderr; without it the user sees "failed:" and nothing else. */
export function gitFailure(what: string, result: GitResult): string {
  return `${what} failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
}

/** Where worktrees live: the setting, else the test seam, else ~/.orchestrator/worktrees. */
export function worktreeRoot(override?: string | null): string {
  const fallback = process.env.ORCHESTRATOR_WORKTREE_ROOT ?? join(homedir(), '.orchestrator/worktrees')
  return override ? override.replace(/^~/, homedir()) : fallback
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'work'
}

function root(projectName: string, override?: string | null, group?: string | null): string {
  const base = worktreeRoot(override)
  // Only the group the caller actually asked for is ever created.
  return group ? join(base, projectName, group) : join(base, projectName)
}

/** "origin/team/login" -> "team/login": only the remote name is stripped. */
async function localNameForRemote(repo: string, ref: string): Promise<string> {
  const remotes = (await git(repo, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
  for (const remote of remotes) {
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1)
  }
  const slash = ref.indexOf('/')
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

async function isLocalBranch(repo: string, name: string): Promise<boolean> {
  return (await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`, '--']))
    !== undefined && (await git(repo, ['rev-parse', '--verify', `refs/heads/${name}`])).trim() !== ''
}

export interface CreateWorktreeOptions {
  projectPath: string
  projectName: string
  name: string
  branch?: string | null
  base?: string | null
  checkoutExisting?: boolean
  rootOverride?: string | null
  group?: string | null
}

export async function createWorktree(options: CreateWorktreeOptions) {
  const directory = root(options.projectName, options.rootOverride, options.group)
  mkdirSync(directory, { recursive: true })

  const requested = options.branch?.trim() || ''
  const taken = (await git(options.projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n')
  const wanted = requested || (options.name ? `orch/${slug(options.name)}` : suggestBranchName(taken))
  let branchName = wanted
  let path = join(directory, slug(branchName.replace(/^orch\//, '')))
  let attempt = 1

  if (options.checkoutExisting && requested) {
    while (existsSync(path)) { attempt += 1; path = `${path}-${attempt}` }
    const local = await isLocalBranch(options.projectPath, requested)
    const args = local
      ? ['worktree', 'add', path, requested]
      : ['worktree', 'add', '--track', '-b', await localNameForRemote(options.projectPath, requested), path, requested]
    const added = await gitResult(options.projectPath, args)
    if (!existsSync(path)) throw new Error(gitFailure('git worktree add', added))
    return { path, branch: local ? requested : await localNameForRemote(options.projectPath, requested) }
  }

  while (existsSync(path) || (await git(options.projectPath, ['rev-parse', '--verify', `refs/heads/${branchName}`])).trim()) {
    attempt += 1
    branchName = `${wanted}-${attempt}`
    path = join(directory, slug(branchName.replace(/^orch\//, '')))
  }

  // No fork point given: the freshest main there is, so the work does not start behind.
  const base = options.base || await latestDefault(options.projectPath)
  const added = await gitResult(options.projectPath, ['worktree', 'add', '-b', branchName, path, base])
  if (!existsSync(path)) throw new Error(gitFailure('git worktree add', added))
  return { path, branch: branchName, base }
}

/** origin/<default> after a fetch when there is an origin, otherwise the local default branch. */
export async function latestDefault(projectPath: string): Promise<string> {
  const name = await defaultBranch(projectPath)
  await gitResult(projectPath, ['fetch', '--quiet', 'origin', name])
  const remote = (await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])).trim()
  return remote ? `origin/${name}` : name
}

export interface SwitchOptions {
  /** Rename the branch the worktree is on. */
  rename?: string
  /** Check out an existing branch (local, or origin/<name>) instead. */
  branch?: string
  /** Re-fork a still-untouched worktree from another base. */
  base?: string
  /** What it forked from so far; commits past it are the worktree's own work. */
  currentBase?: string | null
}

/** Changes what a worktree is on. Each step is one git command whose refusal is the error. */
export async function switchBranch(projectPath: string, worktreePath: string, options: SwitchOptions): Promise<{ branch: string | null; base: string | null }> {
  let base: string | null = null
  if (options.rename?.trim()) {
    const next = options.rename.trim()
    // A detached HEAD has no branch to rename; naming it starts one here instead.
    const detached = (await currentBranch(worktreePath)) === 'HEAD'
    const renamed = detached
      ? await gitResult(worktreePath, ['switch', '-c', next])
      : await gitResult(worktreePath, ['branch', '-m', next])
    if (!renamed.ok) throw new Error(gitFailure(detached ? 'git switch -c' : 'git branch -m', renamed))
  }
  if (options.branch?.trim()) {
    const target = options.branch.trim()
    const local = await isLocalBranch(projectPath, target)
    const checkedOut = local
      ? await gitResult(worktreePath, ['checkout', target])
      : await gitResult(worktreePath, ['checkout', '--track', '-b', await localNameForRemote(projectPath, target), target])
    if (!checkedOut.ok) throw new Error(gitFailure('git checkout', checkedOut))
  }
  if (options.base?.trim()) {
    const target = options.base.trim()
    // Only a worktree with nothing of its own yet can be re-forked: no changes, no commits of its own.
    const dirty = (await git(worktreePath, ['status', '--porcelain'])).trim()
    const own = options.currentBase
      ? (await git(worktreePath, ['rev-list', '--count', `${options.currentBase}..HEAD`])).trim() : '0'
    if (dirty || own !== '0') {
      throw new Error('This worktree already has work of its own; it cannot be re-forked')
    }
    const reset = await gitResult(worktreePath, ['reset', '--hard', target])
    if (!reset.ok) throw new Error(gitFailure('git reset --hard', reset))
    base = target
  }
  return { branch: await currentBranch(worktreePath), base }
}

/**
 * Moves uncommitted work into a new worktree. Never uses bare `stash pop`: the stash stack is
 * repo-global, so it could apply and drop somebody else's entry.
 */
export async function moveCurrentWork(projectPath: string, worktreePath: string): Promise<string | null> {
  const status = (await git(projectPath, ['status', '--porcelain'])).trim()
  if (!status) return null

  const label = `orchestrator-move-${crypto.randomUUID()}`
  const push = await git(projectPath, ['stash', 'push', '--include-untracked', '-m', label])
  const list = await git(projectPath, ['stash', 'list', '--format=%gd %H %gs'])
  const entry = list.split('\n').find((line) => line.includes(label))
  if (!entry) return `Nothing was moved: git could not stash your work, which is untouched in the project. ${push.trim()}`.trim()
  const [, sha] = entry.split(' ')
  const applied = await gitResult(worktreePath, ['stash', 'apply', sha])
  const applyStatus = (await git(worktreePath, ['status', '--porcelain'])).trim()
  const conflicted = applyStatus.split('\n').some((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line))
  if (!applied.ok || !applyStatus || conflicted) {
    // The stash is the only clean copy of this work; never drop it after a partial apply.
    return conflicted
      ? 'Your work applied with conflicts. Resolve them here; the clean copy is still in `git stash list`.'
      : `Could not apply your work in the new worktree; it is preserved in \`git stash list\`: ${applied.stderr.trim()}`
  }
  // Re-resolve the ref: an agent stashing in the same repo meanwhile would shift the index.
  const fresh = (await git(projectPath, ['stash', 'list', '--format=%gd %H'])).split('\n').filter((line) => line.includes(sha))
  for (const line of fresh) await git(projectPath, ['stash', 'drop', line.split(' ')[0]])
  return null
}

/** Removes the folder and prunes. The branch and its commits are deliberately kept. */
export async function deleteWorktree(projectPath: string, worktreePath: string) {
  await git(projectPath, ['worktree', 'remove', '--force', worktreePath])
  // Whatever git would not remove (a folder that lost its .git) goes by hand; rmSync throws if it cannot.
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true })
    await git(projectPath, ['worktree', 'prune'])
  }
}

/**
 * Moves a worktree into another group directory. `git worktree move` keeps git's own
 * bookkeeping correct, which a plain `mv` would break.
 */
export async function moveWorktree(
  projectPath: string, projectName: string, currentPath: string,
  group: string | null, rootOverride?: string | null,
): Promise<string> {
  const directory = root(projectName, rootOverride, group)
  mkdirSync(directory, { recursive: true })
  let destination = join(directory, basename(currentPath))
  let attempt = 1
  while (existsSync(destination)) {
    attempt += 1
    destination = join(directory, `${basename(currentPath)}-${attempt}`)
  }
  const moved = await gitResult(projectPath, ['worktree', 'move', currentPath, destination])
  if (!existsSync(destination)) {
    throw new Error(gitFailure('git worktree move', moved))
  }
  return destination
}

/** Fetches a pull request's head into a local branch and checks it out in its own worktree. */
export async function createPRWorktree(options: {
  projectPath: string
  projectName: string
  prNumber: number
  group?: string | null
  rootOverride?: string | null
}) {
  const branch = `orch/pr-${options.prNumber}`
  const directory = root(options.projectName, options.rootOverride, options.group)
  mkdirSync(directory, { recursive: true })
  // A checkout of this PR that was removed from the app but kept on disk still holds the branch;
  // git will not give it to a second checkout, so it is taken back and brought up to the head.
  // git names it by its resolved path; the app knows it under the root as configured.
  const home = root(options.projectName, options.rootOverride)
  const kept = await checkoutOf(options.projectPath, branch)
  const inside = kept ? relative(realpathSync(home), kept) : '..'
  if (!inside.startsWith('..')) {
    const path = join(home, inside)
    await gitResult(path, ['pull', '--ff-only', 'origin', `pull/${options.prNumber}/head`])
    return { path, branch }
  }
  const fetched = await gitResult(options.projectPath,
    ['fetch', 'origin', `pull/${options.prNumber}/head:${branch}`, '--force'])
  const exists = (await git(options.projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim()
  if (!exists) throw new Error(`Could not fetch PR #${options.prNumber}: ${gitFailure('git fetch', fetched)}`)

  let path = join(directory, `pr-${options.prNumber}`)
  let attempt = 1
  while (existsSync(path)) { attempt += 1; path = join(directory, `pr-${options.prNumber}-${attempt}`) }

  const added = await gitResult(options.projectPath, ['worktree', 'add', path, branch])
  if (!existsSync(path)) {
    throw new Error(gitFailure('git worktree add', added))
  }
  return { path, branch }
}

/**
 * A worktree on a pull request's own branch. When that branch cannot be checked out — it lives on
 * a fork, or another worktree already holds it — the PR head is fetched into a copy instead.
 */
export async function createPRBranchWorktree(options: {
  projectPath: string
  projectName: string
  prNumber: number
  branch: string
  group?: string | null
  rootOverride?: string | null
}): Promise<{ path: string; branch: string; copied: boolean }> {
  // What GitHub says the PR's head commit is. A same-named local branch that is not that commit
  // belongs to someone else's work — a fork's PR, or a stale copy — and must not be opened as it.
  const listed = await git(options.projectPath, ['ls-remote', 'origin', `refs/pull/${options.prNumber}/head`])
  const [head] = listed.trim().split(/\s+/)

  // The branch may already be checked out by a worktree the app removed but kept on disk.
  const home = root(options.projectName, options.rootOverride)
  mkdirSync(home, { recursive: true })
  const kept = await checkoutOf(options.projectPath, options.branch)
  const inside = kept ? relative(realpathSync(home), kept) : '..'
  if (!inside.startsWith('..')) {
    const path = join(home, inside)
    await gitResult(path, ['pull', '--ff-only', 'origin', options.branch])
    return { path, branch: options.branch, copied: false }
  }
  const local = await isLocalBranch(options.projectPath, options.branch)
  if (!local) await gitResult(options.projectPath, ['fetch', 'origin', options.branch])
  const ref = local ? options.branch : `origin/${options.branch}`
  const reachable = (await git(options.projectPath, ['rev-parse', '--verify', '--quiet', ref])).trim()
  const taken = await branchesInUse(options.projectPath)
  const isPRHead = !head || reachable === head

  if (reachable && isPRHead && !taken.includes(options.branch)) {
    try {
      const created = await createWorktree({
        projectPath: options.projectPath, projectName: options.projectName,
        name: options.branch, branch: ref, checkoutExisting: true,
        group: options.group, rootOverride: options.rootOverride,
      })
      return { ...created, copied: false }
    } catch { /* fall through to a copy of the head */ }
  }
  return { ...await createPRWorktree(options), copied: true }
}

/** Where a branch is checked out, if any worktree of the repository has it. */
export async function checkoutOf(repo: string, branch: string): Promise<string | null> {
  const listing = await git(repo, ['worktree', 'list', '--porcelain'])
  const blocks = listing.split('\n\n').map((block) => block.split('\n'))
  const match = blocks.find((lines) => lines.includes(`branch refs/heads/${branch}`))
  return match?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? null
}

export async function branchesInUse(repo: string): Promise<string[]> {
  const listing = await git(repo, ['worktree', 'list', '--porcelain'])
  return listing.split('\n')
    .filter((line) => line.startsWith('branch '))
    .map((line) => line.slice('branch '.length).trim())
    // "refs/heads/feature/login" -> "feature/login": strip only the refs prefix.
    .map((ref) => ref.replace(/^refs\/heads\//, ''))
}

export async function describeProject(path: string) {
  return {
    name: basename(path),
    branch: await currentBranch(path),
    base: await defaultBranch(path),
  }
}
