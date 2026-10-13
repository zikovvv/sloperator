/** "12s", "3m 4s", "1h 2m": how long since a moment. */
export function elapsed(since: number, now: number): string {
  return duration(Math.max(0, Math.floor((now - since) / 1000)))
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
