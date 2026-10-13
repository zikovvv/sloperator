import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexPlanUsage, codexRates, codexUsageReport, limitsFrom, parseRollout, projectOfFolder,
} from '../server/codexUsage.ts'
import { startHarness, type Harness } from './helpers/server.ts'

const NOW = Date.parse('2026-09-10T12:00:00Z')
const HOUR = 3600 * 1000
const stamp = (offset: number) => new Date(NOW + offset).toISOString()

const meta = (cwd: string) => ({ timestamp: stamp(-5 * HOUR), type: 'session_meta', payload: { cwd } })
const turn = (model: string) => ({ timestamp: stamp(-5 * HOUR), type: 'turn_context', payload: { model } })
function tokens(offset: number, total: number, last: { input: number; cached: number; output: number } | null, limits: unknown = null) {
  return {
    timestamp: stamp(offset), type: 'event_msg',
    payload: {
      type: 'token_count',
      info: last && {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output },
      },
      rate_limits: limits,
    },
  }
}
const weekly = (percent: number, resetsAt: number, extra: object = {}) => ({
  limit_id: 'codex', limit_name: null, plan_type: 'plus',
  primary: { used_percent: percent, window_minutes: 10080, resets_at: resetsAt / 1000 }, secondary: null, ...extra,
})

