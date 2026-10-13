import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_PRICING, blocksFrom, costOf, projectOf, reportFrom, shortModel } from '../server/usage.ts'

const at = (iso: string) => Date.parse(iso)
const event = (iso: string, model: string, tokens: Partial<{ input: number; cacheRead: number; cacheWrite: number; output: number }> = {}, project = 'acme') => ({
  timestamp: at(iso), model, project, key: null,
  input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...tokens,
})

describe('costOf', () => {
  it('prices each token kind at its own rate, per million', () => {
    const cost = costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 },
      'claude-sonnet-5', DEFAULT_CLAUDE_PRICING)
    expect(cost).toBeCloseTo(3 + 0.3 + 15, 6)
  })
  it('maps full model ids to their family', () => {
    expect(shortModel('claude-opus-5-20260401')).toBe('opus')
    expect(shortModel('claude-fable-5-1')).toBe('fable')
  })
  it('costs nothing for a model with no rate rather than guessing', () => {
    expect(costOf({ input: 100, cacheRead: 0, cacheWrite: 0, output: 100 }, 'mystery', DEFAULT_CLAUDE_PRICING)).toBe(0)
  })
})

describe('blocksFrom', () => {
  it('opens a new five-hour window on the hour of the first message and again after a gap', () => {
    const now = at('2026-09-02T18:00:00Z')
    const blocks = blocksFrom([
      event('2026-09-02T09:20:00Z', 'claude-opus-5', { output: 10 }),
      event('2026-09-02T11:00:00Z', 'claude-opus-5', { output: 10 }),
      event('2026-09-02T16:30:00Z', 'claude-sonnet-5', { output: 5 }),
    ], DEFAULT_CLAUDE_PRICING, now)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].start).toBe(at('2026-09-02T09:00:00Z'))
    expect(blocks[0].messages).toBe(2)
    expect(blocks[1].isActive).toBe(true)
    expect(Object.keys(blocks[1].byModel)).toEqual(['sonnet'])
  })
})

describe('reportFrom', () => {
  it('rolls up today, seven days, thirty days, models, days and projects', () => {
    const now = at('2026-09-02T18:00:00Z')
    const report = reportFrom([
      event('2026-09-02T10:00:00Z', 'claude-opus-5', { input: 100, output: 10 }, 'acme'),
      event('2026-08-30T10:00:00Z', 'claude-sonnet-5', { input: 100, output: 10 }, 'acme'),
      event('2026-08-10T10:00:00Z', 'claude-haiku-4-5', { input: 100, output: 10 }, 'other'),
    ], DEFAULT_CLAUDE_PRICING, 3, now)
    expect(report.today.messages).toBe(1)
    expect(report.last7.messages).toBe(2)
    expect(report.last30.messages).toBe(3)
    expect(Object.keys(report.byModel).sort()).toEqual(['haiku', 'opus', 'sonnet'])
    expect(report.daily[0].date).toBe('2026-09-02')
    expect(report.byProject[0].project).toBe('acme')
    expect(report.byProject[0].messages).toBe(2)
    expect(report.scannedFiles).toBe(3)
  })
})

describe('projectOf', () => {
  it('shows the encoded folder minus the home prefix instead of guessing a path back', () => {
    delete process.env.ORCHESTRATOR_CLAUDE_PROJECTS   // the home-derived default is what is under test
    const home = '/Users/jane'
    expect(projectOf('/Users/jane/.claude/projects/-Users-jane-Projects-acme-acme/x.jsonl', home)).toBe('acme-acme')
    expect(projectOf('/Users/jane/.claude/projects/-Users-jane--orchestrator-worktrees-acme-pr-12/x.jsonl', home))
      .toBe('orchestrator-worktrees-acme-pr-12')
  })
})
