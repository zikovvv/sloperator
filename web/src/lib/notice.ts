import type { Notice } from '../../shared/types.ts'

/**
 * In the packaged app the Electron shell already raised a native notification with sound, so
 * this only fills in for the dev browser. Permission is asked for once, on the first notice.
 */
let asked = false

export function showNotice(notice: Notice) {
  window.dispatchEvent(new CustomEvent<Notice>('orchestrator:notice', { detail: notice }))
  if (isElectron() || !('Notification' in window)) return

  const raise = () => {
    if (Notification.permission !== 'granted') return
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.sessionID })
    shown.onclick = () => {
      window.focus()
      window.dispatchEvent(new CustomEvent<Notice>('orchestrator:open', { detail: notice }))
    }
  }

  if (Notification.permission === 'granted') return raise()
  if (Notification.permission === 'denied' || asked) return
  asked = true
  void Notification.requestPermission().then(raise)
}

function isElectron(): boolean {
  return navigator.userAgent.includes('Electron')
}
