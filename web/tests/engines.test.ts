import { describe, expect, it } from 'vitest'
import { claudeArgs, codexArgs } from '../server/engines.ts'
import type { Session } from '../shared/types.ts'

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's', worktreeID: 'w', title: 't', engine: 'codex', accessMode: 'edits', steeringMode: 'steer',
  model: null, effort: null, claudeSessionID: null, codexThreadID: null,
  isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ...overrides,
})

describe('codexArgs', () => {
  it('puts every option before the resume subcommand', () => {
    const args = codexArgs(session({ effort: 'high', model: 'gpt-5' }), 'hi', 'thread-1')
    const resumeAt = args.indexOf('resume')
    expect(resumeAt).toBeGreaterThan(0)
    for (const flag of ['--sandbox', '--model', '-c', '--json']) {
      expect(args.lastIndexOf(flag)).toBeLessThan(resumeAt)
    }
    expect(args.slice(resumeAt)).toEqual(['resume', 'thread-1', 'hi'])
  })

  it('reads CLAUDE.md natively and never AGENTS.md', () => {
    const args = codexArgs(session(), 'hi', null)
    expect(args).toContain('project_doc_fallback_filenames=["CLAUDE.md"]')
    const fallback = args.find((arg) => arg.startsWith('project_doc_fallback_filenames'))
    expect(fallback).not.toMatch(/AGENTS/)
  })

  it('offers Codex only the rename tool from the orchestrator\'s server, before any subcommand', () => {
    const args = codexArgs(session(), 'hi', 'thread-1', 'http://127.0.0.1:1/mcp/tok')
    const url = args.indexOf('mcp_servers.orchestrator.url="http://127.0.0.1:1/mcp/tok"')
    expect(args[url - 1]).toBe('-c')
    expect(args[args.indexOf('mcp_servers.orchestrator.enabled_tools=["rename_session"]') - 1]).toBe('-c')
    expect(args[args.indexOf('mcp_servers.orchestrator.default_tools_approval_mode="approve"') - 1]).toBe('-c')   // nobody to ask in exec
    expect(url).toBeLessThan(args.indexOf('resume'))
    expect(codexArgs(session(), 'hi', null).some((arg) => arg.startsWith('mcp_servers'))).toBe(false)
  })

  it('maps access modes to sandboxes', () => {
    expect(codexArgs(session({ accessMode: 'safe' }), 'p', null)).toContain('read-only')
    expect(codexArgs(session({ accessMode: 'edits' }), 'p', null)).toContain('workspace-write')
    expect(codexArgs(session({ accessMode: 'full' }), 'p', null))
      .toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

describe('claudeArgs', () => {
  it('resumes by id, otherwise pins a fresh session id', () => {
    expect(claudeArgs(session({ engine: 'claude' }), 'p', 'old', 'new')).toContain('--resume')
    const fresh = claudeArgs(session({ engine: 'claude' }), 'p', null, 'new')
    expect(fresh).toContain('--session-id')
    expect(fresh).not.toContain('--resume')
    expect(fresh.at(-1)).toBe('p')
  })
})
