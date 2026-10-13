export type LogDensity = 'ubercompact' | 'compact' | 'normal' | 'verbose'
const KEY = 'orchestrator.logDensity'
const LEVELS: LogDensity[] = ['ubercompact', 'compact', 'normal', 'verbose']

export function loadDensity(): LogDensity {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'supercompact') return 'ubercompact'   // what this level used to be called
    return value && LEVELS.includes(value as LogDensity) ? (value as LogDensity) : 'compact'
  } catch { return 'compact' }
}

export function saveDensity(value: LogDensity) {
  try { localStorage.setItem(KEY, value) } catch { /* private mode */ }
}
