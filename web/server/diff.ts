export type { DiffFile, DiffHunk, DiffLine, DiffLineKind } from '../shared/types.ts'
import type { DiffFile, DiffHunk } from '../shared/types.ts'
/** Unified-diff parsing. Ported from the Swift version with every fix its tests pin. */
function hunkStarts(header: string): [number, number] {
  let oldStart = 1
  let newStart = 1
  for (const part of header.split(' ')) {
    if (part.startsWith('-')) oldStart = parseInt(part.slice(1).split(',')[0], 10) || 1
    else if (part.startsWith('+')) newStart = parseInt(part.slice(1).split(',')[0], 10) || 1
  }
  return [oldStart, newStart]
}

/** git appends a TAB after a name containing spaces, and quotes unusual paths. */
function headerPath(value: string): string {
  let path = value.replace(/[\t ]+$/, '')
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    // C-quoted: octal escapes are UTF-8 bytes, so collect them before decoding.
    const bytes: number[] = []
    const inner = path.slice(1, -1)
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index]
      if (char !== '\\') { bytes.push(...Buffer.from(char, 'utf8')); continue }
      const next = inner[index + 1]
      if (/[0-7]/.test(next ?? '')) {
        bytes.push(parseInt(inner.slice(index + 1, index + 4), 8)); index += 3
      } else {
        bytes.push(...Buffer.from({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[next ?? ''] ?? next ?? '', 'utf8'))
        index += 1
      }
    }
    path = Buffer.from(bytes).toString('utf8')
  }
  return path
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let lineID = 0
  let hunkID = 0
  let oldNumber = 0
  let newNumber = 0

  const closeHunk = () => {
    if (hunk && current) current.hunks.push(hunk)
    hunk = null
  }
  const closeFile = () => {
    closeHunk()
    if (current) files.push(current)
    current = null
  }

  const lines = text.split('\n')
  // Real git output ends with a newline; the trailing "" would become a phantom context line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  for (const raw of lines) {
    // Windows checkouts diff with CRLF; the \r is not part of the code.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line.startsWith('diff --git ')) {
      closeFile()
      const body = line.slice('diff --git '.length)
      const marker = body.lastIndexOf(' b/')
      current = {
        path: marker >= 0 ? body.slice(marker + 3) : line,
        status: 'M', added: 0, removed: 0, isBinary: false, hunks: [],
      }
      continue
    }
    if (!current) continue

    // File-level headers only exist BEFORE the first hunk. Inside one, "--- " and "++ " are
    // ordinary deleted/added lines (SQL, Lua, Haskell comments).
    if (!hunk) {
      if (line.startsWith('new file')) { current.status = 'A'; continue }
      if (line.startsWith('deleted file')) { current.status = 'D'; continue }
      if (line.startsWith('rename from ')) {
        current.oldPath = line.slice('rename from '.length); current.status = 'R'; continue
      }
      if (line.startsWith('rename to ')) {
        current.path = line.slice('rename to '.length); current.status = 'R'; continue
      }
      if (line.startsWith('Binary files')) { current.isBinary = true; continue }
      if (line.startsWith('+++ ')) {
        const value = headerPath(line.slice(4))
        if (value !== '/dev/null') current.path = value.startsWith('b/') ? value.slice(2) : value
        continue
      }
      if (line.startsWith('--- ')) {
        const value = headerPath(line.slice(4))
        if (value === '/dev/null') current.status = 'A'
        else if (current.path.startsWith('diff --git')) {
          current.path = value.startsWith('a/') ? value.slice(2) : value
        }
        continue
      }
      if (/^(index |similarity |dissimilarity |copy from |copy to |old mode|new mode)/.test(line)) {
        continue
      }
    }

    if (line.startsWith('@@')) {
      closeHunk()
      hunkID += 1
      lineID += 1
      const [oldStart, newStart] = hunkStarts(line)
      oldNumber = oldStart
      newNumber = newStart
      hunk = {
        id: hunkID,
        header: line,
        lines: [{ id: lineID, kind: 'hunkHeader', text: line, oldLine: null, newLine: null }],
      }
      continue
    }

    if (!hunk) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    lineID += 1
    if (line.startsWith('+')) {
      hunk.lines.push({ id: lineID, kind: 'addition', text: line.slice(1), oldLine: null, newLine: newNumber })
      newNumber += 1
      current.added += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ id: lineID, kind: 'deletion', text: line.slice(1), oldLine: oldNumber, newLine: null })
      oldNumber += 1
      current.removed += 1
    } else {
      hunk.lines.push({
        id: lineID, kind: 'context', text: line.length ? line.slice(1) : '',
        oldLine: oldNumber, newLine: newNumber,
      })
      oldNumber += 1
      newNumber += 1
    }
  }
  closeFile()
  return files
}
