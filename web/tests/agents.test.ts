import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectDir, subagentTranscripts } from '../server/agents.ts'

const line = (object: unknown) => JSON.stringify(object)
const assistant = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const tool = (name: string, input: unknown) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } })
const result = () => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const prompt = (content: unknown) => line({ type: 'user', message: { role: 'user', content } })

describe('claudeProjectDir', () => {
  it('falls back to the real ~/.claude/projects when nothing points elsewhere', async () => {
    const saved = process.env.ORCHESTRATOR_CLAUDE_PROJECTS
    delete process.env.ORCHESTRATOR_CLAUDE_PROJECTS
    try {
      const { homedir } = await import('node:os')
      expect(claudeProjectDir('/w/x')).toBe(join(homedir(), '.claude/projects', '-w-x'))
    } finally { process.env.ORCHESTRATOR_CLAUDE_PROJECTS = saved }
  })
})

describe('subagentTranscripts', () => {
  it('reads each subagent of a session — its prompt, what it said and ran — newest first', () => {
    const root = process.env.ORCHESTRATOR_CLAUDE_PROJECTS!
    const directory = join(claudeProjectDir('/w/my.tree'), 'sess-1', 'subagents')
    expect(directory).toBe(join(root, '-w-my-tree', 'sess-1', 'subagents'))
    mkdirSync(directory, { recursive: true })
    const now = Date.now()
    const older = join(directory, 'agent-aaa.jsonl')
    writeFileSync(older, [
      prompt('Review the login flow'), assistant('Looking.'), tool('Bash', { command: 'ls' }), result(), 'not json',
      line({ type: 'progress' }), line({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'nope' }),
      line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }),
    ].join('\n') + '\n')
    utimesSync(older, new Date(now - 5000), new Date(now - 5000))
    writeFileSync(join(directory, 'notes.txt'), 'ignored')
    const newer = join(directory, 'agent-bbb.jsonl')
    writeFileSync(newer, prompt([{ type: 'tool_result' }]) + '\n')
    utimesSync(newer, new Date(now + 10000), new Date(now + 10000))   // a clock ahead of ours is not "idle for -10s"
    const agents = subagentTranscripts('/w/my.tree', 'sess-1', now)
    expect(agents.map((agent) => agent.id)).toEqual(['bbb', 'aaa'])
    const [bbb, aaa] = agents
    expect(aaa).toMatchObject({ prompt: 'Review the login flow', truncated: false })
    expect(aaa.idleMS).toBeGreaterThanOrEqual(4900)
    expect(aaa.rows).toEqual([
      { role: 'assistant', text: 'Looking.' }, { role: 'tool', text: 'Bash ls' },
      { role: 'info', text: 'Permission denied by Claude Code for Bash: nope' },
    ])
    expect(bbb).toMatchObject({ prompt: '', rows: [], idleMS: 0 })
  })

  it('keeps only the tail of a long transcript, and copes with what is missing', () => {
    const directory = join(claudeProjectDir('/w/long'), 'sess-2', 'subagents')
    mkdirSync(directory, { recursive: true })
    const many = Array.from({ length: 3000 }, (_, index) => assistant(`line ${index}`))
    writeFileSync(join(directory, 'agent-long.jsonl'), [prompt('Long job'), ...many].join('\n') + '\n')
    const long = subagentTranscripts('/w/long', 'sess-2').find((agent) => agent.id === 'long')!
    expect(long.prompt).toBe('Long job')
    expect(long.truncated).toBe(true)
    expect(long.rows).toHaveLength(40)
    expect(long.rows.at(-1)).toEqual({ role: 'assistant', text: 'line 2999' })
    // A short file with more rows than are shown is truncated too, from the front.
    writeFileSync(join(directory, 'agent-mid.jsonl'), [prompt('Mid'), ...Array.from({ length: 45 }, (_, index) => assistant(`r${index}`))].join('\n') + '\n')
    const mid = subagentTranscripts('/w/long', 'sess-2').find((agent) => agent.id === 'mid')!
    expect(mid.truncated).toBe(true)
    expect(mid.rows).toHaveLength(40)
    expect(mid.rows[0].text).toBe('r5')
    // A first line that is not JSON: no prompt, and nothing thrown.
    writeFileSync(join(directory, 'agent-odd.jsonl'), ['{not json', assistant('still here')].join('\n') + '\n')
    const odd = subagentTranscripts('/w/long', 'sess-2').find((agent) => agent.id === 'odd')!
    expect(odd).toMatchObject({ prompt: '', rows: [{ role: 'assistant', text: 'still here' }] })
    expect(subagentTranscripts('/w/long', null)).toEqual([])
    expect(subagentTranscripts('/w/nowhere', 'sess-2')).toEqual([])
  })
})
