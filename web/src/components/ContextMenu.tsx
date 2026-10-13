import { useEffect, useRef } from 'react'

export interface MenuItem { label: string; run: () => void }

/** A small menu at the pointer for right-clicks; it closes on Escape, on a click elsewhere, or on a pick. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key) }
  }, [onClose])
  // Stays on screen when the click was near the right or bottom edge.
  const left = Math.max(0, Math.min(x, window.innerWidth - 200))
  const top = Math.max(0, Math.min(y, window.innerHeight - 34 * items.length - 12))
  return (
    <div ref={ref} role="menu" className="fixed z-50 min-w-[180px] rounded-md border border-ink-700 bg-ink-850 py-1 shadow-xl" style={{ left, top }}>
      {items.map((item) => (
        <button key={item.label} role="menuitem"
                className="block w-full px-3 py-1.5 text-left text-[12px] text-ink-100 hover:bg-ink-800"
                onClick={() => { item.run(); onClose() }}>{item.label}</button>))}
    </div>
  )
}
