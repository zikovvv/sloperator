import { describe, expect, it, vi } from 'vitest'
import { askUserAnswer, handleMCP, PermissionBroker, PROMPT_TOOL, PROMPT_TOOL_NAME, RENAME_TOOL, RENAME_TOOL_NAME } from '../server/permissions.ts'

const request = (id = 'r1') => ({ id, toolName: 'Bash', input: { command: 'ls' }, toolUseID: 't1', status: 'pending' as const })

describe('PermissionBroker', () => {
  it('holds a request until it is answered, then resolves with that decision', async () => {
    const broker = new PermissionBroker()
    const expired = vi.fn()
    const pending = broker.ask(request(), 's1', expired)
    expect(broker.pendingFor('s1')).toEqual(['r1'])
    expect(broker.answer('r1', { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe(true)
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(broker.answer('r1', { behavior: 'deny', message: 'late' })).toBe(false)   // nothing left to answer
    expect(expired).not.toHaveBeenCalled()
  })

  it('refuses everything a session was still asking when its turn ends, and nothing else', async () => {
    const broker = new PermissionBroker()
    const expiredMine = vi.fn(); const expiredOther = vi.fn()
    const mine = broker.ask(request('a'), 's1', expiredMine)
    const other = broker.ask(request('b'), 's2', expiredOther)
    broker.cancelSession('s1', 'the turn ended')
    expect(await mine).toEqual({ behavior: 'deny', message: 'the turn ended' })
    expect(expiredMine).toHaveBeenCalledTimes(1); expect(expiredOther).not.toHaveBeenCalled()
    expect(broker.pendingFor('s1')).toEqual([]); expect(broker.pendingFor('s2')).toEqual(['b'])
    broker.answer('b', { behavior: 'deny', message: 'no' })
    expect(await other).toEqual({ behavior: 'deny', message: 'no' })
  })

  it('gives up after the timeout, telling Claude not to retry', async () => {
    const broker = new PermissionBroker()
    const expired = vi.fn()
    const decision = await broker.ask(request(), 's1', expired, 5)
    expect(decision).toEqual({ behavior: 'deny', message: 'Nobody answered in time. Do not retry this call.' })
    expect(expired).toHaveBeenCalledTimes(1)
    expect(broker.pendingFor('s1')).toEqual([])
  })
})

describe('askUserAnswer', () => {
  it('hands the questions back with the chosen labels, as the tool expects', () => {
    const input = { questions: [{ question: 'Continue?', options: [] }] }
    expect(askUserAnswer(input, { 'Continue?': 'Yes' })).toEqual({
      behavior: 'allow', updatedInput: { questions: input.questions, answers: { 'Continue?': 'Yes' } },
    })
    expect(askUserAnswer(null, {})).toEqual({ behavior: 'allow', updatedInput: { questions: [], answers: {} } })
  })
})

describe('handleMCP — the wire the CLI speaks', () => {
  const call = (message: unknown, decision = { behavior: 'allow' as const, updatedInput: { ok: true } }) =>
    handleMCP(message, async () => decision, '9.9.9', async (title) => `renamed:${title}`)

  it('initialises with the client\'s protocol version and a session id', async () => {
    const out = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'orchestrator', version: '9.9.9' } } })
    expect(out.headers?.['Mcp-Session-Id']).toMatch(/[0-9a-f-]{36}/)
    const bare = await call({ jsonrpc: '2.0', id: 2, method: 'initialize' })
    expect((bare.body as any).result.protocolVersion).toBe('2025-06-18')
  })

  it('accepts notifications with 202 and no body, answers ping, and lists its tools', async () => {
    expect(await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202 })
    expect((await call({ jsonrpc: '2.0', id: 3, method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    const list = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    expect((list.body as any).result.tools.map((tool: any) => tool.name)).toEqual([PROMPT_TOOL, RENAME_TOOL])
    expect(PROMPT_TOOL_NAME).toBe('mcp__orchestrator__approve')
    expect(RENAME_TOOL_NAME).toBe('mcp__orchestrator__rename_session')
  })

  it('renames the session with the title given, or has one chosen when none is', async () => {
    const rename = async (args: unknown) =>
      ((await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: RENAME_TOOL, arguments: args } })).body as any).result.content[0].text
    expect(await rename({ title: '  Payment retries ' })).toBe('renamed:Payment retries')
    for (const none of [undefined, {}, { title: '   ' }, { title: 7 }]) expect(await rename(none)).toBe('renamed:null')
    expect((await call({ jsonrpc: '2.0', method: 'tools/call', params: { name: RENAME_TOOL } })).status).toBe(202)
  })

  it('answers a tools/call with the decision as text, and refuses what it does not know', async () => {
    const seen: unknown[] = []
    const out = await handleMCP({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: PROMPT_TOOL, arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' } } },
      async (args) => { seen.push(args); return { behavior: 'deny', message: 'no' } }, '1', async () => '')
    expect(seen).toEqual([{ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' }])
    expect((out.body as any).result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'no' }) }] })
    // Anything short of the three fields the CLI sends is an invalid call, not a request to show.
    for (const bad of [undefined, null, 'text', {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_use_id: 't' },
                       { tool_name: 'Bash', tool_use_id: 't', input: null }, { tool_name: 'Bash', tool_use_id: 't', input: 'ls' },
                       { tool_name: 7, tool_use_id: 't', input: {} }, { tool_name: 'Bash', tool_use_id: 7, input: {} }]) {
      const out = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: PROMPT_TOOL, arguments: bad } })
      expect(out.body).toMatchObject({ error: { code: -32602 } })
    }
    expect(seen).toHaveLength(1)
    expect((await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'other' } })).body)
      .toMatchObject({ error: { code: -32602 } })
    expect((await call({ jsonrpc: '2.0', method: 'tools/call', params: { name: PROMPT_TOOL } })).status).toBe(202)
    expect((await call({ jsonrpc: '2.0', id: 8, method: 'server/discover' })).body).toMatchObject({ error: { code: -32601 } })
    expect((await call({ jsonrpc: '2.0', method: 'something/odd' })).status).toBe(202)
  })

  it('rejects what is not JSON-RPC at all', async () => {
    for (const bad of [null, 'text', 42, {}, { jsonrpc: '1.0', method: 'ping' }, { jsonrpc: '2.0' }]) {
      const out = await call(bad)
      expect(out.status).toBe(400)
      expect((out.body as any).error.code).toBe(-32600)
    }
  })
})
