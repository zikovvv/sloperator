import { useState } from 'react'
import { useStoredValue } from '../lib/resizable.ts'
import { reportError } from '../lib/toast.ts'
import type { Project, Session, Worktree } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { TextPrompt } from './TextPrompt.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'

const FOLDS_KEY = 'orchestrator.foldedFolders'
function loadFolds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '[]')) } catch { return new Set() }
}

interface Props {
  projects: Project[]
  onNewWorktree: (project: Project) => void
  /** The + button: a worktree on a fresh branch from main, and its chat, with no questions. */
  onQuickWorktree: (project: Project) => void
  worktrees: Worktree[]
  sessions: Session[]
  running: Set<string>
  attention: Set<string>
  /** Sessions with a question or a permission prompt waiting on the person. */
  asking?: Set<string>
  selectedSession: string | null
  selectedWorktree: string | null
  onSelectSession: (id: string) => void
  onSelectWorktree: (id: string) => void
  onChanged: () => void
}

function Dot({ tone }: { tone: 'running' | 'attention' | 'asking' }) {
  if (tone === 'asking') return <span className="dot-running h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Waiting for your answer" />
  return tone === 'running'
    ? <span className="dot-running h-1.5 w-1.5 shrink-0 rounded-full bg-ok" title="Working" />
    : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Finished while you were away" />
}

/** A menu that is a plain button, so it never inherits a native control's chrome. */
function RowMenu({ items }: { items: Array<{ label: string; danger?: boolean; run: () => void }> }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative">
      <button
        className="icon-button"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }}
      >⋯</button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={(event) => { event.stopPropagation(); setOpen(false) }} />
          <div role="menu"
               className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-ink-700 bg-ink-850 py-1 shadow-xl">
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`block w-full px-3 py-1.5 text-left text-[12px] hover:bg-white/10 ${
                  item.danger ? 'text-red-300' : ''}`}
                onClick={(event) => { event.stopPropagation(); setOpen(false); item.run() }}
              >{item.label}</button>))}
          </div>
        </>)}
    </span>
  )
}

