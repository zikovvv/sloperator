import { existsSync, readFileSync } from 'node:fs'
import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { listPullRequests, pullRequestDetails, linearURL, type PullRequest } from './github.ts'

export interface PRListing {
  ok: true
  viewer: string | null
  prs: PullRequest[]
  fetchedAt: number
  /** Second tier still on its way: ask `/api/prs/details` for the rest. */
  pending: boolean
}
export type PRResult = PRListing | { ok: false; message: string }

interface Entry { viewer: string | null; prs: PullRequest[]; fetchedAt: number; detailed: boolean }

/** Bumped whenever a cached row's shape changes; an older file is dropped rather than rendered. */
const CACHE_VERSION = 1

/** Older than this, a cached listing is served at once and refreshed behind it. */
export const FRESH_FOR = 2 * 60 * 1000

/**
 * Pull request listings per project: served from memory (and disk, across restarts) the
 * moment they are asked for, refreshed in two tiers behind the answer.
 */
export class PRCache {
  private entries = new Map<string, Entry>()
  private inFlight = new Map<string, Promise<Entry>>()

  constructor(
    private file: string,
    private linearWorkspace: () => string | null,
    private learnedWorkspace: (workspace: string) => void,
  ) {
    try {
      if (!existsSync(file)) return
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      // A file from another shape is worth less than a cold start: rows are rendered unchecked.
      if (stored?.version === CACHE_VERSION) this.entries = new Map(Object.entries(stored.entries))
    } catch { /* an unreadable cache is only a slower first paint */ }
  }

  /** What is known now. A cold or stale cache starts a refresh; a cold one waits for its first tier. */
  async list(projectID: string, projectPath: string, refresh = false): Promise<PRResult> {
    const cached = this.entries.get(projectID)
    const stale = !cached || refresh || Date.now() - cached.fetchedAt > FRESH_FOR || !cached.detailed
    if (stale && !this.inFlight.has(projectID)) {
      const run = this.refresh(projectID, projectPath)
      run.catch(() => {})   // the failure reaches whoever awaits the first tier; nobody else needs it twice
      this.inFlight.set(projectID, run)
    }
    // Whoever returns early leaves nobody awaiting the first tier; without this its rejection
    // would be unhandled and take the process down with it.
    this.firstTier.get(projectID)?.catch(() => {})
    if (cached && !refresh) return { ok: true, ...cached, pending: this.inFlight.has(projectID) }
    try {
      await this.firstTier.get(projectID)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
    const entry = this.entries.get(projectID)!
    return { ok: true, ...entry, pending: this.inFlight.has(projectID) }
  }

  /** Waits for whatever refresh is running, then answers with everything known. */
  async details(projectID: string, projectPath: string): Promise<PRResult> {
    const running = this.inFlight.get(projectID)
    if (running) await running.catch(() => {})
    const entry = this.entries.get(projectID)
    if (entry) return { ok: true, ...entry, pending: false }
    return this.list(projectID, projectPath)
  }

  /** What is in memory right now, without asking GitHub for anything. */
  peek(projectID: string): PullRequest[] {
    return this.entries.get(projectID)?.prs ?? []
  }

  /** Keeps a listing warm without anyone waiting on it — only when it has actually gone stale. */
  warm(projectID: string, projectPath: string) {
    void this.list(projectID, projectPath)   // list() never rejects: failures are its answer
  }

  private firstTier = new Map<string, Promise<void>>()

  private async refresh(projectID: string, projectPath: string): Promise<Entry> {
    let settle!: () => void; let fail!: (error: Error) => void
    this.firstTier.set(projectID, new Promise<void>((resolve, reject) => { settle = resolve; fail = reject }))
    try {
      const light = await listPullRequests(projectPath, this.linearWorkspace())
      if (!light.ok) throw new Error(light.message)
      const previous = this.entries.get(projectID)
      // Keep the last known second-tier data on each row until the new one lands.
      const carried = new Map((previous?.prs ?? []).map((pr) => [pr.number, pr]))
      const entry: Entry = {
        viewer: light.viewer, fetchedAt: Date.now(), detailed: false,
        prs: light.prs.map((pr) => {
          const old = carried.get(pr.number)
          return old ? { ...pr, totals: old.totals, activity: old.activity, participants: old.participants, linearURL: pr.linearURL ?? old.linearURL } : pr
        }),
      }
      this.entries.set(projectID, entry)
      settle()
      if (light.viewer) {
        try {
          const { details, linearWorkspace } = await pullRequestDetails(projectPath, light.viewer)
          if (linearWorkspace && linearWorkspace !== this.linearWorkspace()) this.learnedWorkspace(linearWorkspace)
          const workspace = this.linearWorkspace()
          for (const pr of entry.prs) {
            const detail = details.get(pr.number)
            if (detail) { pr.totals = detail.totals; pr.activity = detail.activity; pr.participants = detail.participants }
            pr.linearURL = detail?.linearURL ?? pr.linearURL ?? linearURL(pr.linearKey, workspace)
          }
        } catch {
          // The first tier is still worth keeping. Marking it detailed anyway stops every later
          // read from seeing "stale" and starting another full refetch of a tier that is failing.
        }
        entry.detailed = true
      } else {
        entry.detailed = true
      }
      this.persist()
      return entry
    } catch (error) {
      fail(error as Error)
      throw error
    } finally {
      this.inFlight.delete(projectID)
      this.firstTier.delete(projectID)
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp-${process.pid}`
      writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }))
      renameSync(temporary, this.file)
    } catch { /* a cache that could not be written costs one cold load later */ }
  }
}
