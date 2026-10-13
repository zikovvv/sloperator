import { describe, expect, it } from 'vitest'
import { claudeArgs, parseClaudeLine } from '../server/engines.ts'
import type { Session } from '../shared/types.ts'

const session = (accessMode: Session['accessMode']): Session => ({
  id: 's', worktreeID: 'w', title: 't', engine: 'claude', accessMode, steeringMode: 'queue', model: null, effort: null,
  claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
})

describe('where Claude Code brings its prompts', () => {
  const host = 'http://127.0.0.1:1/mcp/tok'
  it('gives every session the orchestrator\'s tools, and points all but full access at the host for prompts', () => {
    for (const mode of ['edits', 'safe', 'full'] as const) {
      const args = claudeArgs(session(mode), 'hi', null, 'new', host)
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { orchestrator: { type: 'http', url: host } } })
      const allowed = args.indexOf('--allowedTools')
      expect(args[allowed + 1]).toBe('mcp__orchestrator__rename_session')
      // Both flags take lists: an option must follow, or the prompt would be read as one more entry.
      expect(args[allowed + 2]).toMatch(/^--/)
      expect(args.at(-1)).toBe('hi')   // the prompt stays last, where the engine reads it
    }
    const edits = claudeArgs(session('edits'), 'hi', null, 'new', host)
    expect(edits[edits.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__orchestrator__approve')
    const full = claudeArgs(session('full'), 'hi', null, 'new', host)
    expect(full).toContain('--dangerously-skip-permissions')
    expect(full).not.toContain('--permission-prompt-tool')
    const bare = claudeArgs(session('edits'), 'hi', null, 'new')   // no host given
    expect(bare).not.toContain('--mcp-config'); expect(bare).not.toContain('--permission-prompt-tool')
  })
})

describe('what the parser makes of a refusal and a tool call', () => {
  it('turns Claude Code\'s own permission_denied into a line, and keeps the tool input', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'nobody can approve' })))
      .toEqual([{ type: 'info', text: 'Permission denied by Claude Code for Bash: nobody can approve' }])
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'permission_denied' })))
      .toEqual([{ type: 'info', text: 'Permission denied by Claude Code for a tool' }])
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'other' }))).toEqual([])
    const [start] = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls -la', description: 'list' } }] } }))
    expect(start).toMatchObject({ type: 'toolStart', name: 'Bash', detail: 'ls -la', input: { command: 'ls -la', description: 'list' } })
  })
})
