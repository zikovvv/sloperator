import { useState } from 'react'
import type { ActiveProcess, ActiveTool, AgentTranscript, BackgroundTask, FinishedTool } from '../../shared/types.ts'
import { duration, elapsed } from '../lib/elapsed.ts'
import { CodeBlock } from './Markdown.tsx'
import { describeInput } from './PermissionCard.tsx'

/**
 * Everything a turn is doing, live: each tool call with its whole input, every process under the
 * agent with a kill switch, what already finished and what it printed, and the subagents' own
 * transcripts. Nothing here is cut short: a row opens to all of it.
 */
export function TurnActivity({ tools, background, finished, processes, agents, running, startedAt, now, onKill }: {
  tools: ActiveTool[]; background: BackgroundTask[]; finished: FinishedTool[]; processes: ActiveProcess[]; agents: AgentTranscript[]
  running: boolean; startedAt: number | null; now: number; onKill: (pid: number) => void
}) {
  return (
    <div className="space-y-2 text-[11px]" data-testid="turn-activity">
      {tools.length > 0 && (
        <section>
          <div className="label mb-0.5">Running now</div>
          {tools.map((tool) => <ToolLine key={tool.id} tool={tool} now={now} />)}
        </section>)}
      {background.length > 0 && (
        <section data-testid="background-tasks">
          <div className="label mb-0.5">In the background ({background.length}) · the turn stays open until these end</div>
          {background.map((task) => (
            <div key={task.id} className="mb-0.5 flex items-baseline gap-2 rounded-md border border-ink-800/80 bg-ink-900/40 px-2 py-1">
              <span className="dot-running h-1.5 w-1.5 shrink-0 self-center rounded-full bg-ok" />
              <span className="font-mono text-[10px] text-ink-300">{task.kind === 'agent' ? 'subagent' : 'command'}</span>
              <span className="min-w-0 flex-1 truncate text-ink-400" title={task.description}>{task.description}</span>
              <span className="font-mono text-[10px] text-ink-500">{elapsed(task.startedAt, now)}</span>
            </div>))}
        </section>)}
      {processes.length > 0 && (
        <section>
          <div className="label mb-0.5">Commands and their processes ({processes.length})</div>
          {processes.map((process) => <ProcessLine key={process.pid} process={process} onKill={onKill} />)}
        </section>)}
      {finished.length > 0 && (
        <section>
          <div className="label mb-0.5">{running ? 'Finished this turn' : 'Last turn'} ({finished.length})</div>
          {[...finished].reverse().map((tool) => <ToolLine key={tool.id} tool={tool} now={now} />)}
        </section>)}
      {agents.length > 0 && (
        <section>
          <div className="label mb-0.5">Subagents</div>
          {agents.map((agent) => (
            <Agent key={agent.id} agent={agent} now={now}
                   working={running && startedAt !== null && agent.updatedAt >= startedAt} />))}
        </section>)}
    </div>
  )
}

function ToolLine({ tool, now }: { tool: ActiveTool | FinishedTool; now: number }) {
  const [open, setOpen] = useState(false)
  const done = 'endedAt' in tool ? tool : null
  const described = tool.input !== undefined ? describeInput(tool.name, tool.input) : null
  const headline = (described?.headline || tool.detail || tool.name).split('\n')[0]
  const body = described?.body ?? (tool.detail.includes('\n') ? { text: tool.detail, language: null } : null)
  return (
    <div className="mb-0.5 rounded-md border border-ink-800/80 bg-ink-900/40" data-testid={done ? 'finished-tool' : 'running-tool'}>
      <button className="flex w-full items-baseline gap-2 px-2 py-1 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {!done && <span className="dot-running h-1.5 w-1.5 shrink-0 self-center rounded-full bg-ok" />}
        <span className={`font-mono text-[10px] ${done?.failed ? 'text-warn' : 'text-ink-300'}`}>{tool.name}</span>
        <span className={`min-w-0 flex-1 font-mono text-ink-400 ${open ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>{open ? (described?.headline || tool.detail) : headline}</span>
        <span className="font-mono text-[10px] text-ink-500">{done ? duration(Math.round((done.endedAt - done.startedAt) / 1000)) : elapsed(tool.startedAt, now)}</span>
        <span className="text-[10px] text-ink-500">{open ? '−' : '+'}</span>
      </button>
      {open && body && <div className="border-t border-ink-800 px-2 py-1"><CodeBlock text={body.text} language={body.language} /></div>}
      {open && done && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-ink-800 px-2 py-1 font-mono text-[11px] text-ink-300" data-testid="tool-output">
          {done.output || (done.failed ? 'failed' : 'no output')}
        </pre>)}
    </div>
  )
}

function ProcessLine({ process, onKill }: { process: ActiveProcess; onKill: (pid: number) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-baseline gap-2 py-0.5" style={{ paddingLeft: `${(process.depth - 1) * 14}px` }} data-testid="process">
      <span className="w-12 shrink-0 font-mono text-[10px] text-ink-500">{process.pid}</span>
      {process.depth === 1 && <span className="chip shrink-0 text-[9px]">command</span>}
      <button className={`min-w-0 flex-1 text-left font-mono text-ink-300 ${open ? 'whitespace-pre-wrap break-all' : 'truncate'}`}
              title={open ? 'Show less' : process.command} onClick={() => setOpen((value) => !value)}>{process.command}</button>
      <span className="shrink-0 font-mono text-[10px] text-ink-500">{duration(process.elapsed)} · {process.cpu.toFixed(0)}% cpu</span>
      <button className="btn-danger shrink-0 py-0 text-[10px]" onClick={() => onKill(process.pid)}>Kill</button>
    </div>
  )
}

function Agent({ agent, now, working }: { agent: AgentTranscript; now: number; working: boolean }) {
  return (
    <details className="mb-1" data-testid="subagent">
      <summary className="flex cursor-pointer items-center gap-2">
        {working && <span className="dot-running h-1.5 w-1.5 rounded-full bg-ok" />}
        <span className="font-mono text-ink-300">agent {agent.id.slice(0, 8)}</span>
        <span className="min-w-0 flex-1 truncate text-ink-400" title={agent.prompt}>{agent.prompt.split('\n')[0]}</span>
        <span className="text-[10px] text-ink-500">{working ? 'working' : 'finished'} · {elapsed(agent.updatedAt, now)} ago</span>
      </summary>
      <div className="ml-3 mt-1 space-y-0.5 border-l border-ink-800 pl-2">
        {agent.prompt && <div className="whitespace-pre-wrap text-ink-500">{agent.prompt}</div>}
        {agent.truncated && <div className="text-[10px] text-ink-600">… earlier lines not shown</div>}
        {agent.rows.map((row, index) => (
          <div key={index} className={row.role === 'tool' ? 'whitespace-pre-wrap break-all font-mono text-ink-400' : row.role === 'info' ? 'text-warn' : 'whitespace-pre-wrap text-ink-200'}>
            {row.role === 'tool' ? `→ ${row.text}` : row.text}
          </div>))}
        {!agent.rows.length && <div className="text-ink-500">Nothing said yet.</div>}
      </div>
    </details>
  )
}
