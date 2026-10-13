/** "Resets in 4 hr 22 min" for the rolling window. */
export function resetsIn(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return ''
  const remaining = Math.max(0, Date.parse(resetsAt) - now)
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  if (hours === 0) return `Resets in ${minutes} min`
  return `Resets in ${hours} hr ${minutes} min`
}

/** "Resets Fri 1:00 AM" for the weekly window. */
export function resetsOn(resetsAt: string | null): string {
  if (!resetsAt) return ''
  // The API stamps 20:59:59.999; the Claude app shows 1:00 AM, so round to the minute.
  const date = new Date(Math.round(Date.parse(resetsAt) / 60_000) * 60_000)
  const day = date.toLocaleDateString([], { weekday: 'short' })
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `Resets ${day} ${time}`
}