export function Sidebar({
  projects, worktrees, sessions, running, attention, asking, onNewWorktree, onQuickWorktree,
  selectedSession, selectedWorktree, onSelectSession, onSelectWorktree, onChanged,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const report = reportError
  const [ask, setAsk] = useState<
    { title: string; label: string; initial?: string; placeholder?: string; run: (value: string) => void } | null>(null)
  const [confirmation, setConfirmation] = useState<
    { title: string; body?: string; confirmLabel?: string; run: () => void } | null>(null)
  // Folded folders persist per browser; dragging reorders folders or moves a worktree into one.
  const [folded, setFolded] = useState<Set<string>>(loadFolds)
  const [dragging, setDragging] = useState<{ kind: 'folder' | 'worktree'; id: string; projectID: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const toggleFold = (key: string) => setFolded((current) => {
    const next = new Set(current)
    next.has(key) ? next.delete(key) : next.add(key)
    try { localStorage.setItem(FOLDS_KEY, JSON.stringify([...next])) } catch { /* private mode */ }
    return next
  })
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Worktrees start folded; the one holding the open session unfolds itself until it is folded by hand.
  const [folds, setFolds] = useStoredValue<Record<string, boolean>>('orchestrator.worktreeFolds', {})
  const openWorktreeID = selectedSession ? sessions.find((entry) => entry.id === selectedSession)?.worktreeID ?? null : null
  // One box narrows worktrees (by name or branch) and sessions (by title); folds are ignored while it is in use.
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const matches = (text: string | null | undefined) => (text ?? '').toLowerCase().includes(needle)

  const rename = (kind: 'session' | 'worktree', id: string, current: string) => setAsk({
    title: `Rename ${kind}`, label: 'Name', initial: current,
    run: (value) => void (kind === 'session'
      ? api.patchSession(id, { title: value })
      : api.patchWorktree(id, { name: value })).then(onChanged).catch(report),
  })

  return (
    <nav className="flex h-full w-full min-w-0 flex-col bg-ink-900" aria-label="Projects">
      <div className="border-b border-ink-800 p-1.5 pl-8">
        <input className="field w-full min-w-0 py-1 text-[12px]" type="search" placeholder="Filter worktrees, branches, sessions…"
               aria-label="Filter sidebar" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {projects.map((project) => {
          const sessionsIn = (worktreeID: string) =>
            sessions.filter((session) => session.worktreeID === worktreeID && !session.isArchived)
          const projectWorktrees = worktrees
            .filter((worktree) => worktree.projectID === project.id && !worktree.isArchived)
            .filter((worktree) => !needle || matches(worktree.name) || matches(worktree.branch)
              || sessionsIn(worktree.id).some((session) => matches(session.title)))
            .sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
          const archivedWorktrees = worktrees.filter(
            (worktree) => worktree.projectID === project.id && worktree.isArchived)
          const projectWorktreeIDs = new Set(
            worktrees.filter((worktree) => worktree.projectID === project.id).map((worktree) => worktree.id))
          const archivedSessions = sessions.filter(
            (entry) => entry.isArchived && projectWorktreeIDs.has(entry.worktreeID))
          const groups = [...new Set([
            ...project.worktreeGroups,
            'main',
            ...projectWorktrees.map((worktree) => worktree.group || 'main'),
          ])]
          const activeCount = projectWorktrees
            .flatMap((worktree) => sessions.filter((session) => session.worktreeID === worktree.id))
            .filter((session) => running.has(session.id)).length

          return (
            <div key={project.id} className="mb-1">
              <div className="group flex items-center gap-1 px-1 py-1">
                <button className="icon-button h-5 w-5" aria-label="Toggle project"
                        onClick={() => toggle(project.id)}>
                  {collapsed.has(project.id) ? '›' : '⌄'}
                </button>
                <span className="flex-1 truncate text-[12px] font-semibold uppercase tracking-wide text-ink-300">
                  {project.name}
                </span>
                {activeCount > 0 && <><Dot tone="running" /><span className="text-[10px] text-ok">{activeCount}</span></>}
                <button className="icon-button" aria-label="New worktree"
                        title="New worktree on a fresh branch from main — start typing; change the branch at the top of the chat"
                        onClick={() => onQuickWorktree(project)}>+</button>
                <RowMenu items={[
                  { label: 'New worktree…', run: () => onNewWorktree(project) },
                  { label: 'Quick worktree (auto branch, no questions)', run: () => onQuickWorktree(project) },
                  { label: 'Add group directory…', run: () => setAsk({
                    title: `New group in ${project.name}`, label: 'Directory name',
                    placeholder: 'work, review, experiments',
                    run: (name) => void api.addGroup(project.id, name).then(onChanged)
                      .catch(report),
                  }) },
                  { label: 'Remove project', danger: true,
                    run: () => setConfirmation({
                      title: `Remove ${project.name} from the list?`,
                      body: 'Nothing on disk is touched. Worktrees and branches stay where they are.',
                      confirmLabel: 'Remove',
                      run: () => void api.deleteProject(project.id).then(onChanged).catch(report),
                    }) },
                ]} />
              </div>

              {!collapsed.has(project.id) && groups.map((groupName) => {
                const inGroup = projectWorktrees.filter(
                  (worktree) => (worktree.group || 'main') === groupName)
                if (needle && !inGroup.length) return null
                const isFolded = folded.has(`${project.id}/${groupName}`) && !needle
                return (
                <div key={groupName}
                     onDragOver={(event) => {
                       if (!dragging || dragging.projectID !== project.id) return
                       event.preventDefault(); setDropTarget(`${project.id}/${groupName}`)
                     }}
                     onDragLeave={() => setDropTarget((current) => current === `${project.id}/${groupName}` ? null : current)}
                     onDrop={(event) => {
                       event.preventDefault(); setDropTarget(null)
                       if (!dragging || dragging.projectID !== project.id) return
                       if (dragging.kind === 'worktree') {
                         void api.moveWorktree(dragging.id, groupName).then(onChanged).catch(report)
                       } else if (dragging.id !== groupName) {
                         const order = groups.filter((name) => name !== dragging.id)
                         order.splice(order.indexOf(groupName), 0, dragging.id)
                         void api.reorderGroups(project.id, order).then(onChanged).catch(report)
                       }
                       setDragging(null)
                     }}
                     className={dropTarget === `${project.id}/${groupName}` ? 'rounded-md bg-accent/10 ring-1 ring-accent/40' : ''}>
                  {groupName && (
                    <div className="flex items-center gap-1 pl-3 pr-1 pt-1">
                      <span className="cursor-grab text-[10px] text-ink-600 hover:text-ink-300 active:cursor-grabbing"
                            draggable title="Drag to reorder folders"
                            onDragStart={() => setDragging({ kind: 'folder', id: groupName, projectID: project.id })}
                            onDragEnd={() => { setDragging(null); setDropTarget(null) }}>⋮⋮</span>
                      <button className="label flex flex-1 items-center gap-1 truncate text-left"
                              aria-expanded={!isFolded}
                              onClick={() => toggleFold(`${project.id}/${groupName}`)}>
                        <span className="w-3 text-ink-500">{isFolded ? '▸' : '▾'}</span>
                        {groupName}
                        <span className="text-ink-600">({inGroup.length})</span>
                      </button>
                      {groupName !== 'main' && (
                        <button className="icon-button" aria-label="Rename folder" title="Rename folder"
                                onClick={() => setAsk({
                                  title: `Rename folder ${groupName}`, label: 'Name', initial: groupName,
                                  run: (name) => void api.renameGroup(project.id, groupName, name).then(onChanged).catch(report),
                                })}>✎</button>)}
                      {!inGroup.length && groupName !== 'main' && (
                        <button className="icon-button" aria-label="Remove empty group"
                                title="Remove empty group"
                                onClick={() => void api.removeGroup(project.id, groupName).then(onChanged).catch(report)}>×</button>)}
                    </div>)}
                  {!isFolded && inGroup.map((worktree) => {
                // A worktree matched by its own name shows every session; one matched only through a session shows those.
                const worktreeSessions = sessionsIn(worktree.id)
                  .filter((session) => !needle || matches(worktree.name) || matches(worktree.branch) || matches(session.title))
                  .sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
                // Landing in a worktree unfolds it only when there is a choice to make: with a single
                // session that row is just the chat already on screen.
                const isOpen = !!needle || (folds[worktree.id] ?? (openWorktreeID === worktree.id && worktreeSessions.length > 1))
                // Folded — and a single-session worktree always is — the row is all you see, so it
                // carries the most pressing status of the sessions inside: waiting on you beats working.
                const inside = sessionsIn(worktree.id)
                const worktreeTone = inside.some((entry) => asking?.has(entry.id)) ? 'asking' as const
                  : inside.some((entry) => attention.has(entry.id)) ? 'attention' as const
                  : inside.some((entry) => running.has(entry.id)) ? 'running' as const : null
                const toggleWorktree = () => setFolds((current) => ({ ...current, [worktree.id]: !isOpen }))
                const tone = selectedWorktree === worktree.id ? 'row-active' : openWorktreeID === worktree.id ? 'row-open' : 'row-idle'
                return (
                  <div key={worktree.id}>
                    <div
                      className={`row ${tone} py-0.5 pl-5`}
                      onClick={() => onSelectWorktree(worktree.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => event.key === 'Enter' && onSelectWorktree(worktree.id)}
                    >
                      <button className="w-3 shrink-0 text-[10px] text-ink-500 hover:text-ink-200"
                              aria-label={isOpen ? 'Collapse worktree' : 'Expand worktree'} aria-expanded={isOpen}
                              onClick={(event) => { event.stopPropagation(); toggleWorktree() }}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                      <span
                        className="cursor-grab text-[10px] text-ink-500 active:cursor-grabbing"
                        draggable={!worktree.isMain}
                        title={worktree.isMain ? undefined : 'Drag onto a folder to move this worktree there'}
                        onClick={(event) => event.stopPropagation()}
                        onDragStart={(event) => {
                          event.stopPropagation()
                          setDragging({ kind: 'worktree', id: worktree.id, projectID: project.id })
                        }}
                        onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                      >{worktree.isMain ? '⌂' : '⑂'}</span>
                      <span className="min-w-0 flex-1 leading-tight">
                        {/* Named by what is being done there: its first session's title, else the branch it was opened on. */}
                        <span className="block truncate text-[12px]" data-testid="worktree-title" title={worktree.name}>
                          {worktree.isMain || worktree.nameIsManual ? worktree.name
                            : worktreeSessions.map((entry) => entry.title).find((title) => title && title !== 'New session')
                              ?? worktree.branch?.replace(/^orch\//, '') ?? worktree.name}
                        </span>
                        <span className="block truncate text-[10px] text-ink-500">
                          {worktree.branch && <span className="font-mono">{worktree.branch} · </span>}
                          {`${worktreeSessions.length} session${worktreeSessions.length === 1 ? '' : 's'}`}
                          {worktreeSessions.some((entry) => running.has(entry.id)) ? ' · working' : ''}
                        </span>
                      </span>
                      {worktreeTone && <Dot tone={worktreeTone} />}
                      {worktree.isPinned && <span className="text-[10px] text-warn" title="Pinned">▲</span>}
                      <button className="icon-button" aria-label="New session" title="New session"
                              onClick={(event) => {
                                event.stopPropagation()
                                void api.newSession(worktree.id)
                                  .then((created: any) => { onChanged(); if (created?.id) onSelectSession(created.id) })
                                  .catch(report)
                              }}>+</button>
                      <RowMenu items={[
                        { label: 'New session', run: () => void api.newSession(worktree.id)
                          .then((created: any) => { onChanged(); if (created?.id) onSelectSession(created.id) }).catch(report) },
                        { label: 'Rename…', run: () => void rename('worktree', worktree.id, worktree.name) },
                        { label: worktree.isPinned ? 'Unpin' : 'Pin to top',
                          run: () => void api.patchWorktree(worktree.id, { isPinned: !worktree.isPinned }).then(onChanged).catch(report) },
                        ...(worktree.isMain ? [] : [
                          ...[...new Set(['main', ...project.worktreeGroups])]
                            .filter((target) => target !== (worktree.group || 'main'))
                            .map((target) => ({
                              label: `Move to ${target}`,
                              run: () => void api.moveWorktree(worktree.id, target)
                                .then(onChanged)
                                .catch(report),
                            })),
                          { label: 'Archive',
                            run: () => void api.patchWorktree(worktree.id, { isArchived: true }).then(onChanged).catch(report) },
                          { label: 'Delete worktree…', danger: true, run: () => setConfirmation({
                            title: `Do you really want to delete “${worktree.name}”?`,
                            body: `This deletes ${worktree.path}, any uncommitted changes in it, and `
                              + `${sessions.filter((entry) => entry.worktreeID === worktree.id).length} session(s). `
                              + `The branch ${worktree.branch ?? ''} is NOT deleted.`,
                            confirmLabel: 'Delete',
                            run: () => void api.deleteWorktree(worktree.id).then(onChanged).catch(report),
                          }) },
                        ]),
                      ]} />
                    </div>

                    {isOpen && worktreeSessions.map((session) => (
                      <div
                        key={session.id}
                        className={`row py-0.5 pl-9 ${selectedSession === session.id ? 'row-active' : 'row-idle'}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectSession(session.id)}
                        onKeyDown={(event) => event.key === 'Enter' && onSelectSession(session.id)}
                      >
                        <span className={`text-[9px] ${session.engine === 'claude' ? 'text-orange-400' : 'text-teal-400'}`}>●</span>
                        <span className="flex-1 truncate text-[11px]">{session.title}</span>
                        {session.isPinned && <span className="text-[10px] text-warn">▲</span>}
                        {asking?.has(session.id) ? <Dot tone="asking" />
                          : running.has(session.id) ? <Dot tone="running" />
                          : attention.has(session.id) ? <Dot tone="attention" /> : null}
                        <RowMenu items={[
                          { label: 'Rename…', run: () => void rename('session', session.id, session.title) },
                          { label: 'Rename with Claude', run: () => void api.nameSession(session.id).then(onChanged).catch(report) },
                          { label: session.isPinned ? 'Unpin' : 'Pin to top',
                            run: () => void api.patchSession(session.id, { isPinned: !session.isPinned } as any).then(onChanged).catch(report) },
                          { label: 'Archive',
                            run: () => void api.patchSession(session.id, { isArchived: true } as any).then(onChanged).catch(report) },
                          { label: 'Delete session', danger: true,
                            run: () => setConfirmation({
                              title: `Delete “${session.title}”?`,
                              body: 'Only the chat is deleted. The worktree is untouched.',
                              confirmLabel: 'Delete',
                              run: () => void api.deleteSession(session.id).then(onChanged).catch(report),
                            }) },
                        ]} />
                      </div>))}
                  </div>)
              })}
                </div>)
              })}

              {!collapsed.has(project.id) && archivedSessions.length > 0 && (
                <details className="px-2 pt-1">
                  <summary className="cursor-pointer text-[11px] text-ink-500">
                    Archived sessions ({archivedSessions.length})
                  </summary>
                  {archivedSessions.map((entry) => (
                    <div key={entry.id} className="row row-idle pl-3">
                      <span className="flex-1 truncate text-[12px] text-ink-400">{entry.title}</span>
                      <button className="text-[10px] text-accent hover:underline"
                              onClick={() => void api.patchSession(entry.id, { isArchived: false }).then(onChanged).catch(report)}>
                        Restore
                      </button>
                    </div>))}
                </details>)}

              {!collapsed.has(project.id) && archivedWorktrees.length > 0 && (
                <details className="px-2 pt-1">
                  <summary className="cursor-pointer text-[11px] text-ink-500">
                    Archived worktrees ({archivedWorktrees.length})
                  </summary>
                  {archivedWorktrees.map((worktree) => (
                    <div key={worktree.id} className="row row-idle pl-3">
                      <span className="flex-1 truncate text-[12px] text-ink-400">{worktree.name}</span>
                      <button className="text-[10px] text-accent hover:underline"
                              onClick={() => void api.patchWorktree(worktree.id, { isArchived: false }).then(onChanged).catch(report)}>
                        Restore
                      </button>
                    </div>))}
                </details>)}
            </div>)
        })}
      </div>

      <div className="border-t border-ink-800 p-1.5">
        <button
          className="row row-idle text-ink-400"
          onClick={() => setAsk({
            title: 'Add project', label: 'Folder path (absolute)',
            placeholder: '/Users/you/Projects/thing',
            run: (path) => void api.addProject(path).then(onChanged)
              .catch(report),
          })}
        >+ Add project</button>
      </div>

      {confirmation && (
        <ConfirmDialog
          title={confirmation.title} body={confirmation.body} confirmLabel={confirmation.confirmLabel} danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => { confirmation.run(); setConfirmation(null) }}
        />)}
      {ask && (
        <TextPrompt
          title={ask.title} label={ask.label} initial={ask.initial} placeholder={ask.placeholder}
          onCancel={() => setAsk(null)}
          onSubmit={(value) => { ask.run(value); setAsk(null) }}
        />)}
    </nav>
  )
}
