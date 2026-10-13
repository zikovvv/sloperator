import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, type TerminalInfo } from '../lib/api.ts'
import { quiet } from '../lib/quiet.ts'

/** Shells belong to the worktree, not the session; several can be open at once. */
export function TerminalDrawer({ worktreeID, worktreeName, onClose, signIn }: {
  worktreeID: string
  worktreeName: string
  onClose: () => void
  /** A request to sign an engine in again: a new terminal running its login, brought to the front. */
  signIn?: { engine: 'claude' | 'codex'; nonce: number } | null
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeID, setActiveID] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => api.terminals(worktreeID).then((result) => {
    setTerminals(result.terminals)
    setActiveID((current) => current && result.terminals.some((t) => t.id === current)
      ? current : result.terminals[0]?.id ?? null)
    return result.terminals
  })

  useEffect(() => {
    // A worktree with no shell yet gets one: the drawer is for typing, not for clicking first.
    void refresh().then((existing) => {
      if (!existing.length) void api.openTerminal(worktreeID, { ifNone: true }).then(() => refresh()).catch((e) => setError(e.message))
    }).catch((e) => setError(e.message))
  }, [worktreeID])

  useEffect(() => {
    const gone = () => void refresh().catch(quiet)
    window.addEventListener('orchestrator:terminal-gone', gone)
    return () => window.removeEventListener('orchestrator:terminal-gone', gone)
  }, [worktreeID])

  // One terminal per request: an effect that runs twice (React's dev mode does) must not open two.
  const signedIn = useRef<number | null>(null)
  useEffect(() => {
    if (!signIn || signedIn.current === signIn.nonce) return
    signedIn.current = signIn.nonce
    void api.openTerminal(worktreeID, { login: signIn.engine })
      .then((created) => refresh().then(() => setActiveID(created.id)))
      .catch((e) => setError(e.message))
  }, [signIn?.nonce])

  const open = () => void api.openTerminal(worktreeID)
    .then((created) => refresh().then(() => setActiveID(created.id)))
    .catch((e) => setError(e.message))
  const close = (id: string) => void api.closeTerminal(id).then(() => refresh())

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-ink-800 bg-[#0b0d12]">
      <div className="flex items-center gap-1 border-b border-ink-800 px-2 py-1" role="tablist" aria-label="Terminals">
        <span className="mr-2 text-[11px] text-ink-500">{worktreeName}</span>
        {terminals.map((terminal) => (
          <button key={terminal.id} role="tab" aria-selected={terminal.id === activeID}
                  className={`chip-button ${terminal.id === activeID ? 'bg-ink-700 text-white' : ''}`}
                  onClick={() => setActiveID(terminal.id)}>
            {terminal.title}
            <span className="ml-2 text-ink-500 hover:text-bad" aria-label="Close terminal"
                  onClick={(event) => { event.stopPropagation(); close(terminal.id) }}>×</span>
          </button>))}
        <button className="icon-button" aria-label="New terminal" title="New terminal in this worktree" onClick={open}>+</button>
        <span className="ml-auto text-[10px] text-ink-500">⌘J hides</span>
        <button className="icon-button" aria-label="Hide terminal" onClick={onClose}>▾</button>
      </div>
      {error && <div className="px-3 py-1 text-[11px] text-red-200">{error}</div>}
      <div className="relative min-h-0 flex-1">
        {terminals.map((terminal) => (
          <div key={terminal.id} className="absolute inset-0" hidden={terminal.id !== activeID}>
            <XTerm id={terminal.id} visible={terminal.id === activeID} />
          </div>))}
      </div>
    </div>
  )
}

function XTerm({ id, visible }: { id: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const terminal = new Terminal({
      fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0b0d12', foreground: '#e6e9f0', cursor: '#5b8cff' },
      cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    })
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()

    const socket = new WebSocket(`${location.protocol.replace('http', 'ws')}//${location.host}/terminal?id=${encodeURIComponent(id)}`)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    socket.onmessage = (event) => terminal.write(typeof event.data === 'string' ? event.data : '')
    socket.onclose = (event) => {
      terminal.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n')
      // The shell is gone (server restarted): the tab must not linger.
      if (event.code === 4004) window.dispatchEvent(new CustomEvent('orchestrator:terminal-gone', { detail: id }))
    }
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    const resize = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(host)

    return () => { observer.disconnect(); input.dispose(); resize.dispose(); socket.close(); terminal.dispose() }
  }, [id])

  useEffect(() => { if (visible) setTimeout(() => fitRef.current?.fit(), 0) }, [visible])

  return <div ref={hostRef} className="h-full w-full px-1 py-1" />
}
