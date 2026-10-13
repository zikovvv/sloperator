import type { DiffFile } from '../../shared/types.ts'

/**
 * Rebuilds both sides of a file from its hunks so Monaco can diff them, and remembers which real
 * file line each rendered row came from. Monaco numbers this compact buffer from 1, so without
 * the mapping every quote and comment names a line hundreds of rows from the one clicked.
 */
/** Characters for a gutter that fits the largest line number, plus one so it never touches the +/- sign. */
export function gutterChars(lines: Array<number | null>): number {
  return String(lines.reduce<number>((largest, line) => Math.max(largest, line ?? 0), 0)).length + 1
}

export function sidesOf(file: DiffFile): {
  before: string; after: string; realLine: Array<number | null>; originalLine: Array<number | null>
} {
  const before: string[] = []
  const after: string[] = []
  const realLine: Array<number | null> = []
  const originalLine: Array<number | null> = []
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'hunkHeader') continue
      if (line.kind !== 'addition') {
        before.push(line.text)
        originalLine.push(line.oldLine ?? line.newLine)
      }
      if (line.kind !== 'deletion') {
        after.push(line.text)
        realLine.push(line.newLine ?? line.oldLine)
      }
    }
  }
  return { before: before.join('\n'), after: after.join('\n'), realLine, originalLine }
}
