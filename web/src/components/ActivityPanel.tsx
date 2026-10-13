import { useEffect, useState } from 'react'
import type { SessionActivity } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useStoredFlag } from '../lib/resizable.ts'
import { toast } from '../lib/toast.ts'
import { TurnActivity } from './TurnActivity.tsx'

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What the session is doing right now, folded above the composer; read every second while it runs. */
export function ActivityPanel({ sessionID, running }: { sessionID: string; running: boolean }) {
  const [activity, setActivity] = useState<SessionActivity | null>(null)
  const [open, setOpen] = useStoredFlag('orchestrator.activityOpen', false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let live = true
    const load = () => void api.activity(sessionID)
      .then((next) => { if (live) { setActivity(next); setNow(Date.now()) } })
      .catch(() => {})
    load()
    // Idle sessions are read once, for what their last turn did; running ones every second.
    const timer = running ? setInterval(load, 1000) : null
    return () => { live = false; if (timer) clearInterval(timer) }
  }, [sessionID, running])

  if (!activity || (!activity.tools.length && !activity.finished.length && !activity.processes.length && !activity.agents.length)) return null
  const parts = [
    activity.tools.length ? count(activity.tools.length, 'tool call') : '',
    activity.finished.length ? `${activity.finished.length} finished` : '',
    activity.processes.length ? count(activity.processes.length, 'process', 'processes') : '',
    activity.agents.length ? count(activity.agents.length, 'subagent') : '',
  ].filter(Boolean)
  const kill = (pid: number) => void api.killProcess(pid).catch((failure: Error) => toast(failure.message))

  return (
    <div className="border-t border-ink-800 bg-ink-900/80 px-4" data-testid="activity-panel">
      <div className="mx-auto max-w-3xl">
        <button className="flex w-full items-center gap-2 py-1 text-[11px] text-ink-400 hover:text-ink-200"
                onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="text-ink-600">{open ? '▾' : '▸'}</span>
          {activity.running && <span className="dot-running h-1.5 w-1.5 rounded-full bg-ok" />}
          <span>{activity.running ? 'Running now' : 'Last turn'} · {parts.join(' · ')}</span>
        </button>
        {open && (
          <div className="max-h-[40vh] overflow-y-auto pb-2">
            <TurnActivity tools={activity.tools} finished={activity.finished} processes={activity.processes} agents={activity.agents}
                          running={activity.running} startedAt={activity.startedAt} now={now} onKill={kill} />
          </div>)}
      </div>
    </div>
  )
}
