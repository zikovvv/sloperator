export interface Notice {
  title: string
  body: string
  /** macOS system sound name, e.g. Glass or Submarine. */
  sound?: string
  /** What to select when the notification is clicked. */
  sessionID?: string
  tab?: 'sessions' | 'github'
}

type Deliver = (notice: Notice) => void

/**
 * The Electron shell installs the real deliverer; in the dev browser there is none, so the
 * notice only goes out over the socket and the page raises it with the Web Notification API.
 */
function deliverer(): Deliver | null {
  const hook = (globalThis as Record<string, unknown>).orchestratorNotify
  return typeof hook === 'function' ? (hook as Deliver) : null
}

/** Sessions the user is currently looking at, so a finished turn they watched stays quiet. */
let attention: { sessionID: string | null; focused: boolean } = { sessionID: null, focused: false }

export function setAttention(sessionID: string | null, focused: boolean) {
  attention = { sessionID, focused }
}

export function isWatching(sessionID: string): boolean {
  return attention.focused && attention.sessionID === sessionID
}

export function notify(notice: Notice, broadcast: (notice: Notice) => void) {
  deliverer()?.(notice)
  broadcast(notice)
}
