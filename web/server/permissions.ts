import type { PermissionDecision, PermissionRequest } from '../shared/types.ts'

/**
 * Claude Code in print mode has nobody to answer a permission prompt, so anything not already
 * allowed is refused — and AskUserQuestion is refused the same way. The documented way out is a
 * permission host: an MCP tool the CLI calls for every prompt, which may answer with the person's
 * decision, including the answers to Claude's questions as `updatedInput`.
 *
 * This is that host. Each request waits here until someone answers it in the UI, the turn ends,
 * or too long passes.
 */
export const PROMPT_TOOL = 'approve'
export const PROMPT_SERVER = 'orchestrator'
/** What `--permission-prompt-tool` is given: mcp__<server>__<tool>. */
export const PROMPT_TOOL_NAME = `mcp__${PROMPT_SERVER}__${PROMPT_TOOL}`
/** The agent's way to rename its own session when the person asks; allowed without a prompt. */
export const RENAME_TOOL = 'rename_session'
export const RENAME_TOOL_NAME = `mcp__${PROMPT_SERVER}__${RENAME_TOOL}`
const PROTOCOL_VERSION = '2025-06-18'
export const ANSWER_TIMEOUT_MS = 15 * 60 * 1000

interface Waiting {
  sessionID: string
  resolve: (decision: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout>
  onExpire: () => void
}

export class PermissionBroker {
  private readonly waiting = new Map<string, Waiting>()

  /** Holds the tool call until `answer` is called for it; the caller shows the request meanwhile. */
  ask(request: PermissionRequest, sessionID: string, onExpire: () => void, timeoutMS = ANSWER_TIMEOUT_MS): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.expire(request.id, 'Nobody answered in time. Do not retry this call.'), timeoutMS)
      timer.unref?.()
      this.waiting.set(request.id, { sessionID, resolve, timer, onExpire })
    })
  }

  /** True when there was still something to answer. */
  answer(requestID: string, decision: PermissionDecision): boolean {
    const entry = this.waiting.get(requestID)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.waiting.delete(requestID)
    entry.resolve(decision)
    return true
  }

  /** The turn ended, or was stopped: everything it was still asking is refused. */
  cancelSession(sessionID: string, message: string) {
    for (const [id, entry] of this.waiting) if (entry.sessionID === sessionID) this.expire(id, message)
  }

  /** The engine stopped waiting for this answer on its own: release it as if it had expired. */
  giveUp(requestID: string, message: string) {
    this.expire(requestID, message)
  }

  private expire(requestID: string, message: string) {
    const entry = this.waiting.get(requestID)!
    clearTimeout(entry.timer)
    this.waiting.delete(requestID)
    entry.onExpire()
    entry.resolve({ behavior: 'deny', message })
  }

  pendingFor(sessionID: string): string[] {
    return [...this.waiting].filter(([, entry]) => entry.sessionID === sessionID).map(([id]) => id)
  }
}

/** Turns the chosen labels into what AskUserQuestion expects back: the questions, plus the answers. */
export function askUserAnswer(input: unknown, answers: Record<string, string | string[]>): PermissionDecision {
  const questions = (input as { questions?: unknown[] } | null)?.questions ?? []
  return { behavior: 'allow', updatedInput: { questions, answers } }
}

/** The arguments Claude Code sends the prompt tool. */
export interface PromptToolArguments {
  tool_name: string
  input: Record<string, unknown>
  tool_use_id: string
}

function isPromptToolArguments(value: unknown): value is PromptToolArguments {
  const args = value as Partial<PromptToolArguments> | null
  return !!args && typeof args.tool_name === 'string' && typeof args.tool_use_id === 'string'
    && typeof args.input === 'object' && args.input !== null
}

export type RPCResponse = { status: number; body?: unknown; headers?: Record<string, string> }

/**
 * A Streamable-HTTP MCP server small enough to live in Express: JSON-RPC over POST, one tool.
 * Requests get a single JSON body; notifications get 202 with none.
 */
export async function handleMCP(
  message: unknown,
  onCall: (args: PromptToolArguments) => Promise<PermissionDecision>,
  version: string,
  onRename: (title: string | null) => Promise<string>,
): Promise<RPCResponse> {
  const rpc = message as { jsonrpc?: string; id?: unknown; method?: string; params?: any } | null
  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 message' } } }
  }
  const isNotification = rpc.id === undefined || rpc.id === null
  const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: rpc.id, result } })
  const fail = (code: number, text: string) => ({ status: 200, body: { jsonrpc: '2.0', id: rpc.id, error: { code, message: text } } })

  if (rpc.method.startsWith('notifications/')) return { status: 202 }
  switch (rpc.method) {
    case 'initialize':
      return {
        ...reply({
          protocolVersion: typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: PROMPT_SERVER, version },
        }),
        headers: { 'Mcp-Session-Id': crypto.randomUUID() },
      }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [{
        name: PROMPT_TOOL,
        description: 'Asks the person at the orchestrator to allow or deny a tool call, or to answer the questions.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' },
          },
        },
      }, {
        name: RENAME_TOOL,
        description: 'Renames this session in the orchestrator. Call it when the person asks to rename or name this session. '
          + 'Pass title when they said what to call it; leave it out to have a name chosen from the conversation.',
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'The new name, if the person gave one.' } } },
      }] })
    case 'tools/call': {
      const name = rpc.params?.name
      if (name !== PROMPT_TOOL && name !== RENAME_TOOL) return fail(-32602, `Unknown tool: ${name}`)
      if (isNotification) return { status: 202 }
      const args = rpc.params.arguments
      if (name === RENAME_TOOL) {
        const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : null
        return reply({ content: [{ type: 'text', text: await onRename(title) }] })
      }
      if (!isPromptToolArguments(args)) return fail(-32602, 'approve needs tool_name, tool_use_id and an input object')
      const decision = await onCall(args)
      return reply({ content: [{ type: 'text', text: JSON.stringify(decision) }] })
    }
    default:
      return isNotification ? { status: 202 } : fail(-32601, `Method not found: ${rpc.method}`)
  }
}
