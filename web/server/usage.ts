import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ModelRates { input: number; cacheRead: number; cacheWrite: number; output: number }
export type ClaudePricing = Record<string, ModelRates>

/** USD per million tokens. Fable has no published rate here, so it assumes Opus pricing. */
export const DEFAULT_CLAUDE_PRICING: ClaudePricing = {
  opus:   { input: 15,  cacheRead: 1.5,  cacheWrite: 18.75, output: 75 },
  fable:  { input: 15,  cacheRead: 1.5,  cacheWrite: 18.75, output: 75 },
  sonnet: { input: 3,   cacheRead: 0.3,  cacheWrite: 3.75,  output: 15 },
  haiku:  { input: 0.8, cacheRead: 0.08, cacheWrite: 1,     output: 4 },
}

export interface Tokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface Bucket extends Tokens {
  messages: number
  costUSD: number
}

export interface UsageBlock extends Bucket {
  start: number
  end: number
  isActive: boolean
  byModel: Record<string, Bucket>
}

export interface UsageReport {
  blocks: UsageBlock[]
  today: Bucket
  last7: Bucket
  last30: Bucket
  byModel: Record<string, Bucket>
  daily: Array<{ date: string; byModel: Record<string, Bucket> } & Bucket>
  byProject: Array<{ project: string } & Bucket>
  pricing: ClaudePricing
  scannedFiles: number
}

export interface Event extends Tokens {
  timestamp: number
  model: string
  project: string
  key: string | null
}

export interface CacheEntry<T> { modified: number; size: number; parsed: T }

/** Re-parsing every transcript on a timer cost seconds of CPU, so memoise per file. */
const cache = new Map<string, CacheEntry<Event[]>>()

/** The rate for an engine whose models all cost the same. */
export const ANY_MODEL = '*'

export function shortModel(model: string): string {
  for (const name of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (model.includes(name)) return name
  }
  return model
}

export function costOf(tokens: Tokens, model: string, pricing: ClaudePricing): number {
  const rates = pricing[shortModel(model)] ?? pricing[ANY_MODEL]
  if (!rates) return 0
  return (tokens.input * rates.input + tokens.cacheRead * rates.cacheRead
    + tokens.cacheWrite * rates.cacheWrite + tokens.output * rates.output) / 1e6
}

function emptyBucket(): Bucket {
  return { messages: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUSD: 0 }
}

function add(bucket: Bucket, event: Event, pricing: ClaudePricing) {
  bucket.messages += 1
  bucket.input += event.input
  bucket.cacheRead += event.cacheRead
  bucket.cacheWrite += event.cacheWrite
  bucket.output += event.output
  bucket.costUSD += costOf(event, event.model, pricing)
}

/**
 * The transcript directory name is the project path with slashes replaced by dashes, which is
 * lossy, so the folder is shown minus the home prefix rather than guessed back into a path.
 */
export function projectOf(path: string, home = homedir()): string {
  const root = projectsRoot(home)
  const relative = path.startsWith(root) ? path.slice(root.length + 1) : path
  const folder = relative.split('/').filter(Boolean)[0] ?? relative
  const homeEncoded = home.replace(/\//g, '-')
  const trimmed = folder.startsWith(homeEncoded) ? folder.slice(homeEncoded.length) : folder
  return trimmed.replace(/^-+/, '').replace(/^Projects-/, '') || folder
}

function parseFile(path: string): Event[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const project = projectOf(path)
  const events: Event[] = []
  for (const line of text.split('\n')) {
    if (line.length < 40) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type !== 'assistant') continue
    const usage = obj.message?.usage
    if (!usage) continue
    const timestamp = Date.parse(obj.timestamp ?? '')
    if (!Number.isFinite(timestamp)) continue
    const model = obj.message?.model ?? 'unknown'
    if (model === '<synthetic>') continue
    const messageID = obj.message?.id ?? ''
    const requestID = obj.requestId ?? ''
    events.push({
      timestamp, model, project,
      input: usage.input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      // Claude Code writes one line per content block, each repeating the same usage.
      key: messageID || requestID ? `${messageID}|${requestID}` : null,
    })
  }
  return events
}

/** Where Claude Code keeps transcripts; tests point it at a throwaway tree. */
function projectsRoot(home = homedir()): string {
  return process.env.ORCHESTRATOR_CLAUDE_PROJECTS ?? join(home, '.claude/projects')
}

interface Found { path: string; modified: number; size: number }

function walk(directory: string, out: Found[], depth = 0) {
  if (depth > 6) return
  let entries: string[]
  try { entries = readdirSync(directory) } catch { return }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(directory, entry)
    let stats
    try { stats = statSync(path) } catch { continue }   // a dangling link
    if (stats.isDirectory()) walk(path, out, depth + 1)
    else if (entry.endsWith('.jsonl')) out.push({ path, modified: stats.mtimeMs, size: stats.size })
  }
}

/**
 * Parses every transcript under `root` touched since `cutoff`, re-reading only the files that changed.
 * A first scan reads gigabytes, so it steps aside after each file: running agents keep streaming.
 */
