/**
 * In-app notices. window.alert is auto-dismissed by headless browsers and blocks the whole
 * window in Electron, so an error reported that way could be swallowed or freeze the app.
 */
export interface Toast { id: string; text: string; tone: 'error' | 'info' }

export function toast(text: string, tone: Toast['tone'] = 'error') {
  window.dispatchEvent(new CustomEvent<Toast>('orchestrator:toast', {
    detail: { id: crypto.randomUUID(), text, tone },
  }))
}

export function reportError(error: unknown) {
  toast((error as Error)?.message || 'That did not work.')
}
