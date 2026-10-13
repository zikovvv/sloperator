import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

/** fzf-style: "fbz" finds "feature/bar-baz". Substrings win, then word starts. */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (!query) return 0
  const haystack = candidate.toLowerCase()
  const needle = query.toLowerCase()
  const direct = haystack.indexOf(needle)
  if (direct >= 0) return 1000 - direct - Math.floor(candidate.length / 4)

  let score = 0
  let index = 0
  let previous = -2
  for (const character of needle) {
    const found = haystack.indexOf(character, index)
    if (found < 0) return null
    if (found === previous + 1) score += 8
    if (found === 0) score += 12
    else if ('/-_. '.includes(haystack[found - 1])) score += 10
    previous = found
    index = found + 1
  }
  return score - Math.floor(candidate.length / 8)
}

export function rank<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query) return items
  return items
    .map((item) => ({ item, score: fuzzyScore(key(item), query) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  const matches = useMemo(
    () => rank(commands, query, (command) => `${command.group} ${command.label}`).slice(0, 60),
    [commands, query])
  useEffect(() => { setIndex(0) }, [query])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
         onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="w-[560px] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
           onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full border-b border-ink-800 bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-ink-500"
          placeholder="Jump to a session, switch model, start a worktree…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, matches.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            if (event.key === 'Enter' && matches[index]) { matches[index].run(); onClose() }
          }}
        />
        <div className="max-h-80 overflow-y-auto p-1">
          {!matches.length && <div className="px-3 py-4 text-ink-500">Nothing matches “{query}”.</div>}
          {matches.map((command, position) => (
            <button
              key={command.id}
              className={`row ${position === index ? 'row-active' : 'row-idle'}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => { command.run(); onClose() }}
            >
              <span className="w-24 shrink-0 truncate text-[10px] uppercase tracking-wide text-ink-500">
                {command.group}
              </span>
              <span className="flex-1 truncate">{command.label}</span>
              {command.hint && <span className="font-mono text-[10px] text-ink-500">{command.hint}</span>}
            </button>))}
        </div>
      </div>
    </div>
  )
}
