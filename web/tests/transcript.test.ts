import { describe, expect, it } from 'vitest'
import { mergeTranscript } from '../src/lib/transcript.ts'
import type { TranscriptItem } from '../shared/types.ts'

const item = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text, timestamp: 1 })

describe('mergeTranscript', () => {
  it('renders an item once when the socket already streamed what the history contains', () => {
    const shared = item('b', 'streamed and stored')
    const merged = mergeTranscript([item('a', 'older'), shared], [shared, item('c', 'newer')])
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the streamed copy, which carries any later patch', () => {
    const merged = mergeTranscript([item('a', 'before patch')], [item('a', 'after patch')])
    expect(merged).toHaveLength(1)
    expect(merged[0].text).toBe('after patch')
  })

  it('handles either side being empty', () => {
    expect(mergeTranscript([], [item('a', 'x')]).map((entry) => entry.id)).toEqual(['a'])
    expect(mergeTranscript([item('a', 'x')], []).map((entry) => entry.id)).toEqual(['a'])
    expect(mergeTranscript([], [])).toEqual([])
  })
})