export async function scan<T>(root: string, cutoff: number, known: Map<string, CacheEntry<T>>, parse: (path: string) => T): Promise<T[]> {
  const files: Found[] = []
  walk(root, files)
  const seenPaths = new Set<string>()
  const parsed: T[] = []
  for (const { path, modified, size } of files) {
    if (modified < cutoff) continue
    seenPaths.add(path)
    let hit = known.get(path)
    if (!hit || hit.modified !== modified || hit.size !== size) {
      hit = { modified, size, parsed: parse(path) }
      known.set(path, hit)
      await new Promise((resolve) => setImmediate(resolve))
    }
    parsed.push(hit.parsed)
  }
  for (const key of known.keys()) if (!seenPaths.has(key)) known.delete(key)
  return parsed
}

/** Lines sharing a key describe ONE message and are merged, never summed. */
export function mergeEvents(events: Event[]): Event[] {
  const keyed = new Map<string, Event>()
  const unkeyed: Event[] = []
  for (const event of events) {
    if (!event.key) { unkeyed.push(event); continue }
    const existing = keyed.get(event.key)
    keyed.set(event.key, existing ? {
      ...event,
      timestamp: Math.min(existing.timestamp, event.timestamp),
      input: Math.max(existing.input, event.input),
      cacheRead: Math.max(existing.cacheRead, event.cacheRead),
      cacheWrite: Math.max(existing.cacheWrite, event.cacheWrite),
      output: Math.max(existing.output, event.output),
    } : event)
  }
  return [...unkeyed, ...keyed.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** Every assistant message since `cutoff`, one per message even when logged as several lines. */
export async function collectEvents(cutoff: number): Promise<{ events: Event[]; files: number }> {
  const parsed = await scan(projectsRoot(), cutoff, cache, parseFile)
  // A file is remembered whole: what has since left the window is cut here, not when it was read.
  return { events: mergeEvents(parsed.flat().filter((event) => event.timestamp >= cutoff)), files: parsed.length }
}

export function blocksFrom(events: Event[], pricing: ClaudePricing, now = Date.now()): UsageBlock[] {
  const FIVE_HOURS = 5 * 3600 * 1000
  const blocks: UsageBlock[] = []
  let current: UsageBlock | null = null
  let lastTimestamp = 0
  for (const event of events) {
    const needsNew = !current || event.timestamp >= current.end
      || event.timestamp - lastTimestamp >= FIVE_HOURS
    if (needsNew) {
      if (current) blocks.push(current)
      const start = Math.floor(event.timestamp / 3600000) * 3600000
      current = { start, end: start + FIVE_HOURS, isActive: false, byModel: {}, ...emptyBucket() }
    }
    add(current!, event, pricing)
    const label = shortModel(event.model)
    current!.byModel[label] ??= emptyBucket()
    add(current!.byModel[label], event, pricing)
    lastTimestamp = event.timestamp
  }
  if (current) blocks.push(current)
  for (const block of blocks) block.isActive = now < block.end
  return blocks
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function reportFrom(events: Event[], pricing: ClaudePricing, files: number, now = Date.now()): UsageReport {
  const DAY = 24 * 3600 * 1000
  const today = emptyBucket(), last7 = emptyBucket(), last30 = emptyBucket()
  const byModel: Record<string, Bucket> = {}
  const dailyMap = new Map<string, { date: string; byModel: Record<string, Bucket> } & Bucket>()
  const projectMap = new Map<string, Bucket>()
  const todayKey = localDate(now)

  for (const event of events) {
    const label = shortModel(event.model)
    add(last30, event, pricing)
    if (now - event.timestamp < 7 * DAY) add(last7, event, pricing)
    const day = localDate(event.timestamp)
    if (day === todayKey) add(today, event, pricing)

    byModel[label] ??= emptyBucket()
    add(byModel[label], event, pricing)

    let daily = dailyMap.get(day)
    if (!daily) { daily = { date: day, byModel: {}, ...emptyBucket() }; dailyMap.set(day, daily) }
    add(daily, event, pricing)
    daily.byModel[label] ??= emptyBucket()
    add(daily.byModel[label], event, pricing)

    let project = projectMap.get(event.project)
    if (!project) { project = emptyBucket(); projectMap.set(event.project, project) }
    add(project, event, pricing)
  }

  return {
    blocks: blocksFrom(events.filter((event) => now - event.timestamp < 30 * 3600 * 1000), pricing, now),
    today, last7, last30, byModel,
    daily: [...dailyMap.values()].sort((a, b) => b.date.localeCompare(a.date)),
    byProject: [...projectMap.entries()]
      .map(([project, bucket]) => ({ project, ...bucket }))
      .sort((a, b) => b.costUSD - a.costUSD),
    pricing,
    scannedFiles: files,
  }
}

export async function usageReport(pricing: ClaudePricing): Promise<UsageReport> {
  const { events, files } = await collectEvents(Date.now() - 30 * 24 * 3600 * 1000)
  return reportFrom(events, pricing, files)
}
