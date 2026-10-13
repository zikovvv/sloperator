import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { applyAppearance, DEFAULT_APPEARANCE, type Appearance } from './lib/theme.ts'
import { CollapsedStrip, PanelToggle } from './components/PanelToggle.tsx'
import { Chat, type ReviewComment } from './components/Chat.tsx'
import { ReviewPanel } from './components/ReviewPanel.tsx'
import { GitHubTab, InfraTab, UsageTab } from './components/Tabs.tsx'
import { PR_STATE_TONE, PullRequestsTab } from './components/PullRequests.tsx'
import { CommandPalette, type Command } from './components/CommandPalette.tsx'
import { NewWorktreeDialog, SettingsDialog } from './components/NewWorktreeDialog.tsx'
import { WorktreeSetup } from './components/WorktreeSetup.tsx'
import { readStored, startDrag, useStoredFlag, useStoredNumber, useStoredValue, writeStored } from './lib/resizable.ts'
import { STRONGEST_MODEL } from '../shared/models.ts'
import { TasksTab } from './components/TasksTab.tsx'
import { Toasts } from './components/Toasts.tsx'
import { TerminalDrawer } from './components/TerminalDrawer.tsx'
import { loadDensity, saveDensity, type LogDensity } from './lib/density.ts'
import { loadTranscript, useStore } from './store.ts'
import { api } from './lib/api.ts'
import { reportError } from './lib/toast.ts'
import type { PRRow, Session, TranscriptItem } from '../shared/types.ts'
import { mergeTranscript } from './lib/transcript.ts'
import { quiet } from './lib/quiet.ts'

type Tab = 'sessions' | 'infra' | 'usage' | 'prs' | 'github' | 'tasks'