/** A Codex home holding the given session logs, each a list of entries (or raw lines). */
function codexHomeWith(files: Record<string, unknown[]>): string {
  const home = mkdtempSync(join(tmpdir(), 'orch-codex-usage-'))
  const folder = join(home, 'sessions', '2026', '09', '10')
  mkdirSync(folder, { recursive: true })
  for (const [name, entries] of Object.entries(files)) {
    writeFileSync(join(folder, `rollout-${name}.jsonl`),
      entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'))
  }
  return home
}
const fileIn = (home: string, name: string) => join(home, 'sessions', '2026', '09', '10', `rollout-${name}.jsonl`)

const original = process.env.ORCHESTRATOR_CODEX_HOME
afterEach(() => { process.env.ORCHESTRATOR_CODEX_HOME = original })

describe('parseRollout', () => {
  it('reads one request per token count, with the model and folder that were current', () => {
    const home = codexHomeWith({ a: [
      meta('/work/acme'), turn('gpt-example'),
      tokens(-4 * HOUR, 1000, { input: 900, cached: 400, output: 100 }),
      turn('gpt-other'),
      tokens(-3 * HOUR, 1600, { input: 500, cached: 0, output: 100 }),
    ] })
    const { events } = parseRollout(fileIn(home, 'a'))
    expect(events).toEqual([
      { timestamp: NOW - 4 * HOUR, model: 'gpt-example', project: '/work/acme', input: 500, cacheRead: 400, cacheWrite: 0, output: 100, key: `${NOW - 4 * HOUR}|1000` },
      { timestamp: NOW - 3 * HOUR, model: 'gpt-other', project: '/work/acme', input: 500, cacheRead: 0, cacheWrite: 0, output: 100, key: `${NOW - 3 * HOUR}|1600` },
    ])
  })

  it('follows a thread to the folder it was resumed in', () => {
    const home = codexHomeWith({ a: [
      meta('/work/acme'), turn('gpt-example'), tokens(-3 * HOUR, 10, { input: 5, cached: 0, output: 5 }),
      { ...turn('gpt-example'), payload: { model: 'gpt-example', cwd: '/work/other' } }, tokens(-2 * HOUR, 20, { input: 5, cached: 0, output: 5 }),
    ] })
    expect(parseRollout(fileIn(home, 'a')).events.map((event) => event.project)).toEqual(['/work/acme', '/work/other'])
  })

  it('counts a repeated total once, and skips what is unreadable', () => {
    const home = codexHomeWith({ a: [
      'not json at all', { type: 'event_msg' }, turn(''),
      tokens(-2 * HOUR, 300, { input: 150, cached: 0, output: 50 }),
      tokens(-1 * HOUR, 300, { input: 150, cached: 0, output: 50 }),
      { ...tokens(0, 900, { input: 1, cached: 0, output: 1 }), timestamp: 'whenever' },
      tokens(-0.5 * HOUR, 300, null),
    ] })
    const { events } = parseRollout(fileIn(home, 'a'))
    expect(events.map((event) => [event.timestamp, event.model, event.project, event.input, event.output]))
      .toEqual([[NOW - 2 * HOUR, 'unknown', 'unknown', 150, 50]])
    expect(parseRollout(join(home, 'missing.jsonl'))).toEqual({ events: [], readings: [] })
  })

  it('keeps the newest limits reading of each limit', () => {
    const home = codexHomeWith({ a: [
      tokens(-9 * HOUR, 100, { input: 100, cached: 0, output: 0 }, weekly(10, NOW + HOUR)),
      tokens(-2 * HOUR, 300, { input: 150, cached: 0, output: 50 }, weekly(25, NOW + HOUR)),
      tokens(-1 * HOUR, 300, null, {
        limit_name: 'Spark', primary: { used_percent: 5, window_minutes: 300, resets_at: 1 },
        secondary: { used_percent: 6, window_minutes: 10080, resets_at: 2 },
      }),
    ] })
    const { readings } = parseRollout(fileIn(home, 'a'))
    expect(readings).toEqual([
      { at: NOW - HOUR, limit: 'codex', name: 'Spark', plan: null, windows: [
        { used_percent: 5, window_minutes: 300, resets_at: 1 }, { used_percent: 6, window_minutes: 10080, resets_at: 2 }] },
    ])
  })
})

describe('projectOfFolder', () => {
  it('shows a folder without the home prefix, and says so when there is none', () => {
    expect(projectOfFolder('/Users/jane/Projects/acme', '/Users/jane')).toBe('acme')
    expect(projectOfFolder('/Users/jane/notes', '/Users/jane')).toBe('notes')
    expect(projectOfFolder('/srv/acme', '/Users/jane')).toBe('/srv/acme')
    expect(projectOfFolder(undefined)).toBe('unknown')
  })
})

describe('limitsFrom', () => {
  it('groups windows the way the plan page does, the plan-wide limit first', () => {
    const limits = limitsFrom([
      { at: 1, limit: 'spark', name: 'Spark', plan: 'plus', windows: [
        { used_percent: 9, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 },
        { used_percent: 8, window_minutes: 10080, resets_at: (NOW + 2 * HOUR) / 1000 }] },
      { at: 2, limit: 'codex', name: null, plan: 'plus', windows: [
        { used_percent: 40, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 },
        { used_percent: 70, window_minutes: 10080, resets_at: (NOW - HOUR) / 1000 }] },
    ], NOW)
    expect(limits).toEqual([
      { kind: 'codex-300', group: 'session', label: 'Current session', percent: 40, resetsAt: stamp(HOUR), isActive: true },
      // The week reset an hour ago: whatever was used then is gone.
      { kind: 'codex-10080', group: 'weekly', label: 'All models', percent: 0, resetsAt: null, isActive: false },
      { kind: 'spark-300', group: 'session', label: 'Spark', percent: 9, resetsAt: stamp(HOUR), isActive: true },
      { kind: 'spark-10080', group: 'weekly', label: 'Spark', percent: 8, resetsAt: stamp(2 * HOUR), isActive: true },
    ])
  })
})

describe('the Codex report and plan limits', () => {
  it('prices every model at the one Codex rate and counts a forked request once', async () => {
    const shared = tokens(-2 * HOUR, 2_000_000, { input: 1_500_000, cached: 500_000, output: 500_000 }, weekly(30, NOW + HOUR))
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({
      parent: [meta('/work/acme'), turn('gpt-example'), shared],
      fork: [meta('/work/acme'), turn('gpt-example'), shared,
        tokens(-1 * HOUR, 3_000_000, { input: 1_000_000, cached: 0, output: 0 }, weekly(35, NOW + HOUR))],
    })
    const report = await codexUsageReport(codexRates({ input: 2, cached: 0.5, output: 10 }), NOW)
    expect(report.scannedFiles).toBe(2)
    expect(report.last30.messages).toBe(2)
    // 1M + 1M uncached input at $2, 0.5M cached at $0.50, 0.5M output at $10.
    expect(report.last30.costUSD).toBeCloseTo(2 + 2 + 0.25 + 5, 6)
    expect(Object.keys(report.byModel)).toEqual(['gpt-example'])
    expect(report.byProject.map((entry) => entry.project)).toEqual(['/work/acme'])
    expect(report.pricing).toEqual({ '*': { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 10 } })

    const plan = await codexPlanUsage(NOW)
    expect(plan).toEqual({
      plan: 'Plus', extra: null, fetchedAt: NOW - HOUR,
      limits: [{ kind: 'codex-10080', group: 'weekly', label: 'All models', percent: 35, resetsAt: stamp(HOUR), isActive: true }],
    })
  })

  it('steps aside after each log it reads, so a long first scan does not hold up everything else the server does', async () => {
    const one = (offset: number, total: number) => [tokens(offset, total, { input: 10, cached: 0, output: 1 })]
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({ a: one(-3 * HOUR, 11), b: one(-2 * HOUR, 22), c: one(-1 * HOUR, 33) })
    let turns = 0
    let scanning = true
    const elsewhere = () => { if (scanning) { turns += 1; setImmediate(elsewhere) } }
    setImmediate(elsewhere)
    const report = await codexUsageReport(codexRates({ input: 1, cached: 1, output: 1 }), NOW)
    scanning = false
    expect(report.last30.messages).toBe(3)
    expect(turns).toBeGreaterThanOrEqual(3)   // other work ran once per file, not once at the end
  })

  it('counts sessions Codex has archived, which it keeps in a folder of their own', async () => {
    const home = codexHomeWith({ live: [meta('/work/acme'), turn('gpt-example'), tokens(-2 * HOUR, 20, { input: 10, cached: 0, output: 10 })] })
    mkdirSync(join(home, 'archived_sessions'))
    writeFileSync(join(home, 'archived_sessions', 'rollout-archived.jsonl'), [meta('/work/acme'), turn('gpt-example'),
      tokens(-1 * HOUR, 40, { input: 30, cached: 0, output: 10 }, weekly(55, NOW + HOUR))].map((entry) => JSON.stringify(entry)).join('\n'))
    process.env.ORCHESTRATOR_CODEX_HOME = home
    const report = await codexUsageReport(codexRates({ input: 1, cached: 1, output: 1 }), NOW)
    expect(report).toMatchObject({ scannedFiles: 2, last30: { messages: 2, input: 40 } })
    expect(await codexPlanUsage(NOW)).toMatchObject({ limits: [{ percent: 55 }] })
  })

  it('drops a request once it is more than 30 days old, though its log has not changed since it was read', async () => {
    const DAY = 24 * HOUR
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({ a: [
      tokens(-29 * DAY, 10, { input: 5, cached: 0, output: 5 }), tokens(-1 * DAY, 30, { input: 10, cached: 0, output: 10 })] })
    const rates = codexRates({ input: 1, cached: 1, output: 1 })
    expect((await codexUsageReport(rates, NOW)).last30.messages).toBe(2)
    expect((await codexUsageReport(rates, NOW + 2 * DAY)).last30.messages).toBe(1)
  })

  it('says so when Codex has not run here', async () => {
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({ a: [meta('/work/acme')] })
    expect(await codexPlanUsage(NOW)).toEqual({ error: expect.stringMatching(/Codex has not run on this machine/) })
    process.env.ORCHESTRATOR_CODEX_HOME = join(tmpdir(), 'orch-no-such-codex-home')
    expect((await codexUsageReport(codexRates({ input: 1, cached: 1, output: 1 }), NOW)).last30.messages).toBe(0)
  })

  it('shows every limit Codex was told about, each from its newest reading, dated by the newest of all', async () => {
    const spark = (percent: number) => ({ ...weekly(percent, NOW + HOUR), limit_id: 'spark', limit_name: 'Spark', plan_type: 'pro' })
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({
      a: [tokens(-3 * HOUR, 10, null, spark(50)), tokens(-2 * HOUR, 10, null, weekly(20, NOW + HOUR))],
      b: [tokens(-1 * HOUR, 10, null, spark(60)), tokens(-4 * HOUR, 10, null, weekly(5, NOW + HOUR))],
    })
    const plan = await codexPlanUsage(NOW)
    expect(plan).toMatchObject({ plan: 'Pro', fetchedAt: NOW - HOUR, limits: [{ label: 'All models', percent: 20 }, { label: 'Spark', percent: 60 }] })
  })

  it('names the plan "Plan" when Codex never said which', async () => {
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({ a: [
      tokens(-1 * HOUR, 10, null, { primary: { used_percent: 1, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 } }),
    ] })
    expect(await codexPlanUsage(NOW)).toMatchObject({ plan: 'Plan', limits: [{ label: 'Current session', percent: 1 }] })
  })
})

describe('the usage routes, per engine', () => {
  let harness: Harness
  beforeAll(async () => { harness = await startHarness() })
  afterAll(async () => { await harness.stop() })

  it('answers for Codex from its session logs and for Claude as before', async () => {
    const recent = new Date(Date.now() - HOUR).toISOString()
    process.env.ORCHESTRATOR_CODEX_HOME = codexHomeWith({ a: [
      meta('/work/acme'), turn('gpt-example'),
      { ...tokens(0, 150, { input: 100, cached: 0, output: 50 }, weekly(12, Date.now() + HOUR)), timestamp: recent },
    ] })
    const codex = await (await harness.get('/api/usage?engine=codex')).json()
    expect(codex.last30).toMatchObject({ messages: 1, input: 100, output: 50 })
    expect(Object.keys(codex.pricing)).toEqual(['*'])
    expect(Array.isArray(codex.sessions)).toBe(true)
    const plan = await (await harness.get('/api/plan-usage?engine=codex')).json()
    expect(plan.limits).toMatchObject([{ group: 'weekly', percent: 12 }])

    const claude = await (await harness.get('/api/usage?engine=claude')).json()
    expect(claude.last30.messages).toBe(0)
    expect(Object.keys(claude.pricing)).toContain('opus')
  })
})
