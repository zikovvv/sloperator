import { useCallback, useState } from 'react'

const read = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* private mode */ } }

/** A number that survives reloads: a panel width, kept within bounds. */
export function useStoredNumber(key: string, initial: number, min: number, max: number) {
  const clamp = (value: number) => Math.min(max, Math.max(min, value))
  const [value, setValue] = useState(() => {
    const stored = Number(read(key))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : initial
  })
  const set = useCallback((next: number) => {
    const bounded = clamp(next)
    setValue(bounded)
    write(key, String(bounded))
  }, [key, min, max])
  return [value, set] as const
}

/** A yes/no that survives reloads: whether a panel is collapsed. Sets like React's own setter. */
export function useStoredFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => { const stored = read(key); return stored === null ? initial : stored === '1' })
  const set = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      write(key, resolved ? '1' : '0')
      return resolved
    })
  }, [key])
  return [value, set] as const
}

/**
 * Starts a horizontal drag from a mouse-down on a divider; `apply` receives the width the
 * panel should have for the pointer's current position. `sign` is +1 when the panel grows as
 * the pointer moves right (a left panel), −1 for a right panel.
 */
export function startDrag(event: { clientX: number; clientY?: number; preventDefault(): void },
                          width: number, sign: 1 | -1, apply: (width: number) => void,
                          axis: 'x' | 'y' = 'x') {
  event.preventDefault()
  const along = (point: { clientX: number; clientY?: number }) => (axis === 'x' ? point.clientX : point.clientY ?? 0)
  const origin = along(event)
  const move = (moving: MouseEvent) => apply(width + sign * (along(moving) - origin))
  const stop = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', stop)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', stop)
}

/** Anything JSON-shaped that should be where it was after a reload: a tab, a selection, a scope. */
export function useStoredValue<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStored(key, initial))
  const set = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next
      writeStored(key, resolved)
      return resolved
    })
  }, [key])
  return [value, set] as const
}

/** Reads a stored value once, for state that is not owned by a component. */
export function readStored<T>(key: string, initial: T): T {
  const stored = read(key)
  if (stored === null) return initial
  try { return JSON.parse(stored) as T } catch { return initial }
}

export function writeStored<T>(key: string, value: T) { write(key, JSON.stringify(value)) }
