import { useEffect, useMemo, useState } from 'react'
import { api, type PlanUsageResponse, type UsageBucket, type UsageReport } from '../lib/api.ts'
import { resetsIn, resetsOn } from '../lib/usageFormat.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Markdown } from './Markdown.tsx'
import type { Project } from '../../shared/types.ts'

const CATEGORIES = [
  { id: 'claudemd', label: 'CLAUDE.md' },
  { id: 'memories', label: 'Memories' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'commands', label: 'Commands' },
]

/** Browse and edit the Claude setup without digging through dotfiles. */
export function InfraTab() {
  const [category, setCategory] = useState('claudemd')
  // Navigating away from unsaved edits asks first; the navigation waits in here.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  const [items, setItems] = useState<any[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [modified, setModified] = useState<number | undefined>()
  const [preview, setPreview] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const dirty = text !== saved

  useEffect(() => {
    void api.infra(category).then((result) => {
      setItems(result.items)
      if (!result.items.some((item) => item.path === path)) setPath(result.items[0]?.path ?? null)
    }).catch((failure) => setError(failure.message))
  }, [category])

  useEffect(() => {
    if (!path) return
    void api.infraFile(path).then((file) => {
      setText(file.text); setSaved(file.text); setModified(file.modified); setError(null)
    }).catch((failure) => setError(failure.message))
  }, [path])

  const grouped = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const item of items) map.set(item.group, [...(map.get(item.group) ?? []), item])
    return [...map.entries()]
  }, [items])

  // Only a loaded file can be dirty, so there is always a path by the time Save shows.
  const save = async () => {
    try {
      const result = await api.saveInfraFile(path!, text, modified)
      setSaved(text); setModified(result.modified); setError(null)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const isMarkdown = (path ?? '').endsWith('.md')

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-40 shrink-0 border-r border-ink-800 p-1.5" aria-label="Categories">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            className={`row ${category === entry.id ? 'row-active' : 'row-idle'}`}
            onClick={() => { if (!dirty) setCategory(entry.id); else setPendingNav(() => () => setCategory(entry.id)) }}
          >{entry.label}</button>))}
      </nav>

      <div className="w-72 shrink-0 overflow-y-auto border-r border-ink-800 p-1.5">
        {grouped.map(([group, entries]) => (
          <div key={group} className="mb-2">
            <div className="label px-2 py-1">{group}</div>
            {entries.map((item) => (
              <button
                key={item.path}
                className={`row ${item.path === path ? 'row-active' : 'row-idle'}`}
                onClick={() => { if (!dirty) setPath(item.path); else setPendingNav(() => () => setPath(item.path)) }}
              >
                <span className="flex-1 truncate">
                  <span className="block truncate text-[12px]">{item.title}</span>
                  {item.subtitle && (
                    <span className="block truncate text-[10px] text-ink-500">{item.subtitle}</span>)}
                </span>
              </button>))}
          </div>))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5">
          <span className="truncate font-mono text-[11px] text-ink-400">{path ?? '—'}</span>
          {isMarkdown && (
            <button className="chip-button ml-auto" onClick={() => setPreview((value) => !value)}>
              {preview ? 'Edit' : 'Preview'}
            </button>)}
          {dirty && <>
            <button className="btn-quiet" onClick={() => setText(saved)}>Revert</button>
            <button className="btn-primary" onClick={() => void save()}>Save</button>
          </>}
        </div>
        {error && <div className="border-b border-bad/40 bg-bad/10 px-3 py-1.5 text-[12px] text-red-200">{error}</div>}
        <div className="min-h-0 flex-1 overflow-auto">
          {isMarkdown && preview && !dirty ? (
            <div className="mx-auto max-w-3xl p-4">
              <Markdown text={text} onOpenFile={(target) => {
                const base = path!.slice(0, path!.lastIndexOf('/'))
                setPath(target.startsWith('/') ? target : `${base}/${target}`)
              }} />
            </div>
          ) : (
            <textarea
              className="h-full w-full resize-none bg-ink-950 p-4 font-mono text-[12px] text-ink-100 outline-none"
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              aria-label="File contents"
            />)}
        </div>
      </div>
      {pendingNav && (
        <ConfirmDialog
          title="Discard unsaved edits?"
          body="The file on disk keeps what it had. Your changes in the editor are lost."
          confirmLabel="Discard" danger
          onCancel={() => setPendingNav(null)}
          onConfirm={() => { const go = pendingNav; setPendingNav(null); go() }}
        />)}
    </div>
  )
}


