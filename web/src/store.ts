import { useEffect, useRef, useState } from 'react'
import { showNotice } from './lib/notice.ts'
import type { Project, ServerEvent, Session, TranscriptItem, Worktree } from '../shared/types.ts'

export interface Store {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  running: Set<string>
  /** Sessions with a permission request or a question waiting for the person. */
  asking: Set<string>
  transcripts: Record<string, TranscriptItem[]>
  connected: boolean
}

/** One socket for the whole app; the server is the source of truth. */
export function useStore() {
  const [store, setStore] = useState<Store>({
    projects: [], worktrees: [], sessions: [], running: new Set(), asking: new Set(), transcripts: {}, connected: false,
  })
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let socket: WebSocket

    const connect = () => {
      socket = new WebSocket(`ws://${location.host}/ws`)
      socketRef.current = socket
      socket.onopen = () => setStore((prev) => ({ ...prev, connected: true }))
      socket.onclose = () => {
        setStore((prev) => ({ ...prev, connected: false }))
        if (!closed) setTimeout(connect, 1000)
      }
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as ServerEvent
        setStore((prev) => {
          switch (event.type) {
            case 'state':
              return { ...prev, projects: event.projects, worktrees: event.worktrees, sessions: event.sessions }
            case 'running':
              return { ...prev, running: new Set(event.sessionIDs), asking: new Set(event.asking ?? []) }
            case 'permission': {
              const existing = prev.transcripts[event.sessionID] ?? []
              return {
                ...prev,
                transcripts: {
                  ...prev.transcripts,
                  [event.sessionID]: existing.map((item) =>
                    item.id === event.itemID ? { ...item, permission: event.permission } : item),
                },
              }
            }
            case 'session':
              return {
                ...prev,
                sessions: prev.sessions.map((s) => (s.id === event.session.id ? event.session : s)),
              }
            case 'transcript':
              return { ...prev, transcripts: { ...prev.transcripts, [event.sessionID]: event.items } }
            case 'notify': {
              showNotice(event.notice)
              return prev
            }
            case 'append': {
              const existing = prev.transcripts[event.sessionID] ?? []
              return {
                ...prev,
                transcripts: { ...prev.transcripts, [event.sessionID]: [...existing, event.item] },
              }
            }
            case 'patch': {
              const existing = prev.transcripts[event.sessionID] ?? []
              return {
                ...prev,
                transcripts: {
                  ...prev.transcripts,
                  [event.sessionID]: existing.map((item) =>
                    item.id === event.itemID ? { ...item, toolOutput: event.toolOutput } : item),
                },
              }
            }
            default:
              return prev
          }
        })
      }
    }
    connect()
    return () => { closed = true; socket?.close() }
  }, [])

  return store
}

export async function loadTranscript(sessionID: string): Promise<TranscriptItem[]> {
  const response = await fetch(`/api/transcript/${sessionID}`)
  return response.json()
}

export async function sendMessage(sessionID: string, text: string) {
  await fetch(`/api/session/${sessionID}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export async function stopSession(sessionID: string) {
  await fetch(`/api/session/${sessionID}/stop`, { method: 'POST' })
}

export async function patchSession(sessionID: string, patch: Partial<Session>) {
  await fetch(`/api/session/${sessionID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function createSession(worktreeID: string) {
  await fetch(`/api/worktree/${worktreeID}/session`, { method: 'POST' })
}
