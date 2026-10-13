import { describe, expect, it } from 'vitest'
import { labelFor, planLabel } from '../server/planUsage.ts'
import { resetsIn, resetsOn } from '../src/lib/usageFormat.ts'

describe('planLabel', () => {
  it('reads the multiplier out of the tier the way the Claude app shows it', () => {
    expect(planLabel('default_claude_max_20x', 'max')).toBe('Max (20x)')
    expect(planLabel('default_claude_max_5x', 'max')).toBe('Max (5x)')
    expect(planLabel('default_claude_pro', 'pro')).toBe('Pro')
  })
  it('survives a missing tier', () => {
    expect(planLabel(undefined, 'max')).toBe('Max')
    expect(planLabel(undefined, undefined)).toBe('Plan')
  })
})

describe('labelFor', () => {
  it('names the rows exactly as the Claude usage page does', () => {
    expect(labelFor({ kind: 'session' })).toBe('Current session')
    expect(labelFor({ kind: 'weekly_all' })).toBe('All models')
    expect(labelFor({ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } })).toBe('Fable')
  })
})

describe('reset formatting', () => {
  it('counts down hours and minutes to the session reset', () => {
    const now = Date.parse('2026-09-02T16:07:00Z')
    expect(resetsIn('2026-09-02T20:29:59Z', now)).toBe('Resets in 4 hr 22 min')
    expect(resetsIn('2026-09-02T16:30:00Z', now)).toBe('Resets in 23 min')
    expect(resetsIn('2026-09-02T15:00:00Z', now)).toBe('Resets in 0 min')
  })
  it('names the weekday and local time for the weekly reset, rounded to the minute', () => {
    expect(resetsOn('2026-09-04T01:00:00')).toMatch(/^Resets \w{3} 1:00 AM$/)
    expect(resetsOn('2026-09-04T00:59:59.999')).toMatch(/^Resets \w{3} 1:00 AM$/)
  })
})
