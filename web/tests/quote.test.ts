// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { appendQuote, compose, formatQuote, hunkLines } from '../src/lib/quote.ts'

describe('formatQuote', () => {
  it('names the source on the first line and quotes the rest, tidied', () => {
    expect(formatQuote('Claude said', '\n\n  first  \r\n\n\n\nthird\n\n')).toBe('> [Claude said]\n>   first\n>\n> third')
    expect(formatQuote('you said earlier', 'one')).toBe('> [you said earlier]\n> one')
  })
  it('keeps a long quote short, saying how much it left out', () => {
    const long = Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join('\n')
    expect(formatQuote('x', long, 3)).toBe('> [x]\n> line 1\n> line 2\n> line 3\n> … 2 more lines')
    expect(formatQuote('x', long, 5).split('\n')).toHaveLength(6)
  })
})

describe('appendQuote', () => {
  it('starts a fresh draft with the quote, or adds it below what is written', () => {
    expect(appendQuote('', '> [a]\n> b')).toBe('> [a]\n> b\n')
    expect(appendQuote('so, \n\n', '> [a]\n> b')).toBe('so,\n\n> [a]\n> b\n')
  })
})

describe('compose', () => {
  it('hands the text to whoever holds the composer', () => {
    const seen: string[] = []
    window.addEventListener('orchestrator:compose', (event) => seen.push((event as CustomEvent).detail.text))
    compose('> [x]\n> y')
    expect(seen).toEqual(['> [x]\n> y'])
  })
})

describe('hunkLines', () => {
  const modified = (line: number) => `m${line}`
  const original = (line: number) => `o${line}`
  const changes = [
    { originalStartLineNumber: 3, originalEndLineNumber: 4, modifiedStartLineNumber: 2, modifiedEndLineNumber: 0 },   // o3-o4 deleted after m2
    { originalStartLineNumber: 6, originalEndLineNumber: 6, modifiedStartLineNumber: 4, modifiedEndLineNumber: 5 },   // o6 became m4-m5
    { originalStartLineNumber: 8, originalEndLineNumber: 0, modifiedStartLineNumber: 7, modifiedEndLineNumber: 7 },   // m7 inserted
  ]
  it('shows a selection of the new side as the hunk the inline diff draws', () => {
    expect(hunkLines(1, 7, changes, modified, original)).toEqual([
      '  m1', '  m2', '- o3', '- o4', '  m3', '- o6', '+ m4', '+ m5', '  m6', '+ m7',
    ])
  })
  it('takes the lines deleted after a selected line, not the ones above the selection', () => {
    expect(hunkLines(2, 2, changes, modified, original)).toEqual(['  m2', '- o3', '- o4'])
    expect(hunkLines(3, 3, changes, modified, original)).toEqual(['  m3'])
    expect(hunkLines(5, 5, changes, modified, original)).toEqual(['+ m5'])
    expect(hunkLines(1, 1, [], modified, original)).toEqual(['  m1'])
  })
})
