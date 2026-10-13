import { useEffect, useRef, useState } from 'react'
import type { FolderListing } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useEscape } from '../lib/useEscape.ts'

/**
 * Picks a folder by browsing: starts at home, a click enters a folder, ↑ goes to its parent, and
 * the path can still be typed. Git repositories are marked; any other folder becomes one when added.
 */
export function FolderPicker({ title, onCancel, onPick }: { title: string; onCancel: () => void; onPick: (path: string) => void }) {
  useEscape(onCancel)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Only the newest listing lands, and never over a path typed while it was on its way.
  const request = useRef(0)
  const typedNow = useRef('')
  typedNow.current = typed
  const go = (path?: string) => {
    const mine = ++request.current
    const typedThen = typedNow.current
    void api.folders(path)
      .then((next) => {
        if (mine !== request.current || typedNow.current !== typedThen) return
        setListing(next); setTyped(next.path); setError(null)
      })
      .catch((failure: Error) => { if (mine === request.current) setError(failure.message) })
  }
  useEffect(() => { go() }, [])

  const shown = listing?.path === typed.trim() ? listing : null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
        <div className="mb-2 flex items-center gap-1.5">
          <button className="icon-button" aria-label="Parent folder" title="Parent folder" disabled={!listing?.parent}
                  onClick={() => go(listing!.parent!)}>↑</button>
          <input className="field flex-1 font-mono text-[12px]" aria-label="Folder path" autoFocus value={typed} placeholder="/Users/you/Projects/thing"
                 onChange={(event) => setTyped(event.target.value)}
                 onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); go(typed.trim()) } }} />
        </div>
        {error && <div className="mb-2 text-[11px] text-red-200">{error}</div>}
        <div className="min-h-[200px] flex-1 overflow-y-auto rounded-md border border-ink-800" role="listbox" aria-label="Folders">
          {listing?.folders.map((folder) => (
            <button key={folder.path} role="option" aria-selected={false} className="row row-idle w-full text-left" onClick={() => go(folder.path)}>
              <span className="text-ink-500">▸</span>
              <span className="flex-1 truncate text-[12px]">{folder.name}</span>
              {folder.isGit && <span className="chip text-[9px] text-ok">git</span>}
            </button>))}
          {listing && !listing.folders.length && <div className="px-3 py-2 text-[12px] text-ink-500">No folders inside.</div>}
          {listing && listing.more > 0 && (
            <div className="px-3 py-2 text-[11px] text-ink-500">{listing.more} more not shown: type the path above to go straight there.</div>)}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-ink-400">
            {shown && (shown.isGit ? 'A git repository.' : 'Not a git repository: adding it creates one, with a first commit of what is there.')}
          </span>
          <button className="btn-quiet" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={!typed.trim()} onClick={() => onPick(typed.trim())}>
            {shown && !shown.isGit ? 'Add and create a repository' : 'Add this folder'}
          </button>
        </div>
      </div>
    </div>
  )
}
