import { useEffect, useState } from 'react'
import type { Toast } from '../lib/toast.ts'

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    const onToast = (event: Event) => {
      const next = (event as CustomEvent<Toast>).detail
      setToasts((current) => [...current, next])
      setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== next.id)), 8000)
    }
    window.addEventListener('orchestrator:toast', onToast)
    return () => window.removeEventListener('orchestrator:toast', onToast)
  }, [])
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id}
             className={`pointer-events-auto rounded-lg border px-3 py-2 text-[12px] shadow-xl ${
               entry.tone === 'error' ? 'border-bad/40 bg-[#2a1416] text-red-100' : 'border-ink-700 bg-ink-850 text-ink-100'}`}>
          <div className="flex items-start gap-2">
            <span className="flex-1 whitespace-pre-wrap break-words">{entry.text}</span>
            <button className="text-ink-400 hover:text-white" aria-label="Dismiss"
                    onClick={() => setToasts((current) => current.filter((item) => item.id !== entry.id))}>×</button>
          </div>
        </div>))}
    </div>
  )
}
