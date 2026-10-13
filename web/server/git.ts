import { execFile } from 'node:child_process'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Never throws on a non-zero exit: git uses exit 1 for "there were differences". */
export interface GitResult {
  ok: boolean
  stdout: string
  /** git writes its errors here, so a failure with an empty stdout still has something to say. */
  stderr: string
}

/** Never throws: callers that only want output can ignore the rest. */
export async function gitResult(repo: string, args: string[]): Promise<GitResult> {
  try {
    // quotePath=false: git would otherwise octal-escape every non-ASCII path in diff
    // headers, status and ls-files, and nothing downstream could open the file.
    const { stdout, stderr } = await run('/usr/bin/git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return failureResult(error)
  }
}

/** What a failed git call comes back as; a spawn that never ran has no output, so its error stands in. */
export function failureResult(error: unknown): GitResult {
  const failure = error as { stdout?: string; stderr?: string; message: string }
  return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr || failure.message }
}

export async function git(repo: string, args: string[]): Promise<string> {
  return (await gitResult(repo, args)).stdout
}

export async function currentBranch(repo: string): Promise<string | null> {
  const value = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return value || null
}

export async function defaultBranch(repo: string): Promise<string> {
  const head = (await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])).trim()
  if (head.includes('/')) return head.slice(head.indexOf('/') + 1)
  for (const candidate of ['main', 'master']) {
    if ((await git(repo, ['rev-parse', '--verify', `refs/heads/${candidate}`])).trim()) {
      return candidate
    }
  }
  return (await currentBranch(repo)) ?? 'main'
}

/** Local branches (current first), then remote-only ones. Two git calls, never one per branch. */
export async function branches(repo: string, includeRemote = true): Promise<string[]> {
  const refs = async (pattern: string) =>
    (await git(repo, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', pattern]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD'))

  const locals = await refs('refs/heads')
  const head = await currentBranch(repo)
  if (head) {
    const index = locals.indexOf(head)
    if (index > 0) locals.splice(index, 1), locals.unshift(head)
  }
  if (!includeRemote) return locals
  const localNames = new Set(locals)
  const remotes = (await refs('refs/remotes')).filter(
    (ref) => !localNames.has(ref.split('/').slice(1).join('/')),
  )
  return [...locals, ...remotes]
}

export type DiffScope =
  | { kind: 'uncommitted' }
  | { kind: 'staged' }
  /** This branch against the branch it was opened against (the caller says which). */
  | { kind: 'branch' }
  /** This branch against the repository's default branch, whatever it forked from. */
  | { kind: 'main' }
  | { kind: 'remote' }
  | { kind: 'commit'; sha: string }
  /** Two snapshots of the working tree, as `snapshotTree` makes them. */
  | { kind: 'turn'; before: string; after: string }

/**
 * The whole working tree — tracked, untracked, minus what is ignored — as a tree object, without
 * touching the real index: a throwaway index is filled from HEAD, then from disk, then written.
 * Null when there is no repository to speak of.
 */