export function UsageTab() {
  const [usage, setUsage] = useState<PlanUsageResponse | null>(null)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const load = () => {
      void api.planUsage().then(setUsage).catch((error) => setUsage({ error: error.message }))
      void api.usage().then(setReport).catch(() => {})
    }
    load()
    const refresh = setInterval(load, 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => { clearInterval(refresh); clearInterval(tick) }
  }, [])

  const session = usage && !('error' in usage) ? usage.limits.find((limit) => limit.group === 'session') : null
  const weekly = usage && !('error' in usage) ? usage.limits.filter((limit) => limit.group === 'weekly') : []
  const active = report?.blocks.find((block) => block.isActive) ?? null

  return (
    <div className="mx-auto w-full max-w-4xl overflow-y-auto px-8 py-10 text-[15px]">
      {/* ---- exactly the Claude usage page ---- */}
      {!usage ? <div className="text-ink-400">Asking Claude…</div>
        : 'error' in usage ? <div className="text-ink-300">{usage.error}</div>
        : (
          <>
            <div className="mb-10 flex items-baseline gap-3">
              <h1 className="text-[22px] font-semibold text-white">Plan usage limits</h1>
              <span className="text-[18px] text-ink-400">{usage.plan}</span>
            </div>
            {session && <LimitRow label={session.label} sub={resetsIn(session.resetsAt, now)} percent={session.percent} />}
            <h2 className="mb-8 mt-14 text-[22px] font-semibold text-white">Weekly limits</h2>
            <a className="mb-10 inline-block text-[15px] text-[#7aa2ff] underline underline-offset-4"
               href="https://support.claude.com/en/articles/11647753-understanding-claude-code-usage-limits"
               target="_blank" rel="noreferrer">Learn more about usage limits</a>
            {weekly.map((limit) => (
              <LimitRow key={limit.kind + limit.label} label={limit.label} sub={resetsOn(limit.resetsAt)} percent={limit.percent} />))}
            {usage.extra && (
              <>
                <h2 className="mb-8 mt-14 text-[22px] font-semibold text-white">Extra usage</h2>
                <LimitRow
                  label={usage.extra.enabled ? 'Pay-as-you-go credits' : 'Extra usage is off'}
                  sub={usage.extra.enabled
                    ? `$${usage.extra.usedUSD.toFixed(2)} of $${usage.extra.limitUSD.toFixed(2)} this month`
                    : usage.extra.disabledReason === 'out_of_credits'
                      ? `No credits — monthly cap $${usage.extra.limitUSD.toFixed(2)}`
                      : `Monthly cap $${usage.extra.limitUSD.toFixed(2)}`}
                  percent={usage.extra.percent}
                />
              </>)}
          </>)}

      {/* ---- everything the transcripts on this machine can tell ---- */}
      {report && (
        <>
          <h2 className="mb-2 mt-20 text-[22px] font-semibold text-white">What this machine has spent</h2>
          <p className="mb-8 text-[13px] text-ink-400">
            API-equivalent cost of every Claude Code message in the last 30 days, from
            {' '}{report.scannedFiles} transcript files. On a plan you do not pay this; it is what the same
            work would cost on the API.
          </p>

          <div className="mb-10 grid grid-cols-3 gap-4">
            <TotalCard title="Today" bucket={report.today} />
            <TotalCard title="Last 7 days" bucket={report.last7} />
            <TotalCard title="Last 30 days" bucket={report.last30} />
          </div>

          <h3 className="mb-3 text-[17px] font-semibold text-white">
            Current 5-hour window
            {active && <span className="ml-3 text-[13px] font-normal text-ink-400">
              started {new Date(active.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {' · '}resets {new Date(active.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>}
          </h3>
          {active
            ? <BucketTable rows={[
                { name: 'All models', bucket: active },
                ...Object.entries(active.byModel).sort(([, a], [, b]) => b.costUSD - a.costUSD)
                  .map(([name, bucket]) => ({ name: `  ${name}`, bucket })),
              ]} />
            : <div className="panel mb-10 p-4 text-ink-400">No messages in the current window.</div>}

          <h3 className="mb-3 mt-10 text-[17px] font-semibold text-white">By model, last 30 days</h3>
          <BucketTable rows={Object.entries(report.byModel).sort(([, a], [, b]) => b.costUSD - a.costUSD)
            .map(([name, bucket]) => ({ name, bucket }))} />

          <h3 className="mb-3 mt-10 text-[17px] font-semibold text-white">By day</h3>
          <BucketTable rows={report.daily.slice(0, 30).map((day) => ({
            name: new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
            bucket: day,
            detail: Object.entries(day.byModel).sort(([, a], [, b]) => b.costUSD - a.costUSD)
              .map(([model, bucket]) => `${model} $${bucket.costUSD.toFixed(0)}`).join(' · '),
          }))} />

          <h3 className="mb-3 mt-10 text-[17px] font-semibold text-white">By project, last 30 days</h3>
          <BucketTable rows={report.byProject.slice(0, 25).map((entry) => ({ name: entry.project, bucket: entry }))} />

          <h3 className="mb-3 mt-10 text-[17px] font-semibold text-white">Orchestrator sessions</h3>
          <div className="panel mb-10 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[11px] uppercase tracking-wide text-ink-500">
                <tr><th className="p-3">Session</th><th className="p-3">Engine</th>
                    <th className="p-3 text-right">In</th><th className="p-3 text-right">Cache</th>
                    <th className="p-3 text-right">Out</th><th className="p-3 text-right">Cost</th></tr>
              </thead>
              <tbody>
                {report.sessions.filter((entry) => entry.totalCostUSD > 0 || entry.outputTokens > 0)
                  .sort((a, b) => b.totalCostUSD - a.totalCostUSD).map((entry) => (
                  <tr key={entry.id} className="border-t border-ink-800">
                    <td className="max-w-[280px] truncate p-3">{entry.title}</td>
                    <td className="p-3 text-accent">{entry.engine}</td>
                    <td className="p-3 text-right font-mono">{fmt(entry.inputTokens)}</td>
                    <td className="p-3 text-right font-mono">{fmt(entry.cachedInputTokens)}</td>
                    <td className="p-3 text-right font-mono">{fmt(entry.outputTokens)}</td>
                    <td className="p-3 text-right font-mono">${entry.totalCostUSD.toFixed(3)}</td>
                  </tr>))}
                <tr className="border-t border-ink-700 font-semibold">
                  <td className="p-3" colSpan={5}>Total</td>
                  <td className="p-3 text-right font-mono">
                    ${report.sessions.reduce((sum, entry) => sum + entry.totalCostUSD, 0).toFixed(3)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="mb-3 mt-10 text-[17px] font-semibold text-white">
            Rates used
            <span className="ml-3 text-[13px] font-normal text-ink-400">USD per million tokens · change them in Settings</span>
          </h3>
          <div className="panel mb-10 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[11px] uppercase tracking-wide text-ink-500">
                <tr><th className="p-3">Model</th><th className="p-3 text-right">Input</th>
                    <th className="p-3 text-right">Cache read</th><th className="p-3 text-right">Cache write</th>
                    <th className="p-3 text-right">Output</th></tr>
              </thead>
              <tbody>
                {Object.entries(report.pricing).map(([model, rates]) => (
                  <tr key={model} className="border-t border-ink-800">
                    <td className="p-3">{model}{model === 'fable' && <span className="ml-2 text-[11px] text-ink-500">assumed = opus</span>}</td>
                    <td className="p-3 text-right font-mono">${rates.input}</td>
                    <td className="p-3 text-right font-mono">${rates.cacheRead}</td>
                    <td className="p-3 text-right font-mono">${rates.cacheWrite}</td>
                    <td className="p-3 text-right font-mono">${rates.output}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </>)}
    </div>
  )
}

function fmt(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function TotalCard({ title, bucket }: { title: string; bucket: UsageBucket }) {
  return (
    <div className="panel p-4">
      <div className="text-[12px] uppercase tracking-wide text-ink-500">{title}</div>
      <div className="mt-1 text-[26px] font-semibold text-white">${bucket.costUSD.toFixed(2)}</div>
      <div className="mt-2 text-[12px] text-ink-400">
        {fmt(bucket.messages)} messages · {fmt(bucket.output)} out · {fmt(bucket.cacheRead + bucket.cacheWrite)} cache
      </div>
    </div>
  )
}

function BucketTable({ rows }: { rows: Array<{ name: string; bucket: UsageBucket; detail?: string }> }) {
  return (
    <div className="panel mb-4 overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="text-left text-[11px] uppercase tracking-wide text-ink-500">
          <tr><th className="p-3">&nbsp;</th><th className="p-3 text-right">Messages</th>
              <th className="p-3 text-right">Input</th><th className="p-3 text-right">Cache read</th>
              <th className="p-3 text-right">Cache write</th><th className="p-3 text-right">Output</th>
              <th className="p-3 text-right">Cost</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-t border-ink-800">
              <td className="whitespace-pre p-3">
                {row.name}
                {row.detail && <div className="text-[11px] text-ink-500">{row.detail}</div>}
              </td>
              <td className="p-3 text-right font-mono">{fmt(row.bucket.messages)}</td>
              <td className="p-3 text-right font-mono">{fmt(row.bucket.input)}</td>
              <td className="p-3 text-right font-mono">{fmt(row.bucket.cacheRead)}</td>
              <td className="p-3 text-right font-mono">{fmt(row.bucket.cacheWrite)}</td>
              <td className="p-3 text-right font-mono">{fmt(row.bucket.output)}</td>
              <td className="p-3 text-right font-mono">${row.bucket.costUSD.toFixed(2)}</td>
            </tr>))}
          {!rows.length && <tr><td className="p-3 text-ink-500" colSpan={7}>Nothing yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function LimitRow({ label, sub, percent }: { label: string; sub: string; percent: number }) {
  return (
    <div className="mb-10 grid grid-cols-[minmax(180px,1fr)_2fr_auto] items-center gap-8">
      <div>
        <div className="text-[18px] text-white">{label}</div>
        <div className="mt-2 text-[16px] text-ink-400">{sub}</div>
      </div>
      <div className="h-[14px] overflow-hidden rounded-full bg-[#1a2a4d]" role="progressbar"
           aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-[#3b6ee0]" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="w-24 text-right text-[18px] text-ink-300">{percent}% used</div>
    </div>
  )
}

/** Comments other people left on your PRs, with a one-click "go fix them" action. */
export function GitHubTab({ projects, defaultProjectID, onOpenSession, onChanged }: {
  projects: Project[]
  defaultProjectID: string | null
  onOpenSession: (id: string) => void
  onChanged: () => void
}) {
  const [projectID, setProjectID] = useState(defaultProjectID ?? projects[0]?.id ?? '')
  const [result, setResult] = useState<any>({ ok: true, comments: [] })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    if (!projectID) return
    setLoading(true)
    void api.prComments(projectID).then(setResult)
      .catch((failure) => setResult({ ok: false, message: failure.message }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [projectID])

  const autofix = async (comment: any) => {
    setBusy(comment.prNumber)
    setError(null)
    try {
      const created = await api.autofixPR(projectID, comment.prNumber, comment.prTitle)
      onChanged()
      onOpenSession(created.session.id)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const byPR = new Map<number, any[]>()
  for (const comment of result.comments ?? []) {
    byPR.set(comment.prNumber, [...(byPR.get(comment.prNumber) ?? []), comment])
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 overflow-y-auto p-5">
      <div className="flex items-center gap-2">
        <select className="field w-auto" value={projectID} aria-label="Project"
                onChange={(event) => setProjectID(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        {loading && <span className="dot-running h-2 w-2 rounded-full bg-accent" />}
        <button className="btn-quiet ml-auto" onClick={load}>Refresh</button>
      </div>

      {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-red-200">{error}</div>}

      {result.ok === false
        ? <div className="panel p-4 text-ink-300">{result.message}</div>
        : loading && !byPR.size
          ? <div className="panel p-4 text-ink-400">Asking GitHub…</div>
        : !byPR.size
          ? <div className="panel p-4 text-ink-400">Nobody has commented on your open PRs.</div>
          : [...byPR.entries()].map(([prNumber, comments]) => (
            <section key={prNumber} className="panel p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-ink-400">#{prNumber}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{comments[0].prTitle}</span>
                <span className="chip">{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
                <button className="btn-primary" disabled={busy === prNumber}
                        title="Worktree for this PR, then a session told to fix the comments without replying"
                        onClick={() => void autofix(comments[0])}>
                  {busy === prNumber ? 'Setting up…' : 'Open & autofix'}
                </button>
              </div>
              <div className="space-y-1">
                {comments.map((comment: any) => (
                  <a key={comment.id} href={comment.url} target="_blank" rel="noreferrer"
                     className="row row-idle block">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[11px] font-medium text-accent">{comment.author}</span>
                      {comment.path && (
                        <span className="font-mono text-[10px] text-ink-500">{comment.path}</span>)}
                      <span className="ml-auto text-[10px] text-ink-500">
                        {new Date(comment.createdAt).toLocaleString([], {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[12px] text-ink-300">{comment.body}</span>
                  </a>))}
              </div>
            </section>))}
    </div>
  )
}

