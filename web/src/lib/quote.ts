/**
 * Quotes for the composer: something said or seen, as a blockquote with its source on the first
 * line, so the agent can tell what is being pointed at from what is being asked.
 */
const LINE_LIMIT = 80

export function formatQuote(label: string, text: string, limit = LINE_LIMIT): string {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  // Runs of blank lines fold into one: the quote is a pointer, not a reprint.
  const compact = lines.filter((line, index) => line || lines[index - 1])
  const kept = compact.slice(0, limit)
  if (compact.length > limit) kept.push(`… ${compact.length - limit} more lines`)
  return [`> [${label}]`, ...kept.map((line) => (line ? `> ${line}` : '>'))].join('\n')
}

/** The quote goes after what is already written, with a blank line between, and a newline to type on. */
export function appendQuote(draft: string, quote: string): string {
  const before = draft.replace(/\s+$/, '')
  return before ? `${before}\n\n${quote}\n` : `${quote}\n`
}

/** Asks the open chat to put this into its composer. */
export function compose(text: string) {
  window.dispatchEvent(new CustomEvent('orchestrator:compose', { detail: { text } }))
}

/** Monaco's line change: a range on each side, where 0 as the end means that side has no lines. */
export interface LineChange {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

/**
 * Lines `from`–`to` of the new side of a diff as one hunk, the way the inline view shows them: the
 * old lines a change replaced above its new ones, the lines deleted after a selected line below
 * it, `-` and `+` in the margin, two spaces for what did not change.
 */
export function hunkLines(
  from: number, to: number, changes: LineChange[],
  modified: (line: number) => string, original: (line: number) => string,
): string[] {
  const out: string[] = []
  const removedAt = (anchor: number, pureDeletion: boolean) => {
    for (const change of changes) {
      if (change.originalEndLineNumber === 0) continue   // nothing was removed by a pure insertion
      if ((change.modifiedEndLineNumber === 0) !== pureDeletion || change.modifiedStartLineNumber !== anchor) continue
      for (let line = change.originalStartLineNumber; line <= change.originalEndLineNumber; line += 1) out.push(`- ${original(line)}`)
    }
  }
  for (let line = from; line <= to; line += 1) {
    if (line > from) removedAt(line - 1, true)
    removedAt(line, false)
    const added = changes.some((change) =>
      change.modifiedEndLineNumber > 0 && line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber)
    out.push(`${added ? '+' : ' '} ${modified(line)}`)
  }
  removedAt(to, true)
  return out
}
