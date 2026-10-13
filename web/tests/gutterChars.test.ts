import { describe, expect, it } from 'vitest'
import { gutterChars } from '../src/lib/diffSides.ts'

describe('gutterChars', () => {
  it('fits the largest line number with one character to spare', () => {
    expect(gutterChars([4])).toBe(2)                 // "4" and room before the sign
    expect(gutterChars([12, null, 5670])).toBe(5)    // "5670" and room
    expect(gutterChars([null])).toBe(2)
    expect(gutterChars([])).toBe(2)
  })
})
