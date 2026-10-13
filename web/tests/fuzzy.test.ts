import { describe, expect, it } from 'vitest'
import { fuzzyScore, rank } from '../src/components/CommandPalette.tsx'

describe('fuzzy matching', () => {
  it('finds a branch from an abbreviation', () => {
    const branches = ['main', 'agent/bash-tool-exit-code-2-abc123', 'feat/ab/WID-42/short-slug']
    expect(rank(branches, 'btec2', (b) => b)[0]).toBe('agent/bash-tool-exit-code-2-abc123')
  })
  it('prefers a direct substring over a scattered subsequence', () => {
    expect(fuzzyScore('fix/wid-42', 'wid')!).toBeGreaterThan(fuzzyScore('w/i/d-long-name', 'wid')!)
  })
  it('returns null when a character is missing', () => {
    expect(fuzzyScore('main', 'z')).toBeNull()
  })
  it('an empty query keeps every item', () => {
    expect(rank(['a', 'b'], '', (x) => x)).toEqual(['a', 'b'])
  })
})
