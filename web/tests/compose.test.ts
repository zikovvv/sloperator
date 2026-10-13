import { describe, expect, it } from 'vitest'
import { bridgePrompt, composePrompt, parseComments } from '../server/compose.ts'
import type { TranscriptItem } from '../shared/types.ts'

describe('composePrompt', () => {
  it('carries every comment, with its file, line and snippet, into the prompt', () => {
    const prompt = composePrompt('please fix', [
      { file: 'server/git.ts', line: 14, snippet: 'return failure.stdout ?? ""', body: 'this swallows stderr' },
      { file: 'src/App.tsx', line: 200, body: 'and this leaks' },
    ])
    expect(prompt).toContain('please fix')
    expect(prompt).toContain('server/git.ts:14')
    expect(prompt).toContain('this swallows stderr')
    expect(prompt).toContain('src/App.tsx:200')
    expect(prompt).toContain('and this leaks')
  })
  it('leaves a plain message untouched', () => {
    expect(composePrompt('hello', [])).toBe('hello')
  })
})

describe('parseComments', () => {
  it('keeps well-formed entries and drops junk', () => {
    expect(parseComments([
      { file: 'a.ts', line: 1, body: 'x' },
      { file: '', line: 2, body: 'y' },
      { file: 'b.ts', line: Number.NaN, body: 'z' },
      { file: 'c.ts', line: 3, body: '  ' },
      'nonsense',
    ])).toEqual([{ file: 'a.ts', line: 1, body: 'x', snippet: '' }])
  })
  it('treats a missing or non-array payload as no comments', () => {
    expect(parseComments(undefined)).toEqual([])
    expect(parseComments({ file: 'a' })).toEqual([])
  })
})

const item = (role: TranscriptItem['role'], text: string): TranscriptItem =>
  ({ id: crypto.randomUUID(), role, text, timestamp: Date.now() })

describe('bridgePrompt', () => {
  it('carries the turns the new engine missed', () => {
    const items = [item('user', 'add a cache'), item('assistant', 'added it to store.ts'), item('user', 'now test it')]
    const bridge = bridgePrompt(items, 0)!
    expect(bridge).toContain('add a cache')
    expect(bridge).toContain('added it to store.ts')
    expect(bridge).toMatch(/did not see/)
  })
  it('returns null when the engine has seen everything', () => {
    const items = [item('user', 'hi'), item('assistant', 'hello')]
    expect(bridgePrompt(items, items.length)).toBeNull()
  })
  it('ignores tool and info noise', () => {
    expect(bridgePrompt([item('tool', 'ls -la'), item('info', 'Queued')], 0)).toBeNull()
  })
  it('keeps the most recent turns when the budget is exceeded and says so', () => {
    const items = [item('user', 'A'.repeat(300)), item('assistant', 'B'.repeat(300)), item('user', 'the latest thing')]
    const bridge = bridgePrompt(items, 0, 200)!
    expect(bridge).toContain('the latest thing')
    expect(bridge).toContain('earlier turns omitted')
    expect(bridge).not.toContain('A'.repeat(300))
  })
})
