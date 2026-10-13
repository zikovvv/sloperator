import { spawn, type ChildProcess, execFileSync } from 'node:child_process'
import { ANSWER_TIMEOUT_MS, PROMPT_SERVER, PROMPT_TOOL_NAME, RENAME_TOOL } from './permissions.ts'
import { CONTROL_TOOLS } from './control.ts'
import { homedir } from 'node:os'
import type { Session } from '../shared/types.ts'

/** The orchestrator's tools the engine need not ask about: the app itself asks, where a change needs a yes. */
export const OPEN_TOOLS = [RENAME_TOOL, ...CONTROL_TOOLS]

/** GUI-launched processes do not inherit a shell PATH, so build one. */
/**
 * Path of an external tool. Tests set ORCHESTRATOR_BIN_DIR to a folder of fakes so gh, security,
 * whisper and the language servers can be exercised without the real ones.
 */
export function binary(name: string, fallback?: string): string {
  const directory = process.env.ORCHESTRATOR_BIN_DIR
  if (directory) return `${directory}/${name}`
  return fallback ?? name
}

export function agentEnv(): NodeJS.ProcessEnv {
  const home = homedir()
  const extras = [
    `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin',
    `${home}/miniconda3/bin`, `${home}/.bun/bin`, `${home}/.nvm/current/bin`,
  ]
  const env = { ...process.env }
  env.PATH = [...extras, env.PATH ?? '/usr/bin:/bin'].join(':')
  // Nested-session markers confuse the claude CLI.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_SSE_PORT
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

export const CLAUDE_MD_PREAMBLE =
  'System note: this machine is set up around Claude Code conventions, not AGENTS.md. ' +
  'Global operating instructions live at ~/.claude/CLAUDE.md — read that file now and obey it ' +
  'for the whole session. Project-level CLAUDE.md files (already injected as project docs) are ' +
  'authoritative. Ignore any AGENTS.md files.'

export function claudeArgs(session: Session, prompt: string, resumeID: string | null, newID: string, promptHost?: string) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  // The orchestrator's own tools reach every session. Both flags take lists, so an option must follow.
  if (promptHost) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [PROMPT_SERVER]: { type: 'http', url: promptHost } } }),
              '--allowedTools', OPEN_TOOLS.map((tool) => `mcp__${PROMPT_SERVER}__${tool}`).join(','))
    // The CLI kills background commands and subagents the moment a turn ends. Before it stops it asks the app,
    // which says no while any are still running.
    args.push('--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `/usr/bin/curl -s -m 5 '${promptHost}/stop'` }] }] } }))
    // In print mode nobody answers a prompt, so unapproved tools and questions are refused; full access never prompts.
    if (session.accessMode !== 'full') args.push('--permission-prompt-tool', PROMPT_TOOL_NAME)
  }
  if (resumeID) args.push('--resume', resumeID)
  else args.push('--session-id', newID)
  if (session.accessMode === 'safe') args.push('--permission-mode', 'default')
  else if (session.accessMode === 'edits') args.push('--permission-mode', 'acceptEdits')
  else args.push('--dangerously-skip-permissions')
  if (session.model) args.push('--model', session.model)
  if (session.effort) args.push('--effort', session.effort)
  args.push(prompt)
  return args
}

/**
 * Every option must precede `resume`: the subcommand rejects --sandbox outright, which used to
 * break the second and every later turn of a Codex conversation.
 */
export function codexArgs(session: Session, prompt: string, resumeThreadID: string | null, promptHost?: string) {
  const args = ['exec', '--json', '--skip-git-repo-check',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]']
  if (session.accessMode === 'safe') args.push('--sandbox', 'read-only')
  else if (session.accessMode === 'edits') args.push('--sandbox', 'workspace-write')
  else args.push('--dangerously-bypass-approvals-and-sandbox')
  if (session.model) args.push('--model', session.model)
  if (session.effort) args.push('-c', `model_reasoning_effort="${session.effort}"`)
  // Codex has its own approvals, so the permission host is left out of what it is offered. The rest
  // is pre-approved: codex exec has nobody to ask and cancels a tool call that would need asking.
  if (promptHost) {
    args.push('-c', `mcp_servers.${PROMPT_SERVER}.url="${promptHost}"`,
              '-c', `mcp_servers.${PROMPT_SERVER}.enabled_tools=${JSON.stringify(OPEN_TOOLS)}`,
              '-c', `mcp_servers.${PROMPT_SERVER}.default_tools_approval_mode="approve"`,
              // A change the person is asked about waits for them, far longer than Codex waits for a tool by default.
              '-c', `mcp_servers.${PROMPT_SERVER}.tool_timeout_sec=${(ANSWER_TIMEOUT_MS + 60_000) / 1000}`)
  }
  if (resumeThreadID) args.push('resume', resumeThreadID)
  args.push(resumeThreadID ? prompt : `${CLAUDE_MD_PREAMBLE}\n\n${prompt}`)
  return args
}

export type AgentEvent =
  | { type: 'backend'; id: string }
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolStart'; id: string; name: string; detail: string; input?: unknown }
  | { type: 'info'; text: string }
  | { type: 'toolEnd'; id: string; output: string | null; failed: boolean }
  | { type: 'done'; summary: string | null; usage: Usage }
  /** Everything still running behind the turn, each time that changes. */
  | { type: 'background'; tasks: Array<{ id: string; kind: 'command' | 'agent'; description: string }> }
  | { type: 'failed'; message: string }

export interface Usage {
  costUSD: number | null
  input: number
  cached: number
  output: number
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'pattern', 'description', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 300)
  }
  return JSON.stringify(record).slice(0, 300)
}

export function parseClaudeLine(line: string): AgentEvent[] {
  let obj: any
  try { obj = JSON.parse(line) } catch { return [] }
  switch (obj?.type) {
    case 'system':
      if (obj.subtype === 'init' && obj.session_id) return [{ type: 'backend', id: obj.session_id }]
      if (obj.subtype === 'background_tasks_changed') {
        return [{ type: 'background', tasks: (obj.tasks as any[]).map((task) => ({
          id: String(task.task_id), kind: task.task_type === 'local_agent' ? 'agent' : 'command', description: String(task.description),
        })) }]
      }
      // What the CLI cut short, most often by ending the turn on it: said in the chat, where the agent may not have.
      if (obj.subtype === 'task_notification' && obj.status === 'stopped') {
        return [{ type: 'info', text: `Stopped before it finished, in the background: ${obj.summary}` }]
      }
      // Claude Code refused something itself (no host, or --permission-prompts none): say so.
      if (obj.subtype === 'permission_denied') {
        return [{ type: 'info', text: `Permission denied by Claude Code for ${obj.tool_name ?? 'a tool'}${obj.message ? `: ${obj.message}` : ''}` }]
      }
      return []
    case 'assistant': {
      const events: AgentEvent[] = []
      for (const block of obj.message?.content ?? []) {
        if (block.type === 'text' && block.text) events.push({ type: 'assistant', text: block.text })
        else if (block.type === 'thinking' && block.thinking) {
          events.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'toolStart', id: block.id ?? crypto.randomUUID(),
            name: block.name ?? 'tool', detail: summarizeInput(block.input), input: block.input,
          })
        }
      }
      return events
    }
    case 'user': {
      const events: AgentEvent[] = []
      for (const block of obj.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const content = block.content
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => part?.text).filter(Boolean).join('\n')
            : null
        events.push({ type: 'toolEnd', id: block.tool_use_id ?? '', output: text, failed: !!block.is_error })
      }
      return events
    }
    case 'result': {
      if (obj.is_error) {
        // A real failure payload has no `result` key; the reason is in `errors`.
        const reasons: string[] = (obj.errors ?? [])
          .map((item: any) => (typeof item === 'string' ? item : item?.message ?? item?.error))
          .filter(Boolean)
        return [{ type: 'failed', message: reasons.join('\n') || obj.result || obj.subtype || 'Turn failed' }]
      }
      const usage: Usage = {
        costUSD: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
        input: obj.usage?.input_tokens ?? 0,
        cached: (obj.usage?.cache_read_input_tokens ?? 0) + (obj.usage?.cache_creation_input_tokens ?? 0),
        output: obj.usage?.output_tokens ?? 0,
      }
      const parts = [
        usage.costUSD != null ? `$${usage.costUSD.toFixed(4)}` : null,
        typeof obj.duration_ms === 'number' ? `${(obj.duration_ms / 1000).toFixed(1)}s` : null,
        typeof obj.num_turns === 'number' ? `${obj.num_turns} steps` : null,
      ].filter(Boolean)
      return [{ type: 'done', summary: parts.join(' · ') || null, usage }]
    }
    default:
      return []
  }
}

export function parseCodexLine(line: string, started: Set<string>): AgentEvent[] {
  let obj: any
  try { obj = JSON.parse(line) } catch { return [] }
  if (obj?.type === 'thread.started' && obj.thread_id) return [{ type: 'backend', id: obj.thread_id }]
  if (obj?.type === 'turn.completed') {
    const usage: Usage = {
      costUSD: null,
      input: obj.usage?.input_tokens ?? 0,
      cached: obj.usage?.cached_input_tokens ?? 0,
      output: obj.usage?.output_tokens ?? 0,
    }
    return [{ type: 'done', summary: `${usage.input} in · ${usage.output} out tokens`, usage }]
  }
  if (obj?.type === 'turn.failed') return [{ type: 'failed', message: obj.error?.message ?? 'Turn failed' }]
  if (obj?.type === 'error') return [{ type: 'failed', message: obj.message ?? 'error' }]
  if (!obj?.type?.startsWith('item.')) return []

  const item = obj.item ?? {}
  const id = item.id ?? crypto.randomUUID()
  const completed = obj.type === 'item.completed'
  switch (item.type) {
    case 'agent_message':
      return completed && item.text ? [{ type: 'assistant', text: item.text }] : []
    case 'reasoning':
      return completed && item.text ? [{ type: 'thinking', text: item.text }] : []
    case 'command_execution': {
      const events: AgentEvent[] = []
      if (!started.has(id)) {
        started.add(id)
        events.push({ type: 'toolStart', id, name: 'shell', detail: item.command ?? '' })
      }
      if (completed) {
        events.push({
          type: 'toolEnd', id, output: item.aggregated_output ?? null,
          failed: (item.exit_code ?? 0) !== 0,
        })
      }
      return events
    }
    case 'file_change': {
      if (!completed) return []
      const detail = (item.changes ?? [])
        .map((change: any) => `${change.kind ?? 'edit'} ${change.path}`)
        .join('\n')
      return [
        { type: 'toolStart', id, name: 'edit', detail },
        { type: 'toolEnd', id, output: null, failed: false },
      ]
    }
    case 'mcp_tool_call': {
      const events: AgentEvent[] = []
      const name = [item.server, item.tool].filter(Boolean).join('.') || 'mcp'
      if (!started.has(id)) { started.add(id); events.push({ type: 'toolStart', id, name, detail: '' }) }
      if (completed) events.push({ type: 'toolEnd', id, output: null, failed: item.status === 'failed' })
      return events
    }
    case 'web_search':
      return completed
        ? [{ type: 'toolStart', id, name: 'web_search', detail: item.query ?? '' },
           { type: 'toolEnd', id, output: null, failed: false }]
        : []
    case 'error':
      return [{ type: 'failed', message: item.message ?? 'error' }]
    default:
      return []
  }
}

/** Signals a process and everything below it. Snapshot first: children reparent when it dies. */
export function killTree(pid: number, signal: NodeJS.Signals) {
  let descendants: number[] = []
  try {
    const listing = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    const children = new Map<number, number[]>()
    for (const row of listing.split('\n')) {
      const [child, parent] = row.trim().split(/\s+/).map(Number)
      if (!child || !parent) continue
      children.set(parent, [...(children.get(parent) ?? []), child])
    }
    const frontier = [pid]
    while (frontier.length) {
      const next = frontier.pop()!
      for (const child of children.get(next) ?? []) {
        descendants.push(child)
        frontier.push(child)
      }
    }
  } catch { /* ps unavailable: fall back to the direct child */ }
  for (const target of [...descendants.reverse(), pid]) {
    try { process.kill(target, signal) } catch { /* already gone */ }
  }
}

export function spawnAgent(
  executable: string, args: string[], cwd: string,
): ChildProcess {
  // Claude Code abandons an MCP tool call after 60s by default, which a person answering an approval
  // easily outlasts; give it longer than the app itself waits for an answer.
  const env = { ...agentEnv(), MCP_TOOL_TIMEOUT: String(ANSWER_TIMEOUT_MS + 60_000) }
  return spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
}
