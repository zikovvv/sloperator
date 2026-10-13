/** "4h", "3d", "2mo" — how long ago an ISO timestamp was, in the shortest honest unit. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const seconds = Math.max(0, now - then) / 1000
  const minutes = seconds / 60
  const hours = minutes / 60
  const days = hours / 24
  if (minutes < 1) return 'now'
  if (hours < 1) return `${Math.floor(minutes)}m`
  if (days < 1) return `${Math.floor(hours)}h`
  if (days < 7) return `${Math.floor(days)}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30.44)}mo`
  return `${Math.floor(days / 365.25)}y`
}

/** "just now", "4h ago", or "—" — for sentences. */
export function agoText(iso: string | null | undefined, now?: number): string {
  const value = ago(iso, now)
  return value === '—' ? '—' : value === 'now' ? 'just now' : `${value} ago`
}
