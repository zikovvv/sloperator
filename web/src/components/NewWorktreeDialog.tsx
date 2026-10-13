import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoredValue } from '../lib/resizable.ts'
import { applyAppearance, DEFAULT_APPEARANCE, FONTS, THEMES, type Appearance } from '../lib/theme.ts'
import { useEscape } from '../lib/useEscape.ts'
import type { Project } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { rank } from './CommandPalette.tsx'
import { suggestBranchName } from '../lib/branchName.ts'
import { quiet } from '../lib/quiet.ts'

/** Searchable branch field — a plain select is useless with a thousand refs. */
export function BranchField({ branches, value, onChange, placeholder, allowNone, noneLabel }: {
  branches: string[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  allowNone?: boolean
  noneLabel?: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const matches = useMemo(() => rank(branches, query, (branch) => branch).slice(0, 200), [branches, query])

  return (
    <div className="relative">
      <button type="button" className="field flex items-center justify-between text-left"
              onClick={() => setOpen((current) => !current)}>
        <span className={value ? 'font-mono text-[12px]' : 'text-ink-400'}>
          {value || noneLabel || placeholder}
        </span>
        <span className="text-ink-500">⌄</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-ink-700 bg-ink-850 shadow-xl">
          <input
            autoFocus
            className="w-full border-b border-ink-800 bg-transparent px-2.5 py-2 outline-none"
            placeholder={`Search ${branches.length} branches…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches[0]) { onChange(matches[0]); setOpen(false) }
            }}
          />
          <div className="max-h-64 overflow-y-auto p-1">
            {allowNone && (
              <button className="row row-idle italic text-ink-400"
                      onClick={() => { onChange(''); setOpen(false) }}>{noneLabel}</button>)}
            {matches.map((branch) => (
              <button key={branch} className="row row-idle font-mono text-[12px]"
                      onClick={() => { onChange(branch); setOpen(false) }}>
                <span className="flex-1 truncate">{branch}</span>
                {branch.includes('/') && !branch.startsWith('orch/') && (
                  <span className="text-[10px] text-ink-500">
                    {branch.startsWith('origin/') ? 'remote' : ''}
                  </span>)}
              </button>))}
            {!matches.length && <div className="px-2 py-3 text-ink-500">No branch matches “{query}”.</div>}
          </div>
        </div>)}
    </div>
  )
}

export function NewWorktreeDialog({ project, inUse, onClose, onCreated }: {
  project: Project
  inUse: string[]
  onClose: () => void
  /** Called with the session the server opened in the new worktree. */
  onCreated: (sessionID: string | null) => void
}) {
  useEscape(onClose)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [newBranch, setNewBranch] = useState(suggestBranchName)
  const [base, setBase] = useState('')
  const [existing, setExisting] = useState('')
  const chosenBranch = mode === 'new' ? newBranch : existing
  const effectiveName = name.trim() || chosenBranch.replace(/^orch\//, '').replace(/^origin\//, '')
  const [group, setGroup] = useState('main')
  const [moveWork, setMoveWork] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.branches(project.path).then((result) => {
      setBranches(result.branches)
      setBase(result.defaultBranch)
      setNewBranch((current) => (result.branches.includes(current) ? suggestBranchName(result.branches) : current))
    }).catch(quiet)
  }, [project.path])

  // Branches checked out in another worktree cannot be checked out again; fork from them instead.
  const available = branches.filter((branch) => !inUse.includes(branch))

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await api.newWorktree(project.id, {
        name: effectiveName,   // empty means "name it after the branch", which the server does too
        branch: mode === 'new' ? newBranch.trim() : existing,
        base: mode === 'new' && base ? base : undefined,
        checkoutExisting: mode === 'existing',
        group,
        moveCurrentWork: moveWork,
      })
      onCreated(created?.session?.id ?? null)
      // A stash that did not apply cleanly is the user's only copy of that work: say so.
      if (created?.warning) { setError(created.warning); setBusy(false); return }
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}
         role="dialog" aria-modal="true" aria-label="New worktree">
      <div className="w-[520px] rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl"
           onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-3 text-[14px] font-semibold">New worktree in {project.name}</h2>

        <label className="label">Name</label>
        <input className="field mb-3 mt-1" value={name}
               placeholder={effectiveName ? `${effectiveName} (from the branch)` : 'named after the branch'}
               onChange={(event) => setName(event.target.value)} />

        <div className="mb-3 flex gap-1">
          {(['new', 'existing'] as const).map((option) => (
            <button key={option}
                    className={`btn flex-1 ${mode === option ? 'bg-accent text-white' : 'bg-ink-800 text-ink-300'}`}
                    onClick={() => setMode(option)}>
              {option === 'new' ? 'New branch' : 'Existing branch'}
            </button>))}
        </div>

        {mode === 'new' ? (
          <>
            <label className="label">New branch</label>
            <input className="field mb-3 mt-1 font-mono" value={newBranch} placeholder="orch/my-work"
                   onChange={(event) => setNewBranch(event.target.value)} />
            <label className="label">Fork from</label>
            <div className="mb-3 mt-1">
              <BranchField branches={branches} value={base} onChange={setBase}
                           placeholder="Current HEAD" allowNone noneLabel="Current HEAD" />
            </div>
          </>
        ) : (
          <>
            <label className="label">Check out</label>
            <div className="mb-3 mt-1">
              <BranchField branches={available} value={existing} onChange={setExisting}
                           placeholder="Choose a branch…" />
            </div>
          </>)}

        <label className="label">Group directory</label>
        <select className="field mb-3 mt-1" value={group} onChange={(event) => setGroup(event.target.value)}>
          {[...new Set(['main', ...project.worktreeGroups])].map((entry) => (
            <option key={entry} value={entry}>{entry}</option>))}
        </select>

        <label className="mb-3 flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={moveWork}
                 onChange={(event) => setMoveWork(event.target.checked)} />
          <span>
            <span className="block">Move current uncommitted work into it</span>
            <span className="block text-[11px] text-ink-400">
              Stashes what is dirty in the main checkout and re-applies it here.
            </span>
          </span>
        </label>

        {error && <div className="mb-2 rounded-md border border-bad/40 bg-bad/10 px-2 py-1.5 text-red-200">{error}</div>}

        <div className="flex justify-end gap-2">
          <button className="btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => void create()}
                  disabled={busy || (mode === 'existing' && !existing) || (mode === 'new' && !newBranch.trim())}>
            {busy ? 'Creating…' : 'Create and open chat'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Colours and type, applied live. Kept in the browser: it is how this screen looks, not project state. */
function AppearanceSettings() {
  const [appearance, setAppearance] = useStoredValue<Appearance>('orchestrator.appearance', DEFAULT_APPEARANCE)
  const set = (patch: Partial<Appearance>) => setAppearance({ ...DEFAULT_APPEARANCE, ...appearance, ...patch })
  // Each useStoredValue is its own useState, so the copy App holds does not hear about this one:
  // paint the palette from here as well, or nothing would change until the next reload.
  useEffect(() => {
    applyAppearance({ ...DEFAULT_APPEARANCE, ...appearance }, document.documentElement)
  }, [appearance])
  const current = THEMES[appearance.theme] ?? THEMES.warm
  const swatch = (value: string, fallbackChannels: string) =>
    value || `#${fallbackChannels.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`

  return (
    <div className="mb-3">
      <label className="label">Colour scheme</label>
      <div className="mt-1 flex gap-1.5" role="group" aria-label="Colour scheme">
        {(Object.keys(THEMES) as Array<keyof typeof THEMES>).map((name) => (
          <button key={name} aria-pressed={appearance.theme === name}
                  className={`chip-button ${appearance.theme === name ? 'bg-ink-700 text-ink-100' : ''}`}
                  onClick={() => set({ theme: name })}>{THEMES[name].label}</button>))}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        {([['accent', 'Accent', current.accent], ['border', 'Borders', current.ink['800']],
           ['background', 'Background', current.ink['950']]] as const).map(([key, label, channels]) => (
          <label key={key} className="block">
            <span className="label">{label}</span>
            <div className="mt-1 flex items-center gap-1.5">
              <input type="color" aria-label={label} className="h-7 w-9 rounded border border-ink-700 bg-ink-850"
                     value={swatch(appearance[key], channels)}
                     onChange={(event) => set({ [key]: event.target.value } as Partial<Appearance>)} />
              {appearance[key] && (
                <button className="btn-quiet text-[11px]" onClick={() => set({ [key]: '' })}>Reset</button>)}
            </div>
          </label>))}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Font</span>
          <select className="field mt-1" aria-label="Font" value={appearance.font}
                  onChange={(event) => set({ font: event.target.value as Appearance['font'] })}>
            {(Object.keys(FONTS) as Array<keyof typeof FONTS>).map((name) => (
              <option key={name} value={name}>{FONTS[name].label}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="label">Text size — {appearance.fontSize}px</span>
          <input className="mt-2 w-full" type="range" min={11} max={17} aria-label="Text size"
                 value={appearance.fontSize}
                 onChange={(event) => set({ fontSize: Number(event.target.value) })} />
        </label>
      </div>
      <p className="mt-1 text-[11px] text-ink-400">
        Applies as you change it, and stays in this browser. The editor keeps its own monospace face.
      </p>
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  const [settings, setSettings] = useState<any>(null)
  // Every keystroke used to rewrite state.json and broadcast to every client.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { void api.settings().then(setSettings).catch(quiet) }, [])
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current) }, [])
  if (!settings) return null

  const save = (patch: Record<string, unknown>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => void api.saveSettings(next).catch(quiet), 400)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}
         role="dialog" aria-modal="true" aria-label="Settings">
      <div className="max-h-[90vh] w-[640px] overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl"
           onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-3 text-[14px] font-semibold">Settings</h2>

        <AppearanceSettings />

        <label className="label">Worktree root</label>
        <input
          className="field mb-1 mt-1 font-mono"
          placeholder="~/.orchestrator/worktrees"
          value={settings.worktreeRoot ?? ''}
          onChange={(event) => save({ worktreeRoot: event.target.value || null })}
        />
        <p className="mb-3 text-[11px] text-ink-400">
          Worktrees are never deleted automatically. Group directories are only created when you
          add one.
        </p>

        <label className="label">Linear workspace</label>
        <input
          className="field mb-1 mt-1 font-mono"
          placeholder="acme-co  (linear.app/acme-co/…)"
          aria-label="Linear workspace"
          value={settings.linearWorkspace ?? ''}
          onChange={(event) => save({ linearWorkspace: event.target.value.trim() || null })}
        />
        <p className="mb-3 text-[11px] text-ink-400">
          Turns ticket keys in PR titles and branches into Linear links. Learned automatically from
          the first PR whose description links to Linear.
        </p>

        <div className="label mb-1">Codex pricing (per 1M tokens)</div>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {(['input', 'cached', 'output'] as const).map((key) => (
            <label key={key} className="text-[11px] text-ink-400">
              {key}
              <input
                className="field mt-1"
                type="number" step="0.001"
                value={settings.codexPricing[key]}
                onChange={(event) => save({
                  codexPricing: { ...settings.codexPricing, [key]: Number(event.target.value) },
                })}
              />
            </label>))}
        </div>
        <p className="mb-3 text-[11px] text-ink-400">
          Claude reports its own cost per session; these rates only price Codex usage.
        </p>

        <div className="label mb-1">Claude pricing (per 1M tokens) — for the Usage page figures</div>
        <div className="mb-1 grid grid-cols-5 gap-2 text-[11px] text-ink-400">
          <span>model</span><span>input</span><span>cache read</span><span>cache write</span><span>output</span>
        </div>
        {Object.entries(settings.claudePricing ?? {}).map(([model, rates]: [string, any]) => (
          <div key={model} className="mb-1 grid grid-cols-5 gap-2">
            <span className="self-center text-[12px]">{model}</span>
            {(['input', 'cacheRead', 'cacheWrite', 'output'] as const).map((key) => (
              <input key={key} className="field py-1 text-[12px]" type="number" step="0.01"
                     value={rates[key]}
                     onChange={(event) => save({
                       claudePricing: { ...settings.claudePricing, [model]: { ...rates, [key]: Number(event.target.value) } },
                     })} />))}
          </div>))}
        <p className="mb-3 mt-1 text-[11px] text-ink-400">Fable has no published rate; it starts at Opus pricing.</p>

        <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
