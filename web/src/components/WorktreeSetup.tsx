import type React from 'react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import type { Project, Worktree } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { reportError } from '../lib/toast.ts'
import { BranchField } from './NewWorktreeDialog.tsx'

/**
 * The worktree's settings, at the top of its session: what branch it is on, what it forked
 * from, which folder it lives in. A one-line bar that opens only when asked — switching sessions
 * should not keep unfolding a panel nobody wanted.
 */
export function WorktreeSetup({ worktree, project, inUse, sessionCount, onChanged, leading }: {
  worktree: Worktree
  project: Project
  /** Branches other worktrees hold: those can be forked from but not checked out again. */
  inUse: string[]
  sessionCount: number
  onChanged: () => void
  /** Sits first in the row: this is the top-left corner of the chat panel. */
  leading?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(worktree.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [info, setInfo] = useState<{ changedFiles: number } | null>(null)
  useEffect(() => { setName(worktree.name) }, [worktree.name])
  useEffect(() => {
    if (!open) return
    void api.worktreeInfo(worktree.id).then((result) => setInfo({ changedFiles: result.changedFiles })).catch(() => setInfo(null))
  }, [open, worktree.id])
  const commitName = () => {
    const next = name.trim()
    if (!next || next === worktree.name) { setName(worktree.name); return }
    apply(api.patchWorktree(worktree.id, { name: next }))
  }
  const [branches, setBranches] = useState<string[]>([])
  const branch = worktree.branch ?? ''
  const [rename, setRename] = useState(branch)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setRename(branch) }, [branch])
  useEffect(() => {
    if (!open) return
    void api.branches(project.path).then((result) => setBranches(result.branches)).catch(() => {})
  }, [open, project.path])

  const apply = (work: Promise<unknown>) => {
    setBusy(true)
    void work.then(onChanged).catch(reportError).finally(() => setBusy(false))
  }
  const commitRename = () => {
    const next = rename.trim()
    if (!next || next === worktree.branch) { setRename(branch); return }
    apply(api.switchBranch(worktree.id, { rename: next }))
  }
  const groups = [...new Set(['main', ...project.worktreeGroups])]
  const available = branches.filter((branch) => !inUse.includes(branch) && branch !== worktree.branch)

  return (
    <div className="border-b border-ink-800 bg-ink-850/60 px-3 py-1.5 text-[12px]" data-testid="worktree-setup">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        <span className="text-ink-300">{project.name}</span>
        <span className="text-ink-600">·</span>
        <span className="text-ink-500">⑂</span>
        <span className="font-mono">{worktree.branch ?? '—'}</span>
        <span className="text-ink-500">from</span>
        <span className="font-mono text-ink-300">{worktree.baseBranch ?? 'HEAD'}</span>
        <span className="text-ink-500">· folder</span>
        <span className="text-ink-300">{worktree.group ?? 'main'}</span>
        {info && info.changedFiles > 0 && (
          <span className="text-ink-500" title="Files changed versus the base">· {info.changedFiles} changed</span>)}
        {busy && <span className="dot-running h-1.5 w-1.5 rounded-full bg-accent" />}
        <button className="chip-button ml-auto" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide' : 'Worktree…'}
        </button>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
          <label className="block">
            <span className="label">Worktree name</span>
            <input className="field mt-1" aria-label="Worktree name" value={name}
                   onChange={(event) => setName(event.target.value)} onBlur={commitName}
                   onKeyDown={(event) => { if (event.key === 'Enter') commitName() }} />
            <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-500" title={worktree.path}>{worktree.path}</span>
          </label>
          {!worktree.isMain && (<>
          <label className="block">
            <span className="label">Branch name</span>
            <input className="field mt-1 font-mono" aria-label="Branch name" value={rename}
                   onChange={(event) => setRename(event.target.value)}
                   onBlur={commitRename}
                   onKeyDown={(event) => { if (event.key === 'Enter') commitRename() }} />
            <span className="mt-0.5 block text-[11px] text-ink-500">Rename any time; the chat follows the branch.</span>
          </label>
          <label className="block">
            <span className="label">Fork from</span>
            <div className="mt-1">
              <BranchField branches={branches} value={worktree.baseBranch ?? ''} placeholder="Choose a base…"
                           onChange={(base) => apply(api.switchBranch(worktree.id, { base }))} />
            </div>
            <span className="mt-0.5 block text-[11px] text-ink-500">Only while this worktree has no work of its own.</span>
          </label>
          <label className="block">
            <span className="label">Or check out an existing branch</span>
            <div className="mt-1">
              <BranchField branches={available} value="" placeholder="Choose a branch…"
                           onChange={(branch) => apply(api.switchBranch(worktree.id, { branch }))} />
            </div>
            <span className="mt-0.5 block text-[11px] text-ink-500">The generated branch is left behind; this worktree moves onto that branch.</span>
          </label>
          <label className="block">
            <span className="label">Folder</span>
            <select className="field mt-1" aria-label="Folder" value={worktree.group ?? 'main'}
                    onChange={(event) => apply(api.moveWorktree(worktree.id, event.target.value))}>
              {groups.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </label>
          <div className="col-span-2 flex flex-wrap items-center gap-2 border-t border-ink-800 pt-2">
            <button className="btn-quiet" title="Hide it in the sidebar; nothing on disk changes"
                    onClick={() => void api.patchWorktree(worktree.id, { isArchived: true }).then(onChanged).catch(reportError)}>Archive</button>
            <button className="btn-quiet" title="Forget it here; the folder and branch stay on disk"
                    onClick={() => void api.deleteWorktree(worktree.id, true).then(onChanged).catch(reportError)}>Remove from sidebar</button>
            <button className="btn-danger ml-auto" onClick={() => setConfirmDelete(true)}>Delete worktree</button>
          </div>
          </>)}
          {worktree.isMain && (
            <p className="col-span-2 text-[11px] text-ink-500">This is the project's own checkout: it keeps its branch, its folder and its place in the sidebar.</p>)}
        </div>)}
      {confirmDelete && (
        <ConfirmDialog
          title={`Do you really want to delete “${worktree.name}”?`}
          body={`This deletes ${worktree.path}, any uncommitted changes in it, and ${sessionCount} session(s). `
            + `The branch ${worktree.branch ?? ''} is NOT deleted.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void api.deleteWorktree(worktree.id).then(onChanged).catch(reportError)
          }}
        />)}
    </div>
  )
}