export async function snapshotTree(repo: string): Promise<string | null> {
  const index = join(tmpdir(), `orch-index-${process.pid}-${crypto.randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const call = (args: string[]) => run('/usr/bin/git', ['-C', repo, ...args], { env, encoding: 'utf8' })
  try {
    // A repository with no commit yet has no HEAD to start from; disk alone is the whole picture then.
    await call(['read-tree', 'HEAD']).catch(() => {})
    await call(['add', '-A'])
    // write-tree yields the tree's sha; an empty result is impossible here, and any real failure throws.
    return (await call(['write-tree'])).stdout.trim()
  } catch {
    return null
  } finally {
    rmSync(index, { force: true })
  }
}

async function mergeBase(repo: string, base: string): Promise<string | null> {
  const value = (await git(repo, ['merge-base', base, 'HEAD'])).trim()
  return value || null
}

/**
 * The remote-tracking ref for a branch when there is one, else the name as given: the local
 * branch may be far behind what GitHub compares against, and the fork point must be found from
 * the same history it uses.
 */
export async function resolveRef(repo: string, name: string): Promise<string> {
  const remote = `origin/${name}`
  const known = (await git(repo, ['rev-parse', '--verify', '-q', remote])).trim()
  return known ? remote : name
}

/** Brings origin's copy of a branch (or all of them) up to date; a machine that cannot reach it keeps what it has. */
export async function fetchBranch(repo: string, name?: string): Promise<void> {
  try {
    await run('/usr/bin/git', ['-C', repo, 'fetch', '--quiet', 'origin', ...(name ? [name] : [])], { encoding: 'utf8', timeout: 15_000 })
  } catch { /* offline, or no such branch on origin */ }
}

async function scopeArgs(repo: string, scope: DiffScope, base?: string | null): Promise<string[]> {
  switch (scope.kind) {
    case 'uncommitted':
      return ['diff', 'HEAD']
    case 'staged':
      return ['diff', '--cached']
    case 'branch':
    case 'main': {
      // From the fork point to the working tree: what this branch adds, the way a pull request shows it.
      const target = base ? await mergeBase(repo, await resolveRef(repo, base)) : null
      return ['diff', target ?? 'HEAD']
    }
    case 'remote': {
      const upstream = (
        await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
      ).trim()
      return ['diff', upstream || 'HEAD']
    }
    case 'commit':
      return ['show', '--format=', scope.sha]
    case 'turn':
      return ['diff', scope.before, scope.after]
    default:
      throw new Error(`Unknown diff scope: ${(scope as { kind: string }).kind}`)
  }
}

/** The whole file on each side of a scope, the way the review shows it; null where it does not exist. */
export async function sides(
  repo: string, scope: DiffScope, base: string | null | undefined, file: string,
): Promise<{ before: string | null; after: string | null }> {
  const at = async (ref: string) => { const shown = await gitResult(repo, ['show', `${ref}:${file}`]); return shown.ok ? shown.stdout : null }
  const onDisk = () => { const path = join(repo, file); return existsSync(path) ? readFileSync(path, 'utf8') : null }
  switch (scope.kind) {
    case 'uncommitted': return { before: await at('HEAD'), after: onDisk() }
    case 'staged': return { before: await at('HEAD'), after: await at('') }   // ":file" is the index
    case 'branch':
    case 'main': {
      const target = base ? await mergeBase(repo, await resolveRef(repo, base)) : null
      return { before: await at(target ?? 'HEAD'), after: onDisk() }
    }
    case 'remote': {
      const upstream = (await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
      return { before: await at(upstream || 'HEAD'), after: onDisk() }
    }
    case 'commit': return { before: await at(`${scope.sha}^`), after: await at(scope.sha) }
    case 'turn': return { before: await at(scope.before), after: await at(scope.after) }
    default: throw new Error(`Unknown diff scope: ${(scope as { kind: string }).kind}`)
  }
}

const MAX_UNTRACKED = 60

export async function diff(
  repo: string, scope: DiffScope, base?: string | null, context = 3,
): Promise<string> {
  const args = await scopeArgs(repo, scope, base)
  let text = await git(repo, [...args, `-U${context}`])

  // Untracked files are in no diff; synthesise one so new work is reviewable. Capped, because
  // each costs a git process and a stray build directory would stall every refresh.
  if (scope.kind === 'uncommitted') {
    const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED)
    for (const file of untracked) {
      text += await git(repo, ['diff', '--no-index', `-U${context}`, '--', '/dev/null', file])
    }
  }
  return text
}

export interface CommitInfo {
  sha: string
  shortSHA: string
  subject: string
  author: string
  relativeDate: string
}

export async function commits(repo: string, base?: string | null, limit = 100): Promise<CommitInfo[]> {
  const args = ['log', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar', '-n', String(limit)]
  if (base) {
    const merge = await mergeBase(repo, await resolveRef(repo, base))
    if (merge) args.push(`${merge}..HEAD`)
  }
  return (await git(repo, args))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f'))
    .filter((parts) => parts.length >= 5)
    .map(([sha, shortSHA, subject, author, relativeDate]) => ({
      sha, shortSHA, subject, author, relativeDate,
    }))
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
}
