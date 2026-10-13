import { describe, expect, it } from 'vitest'
import { parseClaudeLine, parseCodexLine } from '../server/engines.ts'

describe('parseClaudeLine', () => {
  it('captures the session id from init', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' })))
      .toEqual([{ type: 'backend', id: 'abc' }])
  })

  it('turns an error result with no `result` key into a failure carrying the reason', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution',
      errors: ['Failed to authenticate. API Error: 401'] })
    expect(parseClaudeLine(line)).toEqual([{ type: 'failed', message: 'Failed to authenticate. API Error: 401' }])
  })

  it('folds cache creation and cache read into cached tokens', () => {
    const line = JSON.stringify({ type: 'result', total_cost_usd: 0.5, duration_ms: 1500, num_turns: 3,
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } })
    const [event] = parseClaudeLine(line)
    expect(event).toMatchObject({ type: 'done', usage: { costUSD: 0.5, input: 10, cached: 105, output: 7 } })
    expect((event as any).summary).toBe('$0.5000 · 1.5s · 3 steps')
  })

  it('pairs tool_use with its tool_result by id and marks errors', () => {
    const start = parseClaudeLine(JSON.stringify({ type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }))
    const end = parseClaudeLine(JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true,
        content: [{ type: 'text', text: 'boom' }] }] } }))
    expect(start[0]).toMatchObject({ type: 'toolStart', id: 't1', name: 'Bash' })
    expect(end[0]).toEqual({ type: 'toolEnd', id: 't1', output: 'boom', failed: true })
  })

  it('ignores garbage lines instead of throwing', () => {
    expect(parseClaudeLine('not json')).toEqual([])
    expect(parseClaudeLine('{"type":"whatever"}')).toEqual([])
  })
})

describe('parseCodexLine', () => {
  it('emits one toolStart per command even when started and completed both arrive', () => {
    const started = new Set<string>()
    const item = { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a' }
    const first = parseCodexLine(JSON.stringify({ type: 'item.started', item }), started)
    const second = parseCodexLine(JSON.stringify({ type: 'item.completed', item }), started)
    expect(first.map((event) => event.type)).toEqual(['toolStart'])
    expect(second.map((event) => event.type)).toEqual(['toolEnd'])
  })

  it('reports a non-zero exit as a failed tool', () => {
    const item = { id: 'c2', type: 'command_execution', command: 'false', exit_code: 1 }
    const events = parseCodexLine(JSON.stringify({ type: 'item.completed', item }), new Set())
    expect(events.at(-1)).toMatchObject({ type: 'toolEnd', failed: true })
  })

  it('reads usage from turn.completed with no cost', () => {
    const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1 } })
    expect(parseCodexLine(line, new Set())[0])
      .toMatchObject({ type: 'done', usage: { costUSD: null, input: 5, cached: 2, output: 1 } })
  })

  it('surfaces turn.failed and error items', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }), new Set()))
      .toEqual([{ type: 'failed', message: 'quota' }])
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'x' } }), new Set()))
      .toEqual([{ type: 'failed', message: 'x' }])
  })
})