const MODELS: Record<Session['engine'], Array<[string, string]>> = {
  claude: [['Fable 5', STRONGEST_MODEL.claude], ['Opus 5', 'claude-opus-5'],
           ['Sonnet 5', 'claude-sonnet-5'], ['Haiku 4.5', 'claude-haiku-4-5-20251001']],
  codex: [['gpt-5.5', STRONGEST_MODEL.codex], ['gpt-5.5-codex', 'gpt-5.5-codex'],
          ['gpt-5.2-codex', 'gpt-5.2-codex'], ['gpt-5.2', 'gpt-5.2']],
}
const EFFORTS: Record<Session['engine'], Array<string | null>> = {
  claude: [null, 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: [null, 'minimal', 'low', 'medium', 'high', 'xhigh'],
}
/** What each engine runs at when no effort is asked for; the chooser says so instead of "Effort". */
const DEFAULT_EFFORT: Record<Session['engine'], string> = { claude: 'high', codex: 'medium' }
const ACCESS: Array<[Session['accessMode'], string]> = [
  ['safe', 'Read only'], ['edits', 'Auto edits'], ['full', 'Full access'],
]

export default function App() {
  const store = useStore()
  // Where the reader was survives a reload; ids that no longer exist are dropped once state arrives.
  const remembered = readStored<{ tab: Tab; sessionID: string | null; worktreeID: string | null }>(
    'orchestrator.view', { tab: 'sessions', sessionID: null, worktreeID: null })
  const [tab, setTab] = useState<Tab>(remembered.tab)
  const [sessionID, setSessionID] = useState<string | null>(remembered.sessionID)
  const [worktreeID, setWorktreeID] = useState<string | null>(remembered.worktreeID)
  const [openRequest, setOpenRequest] = useState<{ path: string; line?: number; nonce: number } | null>(null)
  const [history, setHistory] = useState<Record<string, TranscriptItem[]>>({})
  const [attention, setAttention] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [skills, setSkills] = useState<any[]>([])
  const [showReview, setShowReview] = useStoredFlag('orchestrator.showReview', true)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [worktreeDialog, setWorktreeDialog] = useState<typeof store.projects[number] | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showTerminal, setShowTerminal] = useStoredFlag('orchestrator.showTerminal', false)
  const [chatCollapsed, setChatCollapsed] = useStoredFlag('orchestrator.chatCollapsed', false)
  const [density, setDensity] = useState<LogDensity>(loadDensity)
  const chooseDensity = (value: LogDensity) => { setDensity(value); saveDensity(value) }

  const session = store.sessions.find((candidate) => candidate.id === sessionID) ?? null
  const worktree = store.worktrees.find(
    (candidate) => candidate.id === (session?.worktreeID ?? worktreeID)) ?? null
  const project = store.projects.find((candidate) => candidate.id === worktree?.projectID) ?? null
  const isRunning = !!session && store.running.has(session.id)

  // The palette is applied to the document, so every rule using it follows along at once.
  const [appearance] = useStoredValue<Appearance>('orchestrator.appearance', DEFAULT_APPEARANCE)
  useEffect(() => { applyAppearance({ ...DEFAULT_APPEARANCE, ...appearance }, document.documentElement) }, [appearance])

  useEffect(() => { void api.skills().then((result) => setSkills(result.skills)).catch(quiet) }, [])

  // Which pull request each branch belongs to, so a session can show and open its own.
  const projectID = worktree?.projectID ?? null
  useEffect(() => {
    if (!projectID) { setProjectPRs([]); return }
    let live = true
    void api.prs(projectID)
      .then((result) => { if (live) setProjectPRs(result.ok ? result.prs : []) })
      .catch(() => { if (live) setProjectPRs([]) })
    return () => { live = false }
  }, [projectID, generation])

  useEffect(() => { writeStored('orchestrator.view', { tab, sessionID, worktreeID }) }, [tab, sessionID, worktreeID])

  // Land on something useful without a click; a remembered id that is gone or archived is let go of.
  useEffect(() => {
    const loaded = store.sessions.length > 0 || store.worktrees.length > 0
    if (!loaded) return
    if (sessionID && !store.sessions.some((entry) => entry.id === sessionID)) { setSessionID(null); return }
    if (worktreeID && !store.worktrees.some((entry) => entry.id === worktreeID)) { setWorktreeID(null); return }
    if (worktree?.isArchived) { setSessionID(null); setWorktreeID(null); return }
    if (sessionID || worktreeID) return
    const shown = new Set(store.worktrees.filter((entry) => !entry.isArchived).map((entry) => entry.id))
    const session = store.sessions.find((entry) => !entry.isArchived && shown.has(entry.worktreeID))
    if (session) { setSessionID(session.id); return }
    if (shown.size) setWorktreeID([...shown][0])
  }, [store.sessions, store.worktrees, sessionID, worktreeID, worktree])

  useEffect(() => {
    if (!sessionID || history[sessionID]) return
    void loadTranscript(sessionID).then((items) =>
      setHistory((previous) => ({ ...previous, [sessionID]: items })))
  }, [sessionID, history])

  // A dropped socket misses every event in the gap. On reconnect the cached history is stale.
  useEffect(() => {
    if (!store.connected || !sessionID) return
    void loadTranscript(sessionID).then((items) =>
      setHistory((previous) => ({ ...previous, [sessionID]: items })))
  }, [store.connected, sessionID])

  // A turn that ends somewhere else earns a dot, so nothing needs polling by eye.
  const runningKey = [...store.running].sort().join(',')
  useEffect(() => {
    setAttention((current) => {
      const next = new Set(current)
      for (const candidate of store.sessions) {
        if (!store.running.has(candidate.id) && candidate.id !== sessionID
            && (store.transcripts[candidate.id]?.length ?? 0) > 0) {
          next.add(candidate.id)
        }
      }
      if (sessionID) next.delete(sessionID)
      return next
    })
  }, [runningKey, sessionID, store.sessions, store.transcripts])

  const items = useMemo(
    () => (sessionID
      ? mergeTranscript(history[sessionID] ?? [], store.transcripts[sessionID] ?? [])
      : []),
    [sessionID, history, store.transcripts])

  // Everything below is per session: without this the draft, the comment chips and the open
  // source file follow you into the next session and are sent or resolved against the wrong one.
  useEffect(() => { setComments([]); setOpenRequest(null) }, [sessionID])

  // The server needs to know what is on screen: a turn you watched finish should not also ping.
  useEffect(() => {
    const report = () => void api.attention(sessionID, document.hasFocus()).catch(quiet)
    report()
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, [sessionID])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  // Both side panels remember their width and whether they are tucked away.
  const [sidebarWidth, setSidebarWidth] = useStoredNumber('orchestrator.sidebarWidth', 240, 160, 520)
  const [sidebarCollapsed, setSidebarCollapsed] = useStoredFlag('orchestrator.sidebarCollapsed', false)
  /** A branch to open the Pull Requests tab already narrowed to; not persisted. */
  const [prQuery, setPRQuery] = useState<string | null>(null)
  const [projectPRs, setProjectPRs] = useState<PRRow[]>([])
  const [reviewWidth, setReviewWidth] = useStoredNumber('orchestrator.reviewWidth', 560, 320, 1100)
  const openSession = useCallback((id: string) => {
    setSessionID(id); setWorktreeID(null); setTab('sessions')
    setAttention((current) => { const next = new Set(current); next.delete(id); return next })
  }, [])

  // A worktree is its sessions: clicking it lands in the first one, made on the spot if there is none.
  const openWorktree = useCallback((id: string) => {
    const first = store.sessions.find((entry) => entry.worktreeID === id && !entry.isArchived)
    if (first) { openSession(first.id); return }
    setWorktreeID(id); setSessionID(null); setTab('sessions')
    void api.newSession(id).then((created: any) => { refresh(); if (created?.id) openSession(created.id) }).catch(reportError)
  }, [store.sessions, openSession, refresh])

  // Clicking a notification lands on what it was about.
  useEffect(() => {
    const open = (event: Event) => {
      const notice = (event as CustomEvent<{ sessionID?: string; tab?: string }>).detail
      if (notice?.sessionID) openSession(notice.sessionID)
      else if (notice?.tab === 'github') setTab('github')
    }
    window.addEventListener('orchestrator:open', open)
    return () => window.removeEventListener('orchestrator:open', open)
  }, [openSession])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []
    for (const candidate of store.sessions.filter((entry) => !entry.isArchived)) {
      const home = store.worktrees.find((entry) => entry.id === candidate.worktreeID)
      list.push({
        id: `session-${candidate.id}`, group: 'Session',
        label: candidate.title, hint: home?.name,
        run: () => openSession(candidate.id),
      })
    }
    for (const entry of store.worktrees.filter((candidate) => !candidate.isArchived)) {
      list.push({
        id: `worktree-${entry.id}`, group: 'Worktree', label: entry.name,
        hint: entry.branch ?? undefined,
        run: () => openWorktree(entry.id),
      })
      list.push({
        id: `new-session-${entry.id}`, group: 'New', label: `New session in ${entry.name}`,
        run: () => void api.newSession(entry.id).then(refresh),
      })
    }
    for (const entry of store.projects) {
      list.push({
        id: `new-worktree-${entry.id}`, group: 'New', label: `New worktree in ${entry.name}`,
        run: () => void api.newWorktree(entry.id).then(refresh),
      })
      list.push({
        id: `new-worktree-options-${entry.id}`, group: 'New',
        label: `New worktree in ${entry.name} (choose branch, group)…`,
        run: () => setWorktreeDialog(entry),
      })
    }
    if (session) {
      for (const [label, value] of MODELS[session.engine]) {
        list.push({
          id: `model-${label}`, group: 'Model', label: `Model: ${label}`,
          run: () => void api.patchSession(session.id, { model: value }),
        })
      }
      for (const value of EFFORTS[session.engine]) {
        list.push({
          id: `effort-${value ?? 'default'}`, group: 'Effort',
          label: `Effort: ${value ?? `${DEFAULT_EFFORT[session.engine]} (default)`}`,
          run: () => void api.patchSession(session.id, { effort: value } as Partial<Session>),
        })
      }
      for (const [value, label] of ACCESS) {
        list.push({
          id: `access-${value}`, group: 'Access', label: `Access: ${label}`,
          run: () => void api.patchSession(session.id, { accessMode: value }),
        })
      }
      list.push({
        id: 'switch-engine', group: 'Session',
        label: `Switch to ${session.engine === 'claude' ? 'Codex' : 'Claude'}`,
        run: () => void api.patchSession(session.id, {
          engine: session.engine === 'claude' ? 'codex' : 'claude',
        }),
      })
      list.push({
        id: 'name-session', group: 'Session', label: 'Rename session with Claude',
        run: () => void api.nameSession(session.id).catch(reportError),
      })
    }
    list.push({ id: 'settings', group: 'Go to', label: 'Settings', run: () => setSettingsOpen(true) })
    for (const [id, label] of [['sessions', 'Sessions'], ['infra', 'Claude Infra'],
                               ['usage', 'Usage'], ['prs', 'Pull Requests'],
                               ['github', 'GitHub comments'], ['tasks', 'Tasks and subagents']] as const) {
      list.push({ id: `tab-${id}`, group: 'Go to', label, run: () => setTab(id) })
    }
    return list
  }, [store.sessions, store.worktrees, store.projects, session, openSession, openWorktree, refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true); return }
      if (meta && event.key === '.') {
        event.preventDefault()
        if (session && isRunning) void api.stop(session.id)
        return
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault(); setShowReview((value) => !value); return
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('orchestrator:dictate'))
        return
      }
      if (meta && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setShowTerminal((open) => !open)
        return
      }
      if (meta && event.key >= '1' && event.key <= '6') {
        event.preventDefault()
        setTab((['sessions', 'infra', 'usage', 'prs', 'github', 'tasks'] as Tab[])[Number(event.key) - 1])
        return
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        const next = store.sessions.find((candidate) => attention.has(candidate.id))
        if (next) openSession(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, isRunning, store.sessions, attention, openSession])

  const worktreeSessions = worktree
    ? store.sessions.filter((candidate) => candidate.worktreeID === worktree.id && !candidate.isArchived)
    : []

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar flex items-center gap-2 border-b border-ink-800 bg-ink-900 px-3 py-1.5"
              style={{ paddingLeft: 84 }} data-testid="titlebar">
        <span className="text-[12px] font-semibold">Sloperator</span>
        <span className={`h-1.5 w-1.5 rounded-full ${store.connected ? 'bg-ok' : 'bg-bad'}`}
              title={store.connected ? 'Connected' : 'Reconnecting…'} />
        <div className="ml-2 flex items-center gap-0.5" role="tablist">
          {([['sessions', 'Sessions'], ['infra', 'Claude Infra'], ['usage', 'Usage'],
             ['prs', 'Pull Requests'], ['github', 'GitHub'], ['tasks', 'Tasks']] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                tab === id ? 'bg-ink-700 text-white' : 'text-ink-400 hover:bg-white/5'}`}
              onClick={() => { if (id === 'prs') setPRQuery(null); setTab(id as Tab) }}
            >{label}</button>))}
        </div>
        <button className="chip-button ml-auto" onClick={() => setPaletteOpen(true)}>⌘K</button>
        <button className="icon-button" aria-label="Settings" title="Settings"
                onClick={() => setSettingsOpen(true)}>⚙</button>
      </header>

      <div className="flex min-h-0 flex-1">
        {tab === 'sessions' && sidebarCollapsed && (
          <CollapsedStrip side="left" onClick={() => setSidebarCollapsed(false)}
                          label="Show sidebar" title="Show the sidebar" />)}
        {tab === 'sessions' && !sidebarCollapsed && (
          <div className="relative flex shrink-0" style={{ width: sidebarWidth }} data-testid="sidebar-column">
            <div className="absolute left-1.5 top-1.5 z-10">
              <PanelToggle collapsed={false} onClick={() => setSidebarCollapsed(true)}
                           label="Hide sidebar" title="Hide the sidebar" />
            </div>
          <Sidebar
            projects={store.projects}
            worktrees={store.worktrees}
            sessions={store.sessions}
            running={store.running}
            attention={attention}
            asking={store.asking}
            selectedSession={sessionID}
            selectedWorktree={worktreeID}
            onSelectSession={openSession}
            onSelectWorktree={openWorktree}
            onNewWorktree={setWorktreeDialog}
            onQuickWorktree={(project) => void api.newWorktree(project.id)
              .then((created: any) => { refresh(); if (created?.session?.id) openSession(created.session.id) })
              .catch(reportError)}
            onChanged={refresh}
          />
          </div>)}
        {tab === 'sessions' && !sidebarCollapsed && (
          <div className="w-1.5 shrink-0 cursor-col-resize border-x border-ink-800 bg-ink-900 hover:bg-accent/40"
               role="separator" aria-label="Resize sidebar" aria-orientation="vertical"
               onMouseDown={(event) => startDrag(event, sidebarWidth, 1, setSidebarWidth)}
               onDoubleClick={() => setSidebarWidth(240)} />)}

        <main className="flex min-w-0 flex-1 flex-col">
          {tab === 'infra' && <InfraTab />}
          {tab === 'usage' && <UsageTab />}
          {tab === 'prs' && (
            <PullRequestsTab
              key={prQuery ?? 'all'}
              initialQuery={prQuery ?? ''}
              projects={store.projects}
              worktrees={store.worktrees}
              sessions={store.sessions}
              defaultProjectID={worktree?.projectID ?? null}
              onOpenSession={openSession}
              onChanged={refresh}
            />)}
          {tab === 'tasks' && (
            <TasksTab onOpenSession={openSession}
                      onStopSession={(id) => void api.stop(id).catch(quiet)} />)}
          {tab === 'github' && (
            <GitHubTab
              projects={store.projects}
              defaultProjectID={worktree?.projectID ?? null}
              onOpenSession={openSession}
              onChanged={refresh}
            />)}

          {tab === 'sessions' && session && worktree && (
            <>
              <div className="flex min-h-0 flex-1">
                {chatCollapsed && (
                  <CollapsedStrip side="left" onClick={() => setChatCollapsed(false)}
                                  label="Show chat" title="Show the chat" />)}
                <div className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${chatCollapsed ? 'hidden' : 'flex-1'}`} data-testid="chat-column">
                {project && (
                  <WorktreeSetup
                    key={worktree.id}
                    leading={<PanelToggle collapsed={false} onClick={() => setChatCollapsed(true)}
                                          label="Hide chat" title="Hide the chat; the review takes the room" />}
                    worktree={worktree}
                    project={project}
                    sessionCount={worktreeSessions.length}
                    inUse={store.worktrees
                      .filter((entry) => entry.projectID === worktree.projectID && entry.id !== worktree.id)
                      .map((entry) => entry.branch ?? '')
                      .filter(Boolean)}
                    onChanged={refresh}
                  />)}
                <Chat
                  key={session.id}
                  session={session}
                  items={items}
                  running={isRunning}
                  skills={skills}
                  comments={comments}
                  onRemoveComment={(id) =>
                    setComments((current) => current.filter((comment) => comment.id !== id))}
                  onClearComments={() => setComments([])}
                  onContinue={() => void api.retry(session.id).catch(reportError)}
                  density={density}
                  onOpenFile={(path) => {
                    setShowReview(true)
                    setOpenRequest({ path: path.startsWith('/') ? path : `${worktree.path}/${path}`, nonce: Date.now() })
                  }}
                  resolveImage={(src) => api.rawFileURL(src.startsWith('/') ? src : `${worktree.path}/${src}`)}
                />
                <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-800 bg-ink-900 px-2 py-1.5">
                  <div className="flex rounded-md bg-ink-850 p-0.5" role="group" aria-label="Steering">
                    {(['queue', 'steer'] as const).map((choice) => (
                      <button key={choice} aria-pressed={session.steeringMode === choice}
                              className={`rounded px-2 py-0.5 text-[11px] ${session.steeringMode === choice ? 'bg-ink-700 text-white' : 'text-ink-400'}`}
                              title={choice === 'queue'
                                ? 'A message sent while the agent runs waits for the turn to end'
                                : 'A message sent while the agent runs interrupts it'}
                              onClick={() => void api.patchSession(session.id, { steeringMode: choice })}>
                        {choice === 'queue' ? '⏱ Queue' : '⚡ Steer'}
                      </button>))}
                  </div>

                  {isRunning && (
                    <span className="chip text-ok">
                      <span className="dot-running h-1.5 w-1.5 rounded-full bg-ok" />Working
                    </span>)}
                  {session.totalCostUSD > 0 && (
                    <span className="chip font-mono">${session.totalCostUSD.toFixed(3)}</span>)}

                  <select className="chip-button" aria-label="Engine" value={session.engine}
                          onChange={(event) => void api.patchSession(session.id, {
                            engine: event.target.value as Session['engine'] })}>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                  </select>
                  <select className="chip-button" aria-label="Model" value={session.model ?? STRONGEST_MODEL[session.engine]}
                          onChange={(event) => void api.patchSession(session.id, { model: event.target.value })}>
                    {MODELS[session.engine].map(([label, value]) => (
                      <option key={label} value={value}>{label}</option>))}
                  </select>
                  <select className="chip-button" aria-label="Reasoning effort" value={session.effort ?? ''}
                          onChange={(event) => void api.patchSession(session.id, {
                            effort: event.target.value || null } as Partial<Session>)}>
                    {EFFORTS[session.engine].map((value) => (
                      <option key={value ?? 'default'} value={value ?? ''}>{value ?? `${DEFAULT_EFFORT[session.engine]} (default)`}</option>))}
                  </select>
                  <select className="chip-button" aria-label="Access mode" value={session.accessMode}
                          title="Read only: nothing is changed. Auto edits: files are edited without asking; commands, the web and questions come to you in the chat. Full access: nothing asks."
                          onChange={(event) => void api.patchSession(session.id, {
                            accessMode: event.target.value as Session['accessMode'] })}>
                    {ACCESS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select className="chip-button" aria-label="Log detail" title="How much of the agent's work to show"
                          value={density} onChange={(event) => chooseDensity(event.target.value as LogDensity)}>
                    <option value="ubercompact">Ubercompact</option>
                    <option value="compact">Compact</option>
                    <option value="normal">Normal</option>
                    <option value="verbose">Verbose</option>
                  </select>
                  <button className={`chip-button ${showTerminal ? 'bg-white/10 text-ink-100' : ''}`}
                          aria-label="Toggle terminal" aria-pressed={showTerminal}
                          title="Terminal in this worktree (⌘J)"
                          onClick={() => setShowTerminal((value) => !value)}>⌨ Terminal</button>
                  {(() => {
                    const mine = projectPRs.find((row) => row.headRefName === worktree.branch)
                    const tone = mine ? PR_STATE_TONE[mine.state] ?? PR_STATE_TONE.open : null
                    return (
                      <button className="chip-button" aria-label="Pull request for this branch"
                              title={mine
                                ? `#${mine.number} ${tone!.label} — ${mine.title}`
                                : 'No pull request for this branch yet'}
                              onClick={() => { setPRQuery(mine ? `#${mine.number}` : worktree.branch ?? ''); setTab('prs') }}>
                        {mine && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone!.dot}`} />}
                        {mine ? `#${mine.number} ${tone!.label.toLowerCase()}` : 'PR'}
                      </button>)
                  })()}
                </div>
                {showTerminal && (
                  <div className="h-[38%] min-h-[180px]">
                    <TerminalDrawer worktreeID={worktree.id} worktreeName={worktree.name}
                                    onClose={() => setShowTerminal(false)} />
                  </div>)}
                </div>
                {!showReview && (
                  <CollapsedStrip side="right" onClick={() => setShowReview(true)}
                                  label="Show review panel" title="Show the review panel (⌘⇧R)" />)}
                {showReview && !chatCollapsed && (
                  <div className="w-1.5 shrink-0 cursor-col-resize border-x border-ink-800 bg-ink-900 hover:bg-accent/40"
                       role="separator" aria-label="Resize review panel" aria-orientation="vertical"
                       onMouseDown={(event) => startDrag(event, reviewWidth, -1, setReviewWidth)}
                       onDoubleClick={() => setReviewWidth(560)} />)}
                {showReview && (
                  <div className={`flex flex-col ${chatCollapsed ? 'min-w-0 flex-1' : 'shrink-0'}`}
                       style={chatCollapsed ? undefined : { width: reviewWidth }} data-testid="review-column">
                    <ReviewPanel
                      key={worktree.id}
                      worktreeID={worktree.id}
                      worktreePath={worktree.path}
                      branch={worktree.branch ?? null}
                      baseBranch={worktree.baseBranch ?? null}
                      isMain={worktree.isMain}
                      generation={generation + (isRunning ? 0 : 1)}
                      onAddComment={(comment) => setComments((current) => [...current, comment])}
                      onQuote={(text) => void api.send(session.id, text, [])}
                      onCollapse={() => setShowReview(false)}
                      open={openRequest}
                    />
                  </div>)}
              </div>
            </>)}

          {tab === 'sessions' && !session && worktree && (
            <div className="grid flex-1 place-items-center text-center text-ink-500">
              <button className="btn-primary" onClick={() => openWorktree(worktree.id)}>Open {worktree.name}</button>
            </div>)}

          {tab === 'sessions' && !session && !worktree && (
            <div className="grid flex-1 place-items-center text-center text-ink-500">
              <div>
                <p className="text-[14px]">Nothing selected</p>
                <p className="mt-1">Press <span className="chip">⌘K</span> to jump anywhere.</p>
              </div>
            </div>)}
        </main>
      </div>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {worktreeDialog && (
        <NewWorktreeDialog
          project={worktreeDialog}
          inUse={store.worktrees
            .filter((entry) => entry.projectID === worktreeDialog.id)
            .map((entry) => entry.branch ?? '')
            .filter(Boolean)}
          onClose={() => setWorktreeDialog(null)}
          onCreated={(sessionID) => { refresh(); if (sessionID) openSession(sessionID) }}
        />)}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <Toasts />
    </div>
  )
}
