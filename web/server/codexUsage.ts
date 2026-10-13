import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexHome } from './models.ts'
import { planLabel, type PlanLimit, type PlanUsage } from './planUsage.ts'
import {
  ANY_MODEL, mergeEvents, reportFrom, scan,
  type CacheEntry, type ClaudePricing, type Event, type UsageReport,
} from './usage.ts'

interface RateWindow { used_percent: number; window_minutes: number; resets_at: number }

/** What Codex was told about the plan's limits on one request. */
export interface RateReading {
  at: number
  limit: string
  name: string | null
  plan: string | null
  windows: RateWindow[]
}

interface Rollout { events: Event[]; readings: RateReading[] }

/** Codex keeps a session's log in `sessions`, and moves it to `archived_sessions` when the session is archived. */
const caches = { sessions: new Map<string, CacheEntry<Rollout>>(), archived_sessions: new Map<string, CacheEntry<Rollout>>() }
const DAY = 24 * 3600 * 1000
const count = (value: unknown) => Number(value) || 0

/** The folder a Codex session ran in, shown the way Claude's projects are: without the home prefix. */
export function projectOfFolder(folder: unknown, home = homedir()): string {
  const path = String(folder || 'unknown')
  const relative = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path
  return relative.replace(/^Projects\//, '')
}

/** One Codex session log: a request per token count, and the newest limits reading per limit. */
export function parseRollout(path: string): Rollout {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { events: [], readings: [] } }
  const events: Event[] = []
  const readings = new Map<string, RateReading>()
  let model = 'unknown'
  let project = 'unknown'
  let lastTotal = -1
  for (const line of text.split('\n')) {
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const payload = entry?.payload
    if (!payload) continue
    if (entry.type === 'session_meta') project = projectOfFolder(payload.cwd)
    if (entry.type === 'turn_context') {
      if (payload.model) model = String(payload.model)
      // A thread resumed somewhere else says so on each turn; the session's first folder is only where it began.
      if (payload.cwd) project = projectOfFolder(payload.cwd)
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue
    const timestamp = Date.parse(entry.timestamp)
    if (!Number.isFinite(timestamp)) continue
    const limits = payload.rate_limits
    if (limits) {
      const limit = String(limits.limit_id || 'codex')
      readings.set(limit, {
        at: timestamp, limit, name: limits.limit_name || null, plan: limits.plan_type || null,
        windows: [limits.primary, limits.secondary].filter(Boolean),
      })
    }
    const last = payload.info?.last_token_usage
    const total = count(payload.info?.total_token_usage?.total_tokens)
    // Codex repeats the count when nothing was spent in between; that is not another request.
    if (!last || total === lastTotal) continue
    lastTotal = total
    const cached = count(last.cached_input_tokens)
    events.push({
      timestamp, model, project,
      input: Math.max(0, count(last.input_tokens) - cached), cacheRead: cached, cacheWrite: 0,
      output: count(last.output_tokens),
      // A forked session copies its parent's log, so the same request can sit in two files.
      key: `${timestamp}|${total}`,
    })
  }
  return { events, readings: [...readings.values()] }
}

async function rollouts(now: number): Promise<Rollout[]> {
  const cutoff = now - 30 * DAY
  const found: Rollout[] = []
  for (const [folder, cache] of Object.entries(caches)) {
    found.push(...await scan(join(codexHome(), folder), cutoff, cache, parseRollout))
  }
  // A log is remembered whole: requests that have since left the window are cut here.
  return found.map((rollout) => ({ ...rollout, events: rollout.events.filter((event) => event.timestamp >= cutoff) }))
}

/** Settings hold one Codex rate; cached input is the only discount and writing the cache is free. */
export function codexRates(rates: { input: number; cached: number; output: number }): ClaudePricing {
  return { [ANY_MODEL]: { input: rates.input, cacheRead: rates.cached, cacheWrite: 0, output: rates.output } }
}

/** The same report the Claude side gets, from Codex's own session logs. */
export async function codexUsageReport(pricing: ClaudePricing, now = Date.now()): Promise<UsageReport> {
  const parsed = await rollouts(now)
  return reportFrom(mergeEvents(parsed.flatMap((rollout) => rollout.events)), pricing, parsed.length, now)
}

export function limitsFrom(readings: RateReading[], now: number): PlanLimit[] {
  // The plan-wide limit has no name of its own and leads, the way "All models" does for Claude.
  return [...readings].sort((a, b) => Number(!!a.name) - Number(!!b.name)).flatMap((reading) =>
    reading.windows.map((window) => {
      const resets = window.resets_at * 1000
      const live = resets > now
      const isSession = window.window_minutes <= 24 * 60
      return {
        kind: `${reading.limit}-${window.window_minutes}`,
        group: isSession ? 'session' : 'weekly',
        label: isSession ? (reading.name ?? 'Current session') : (reading.name ?? 'All models'),
        // A window that has reset since Codex last asked starts again from nothing.
        percent: live ? window.used_percent : 0,
        resetsAt: live ? new Date(resets).toISOString() : null,
        isActive: live,
      }
    }))
}

/** The plan's limits as Codex last heard them: it is told on every request and writes that down. */
export async function codexPlanUsage(now = Date.now()): Promise<PlanUsage | { error: string }> {
  const newest = new Map<string, RateReading>()
  for (const reading of (await rollouts(now)).flatMap((rollout) => rollout.readings)) {
    if (reading.at > (newest.get(reading.limit)?.at ?? 0)) newest.set(reading.limit, reading)
  }
  const readings = [...newest.values()].sort((a, b) => b.at - a.at)
  if (!readings.length) return { error: 'Codex has not run on this machine in the last 30 days, so it has no limits to show.' }
  const latest = readings[0]
  return {
    plan: planLabel(undefined, latest.plan ?? undefined),
    limits: limitsFrom(readings, now),
    extra: null,
    fetchedAt: latest.at,
  }
}
