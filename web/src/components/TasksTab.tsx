import { useEffect, useState } from 'react'
import { api, type AgentTask, type TasksResponse } from '../lib/api.ts'
import { elapsed } from '../lib/elapsed.ts'
import { TurnActivity } from './TurnActivity.tsx'

export { elapsed }

/** Everything running on your behalf — every agent, its subagents and commands — with a kill switch. */
export function TasksTab({ onOpenSession, onStopSession }: {
  onOpenSession: (id: string) => void
  onStopSession: (id: string) => void
}) {
  const [data, setData] = useState<TasksResponse | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = () => void api.tasks().then(setData).catch((failure) => setError(failure.message))
    load()
    const timer = setInterval(() => { load(); setNow(Date.now()) }, 1000)
    return () => clearInterval(timer)
  }, [])

  const kill = (pid: number) => void api.killProcess(pid).catch((failure) => setError(failure.message))

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-5">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[16px] font-semibold">Running now</h1>
        <span className="text-[12px] text-ink-400">
          {data ? `${data.tasks.length} agent${data.tasks.length === 1 ? '' : 's'} · ${data.terminals.length} terminal${data.terminals.length === 1 ? '' : 's'}` : 'loading…'}
        </span>
      </div>
      {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-red-200">{error}</div>}

      {data && !data.tasks.length && (
        <div className="panel p-4 text-ink-400">No agent is running. Anything you start shows up here within a second.</div>)}

      {data?.tasks.map((task) => <TaskCard key={task.sessionID} task={task} now={now}
                                            onOpen={() => onOpenSession(task.sessionID)}
                                            onStop={() => onStopSession(task.sessionID)}
                                            onKill={kill} />)}

      {data && data.terminals.length > 0 && (
        <section className="panel p-3">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-500">Terminals</div>
          {data.terminals.map((terminal) => (
            <div key={terminal.id} className="row row-idle">
              <span className="flex-1 truncate text-[12px]">{terminal.title}</span>
              <span className="font-mono text-[10px] text-ink-500">pid {terminal.pid}</span>
              <button className="btn-danger py-0.5 text-[11px]"
                      onClick={() => void api.closeTerminal(terminal.id)}>Close</button>
            </div>))}
        </section>)}
    </div>
  )
}

function TaskCard({ task, now, onOpen, onStop, onKill }: {
  task: AgentTask; now: number
  onOpen: () => void; onStop: () => void; onKill: (pid: number) => void
}) {
  return (
    <section className="panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="dot-running h-2 w-2 rounded-full bg-ok" />
        <button className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline" onClick={onOpen}>
          {task.title}
        </button>
        <span className="chip">{task.engine}</span>
        {task.worktree && <span className="chip">{task.worktree}</span>}
        <span className="font-mono text-[10px] text-ink-500">agent pid {task.pid}</span>
        <span className="font-mono text-[11px] text-ink-400">{elapsed(task.startedAt, now)}</span>
        <button className="btn-danger py-0.5 text-[11px]" title="Ends the turn: the agent and everything under it" onClick={onStop}>Stop turn</button>
      </div>
      {!task.tools.length && !task.processes.length && !task.finished.length && (
        <div className="text-[11px] text-ink-500">Thinking — no tool call or command yet.</div>)}
      <TurnActivity tools={task.tools} finished={task.finished} processes={task.processes} agents={[]}
                    running startedAt={task.startedAt} now={now} onKill={onKill} />
    </section>
  )
}
