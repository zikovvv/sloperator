import { describe, expect, it } from 'vitest'
import { parseDiff } from '../server/diff.ts'
import { sidesOf } from '../src/lib/diffSides.ts'

/** A diff whose first hunk starts at line 200 — the case that made every quote wrong. */
const diff = [
  'diff --git a/app.py b/app.py',
  '--- a/app.py',
  '+++ b/app.py',
  '@@ -200,4 +200,5 @@',
  ' context one',
  '-removed line',
  '+added line',
  '+second added',
  ' context two',
  '@@ -400,2 +401,2 @@',
  ' far context',
  '+far addition',
].join('\n')

describe('sidesOf line mapping', () => {
  it('maps each rendered row back to the real file line, across hunks', () => {
    const [file] = parseDiff(diff)
    const { after, realLine } = sidesOf(file as never)
    const rows = after.split('\n')
    expect(rows[0]).toBe('context one')
    expect(realLine[0]).toBe(200)          // not 1
    expect(rows[1]).toBe('added line')
    expect(realLine[1]).toBe(201)
    expect(rows[3]).toBe('context two')
    expect(realLine[3]).toBe(203)
    // Second hunk: the rendered buffer is contiguous, the file is not.
    expect(rows[4]).toBe('far context')
    expect(realLine[4]).toBe(401)
    expect(realLine[5]).toBe(402)
  })

  it('never reports a rendered row number as a file line', () => {
    const [file] = parseDiff(diff)
    const { realLine } = sidesOf(file as never)
    expect(realLine.every((line, index) => line !== index + 1)).toBe(true)
  })

  it('falls back to the old line for a deleted-only file so a quote still points somewhere', () => {
    const [file] = parseDiff([
      'diff --git a/gone.py b/gone.py', 'deleted file mode 100644', '--- a/gone.py', '+++ /dev/null',
      '@@ -10,2 +0,0 @@', '-one', '-two',
    ].join('\n'))
    const { realLine } = sidesOf(file as never)
    expect(realLine).toEqual([])
  })
})

describe('each side of an uneven hunk', () => {
  it('numbers its own rows: the old file by old lines, the new file by new lines', async () => {
    const { sidesOf } = await import('../src/lib/diffSides.ts')
    const line = (kind: string, oldLine: number | null, newLine: number | null) => ({ id: 0, kind, text: kind, oldLine, newLine })
    const { originalLine, realLine } = sidesOf({ path: 'x', status: 'M', added: 1, removed: 2, isBinary: false, hunks: [{ id: 1, header: '', lines: [
      line('hunkHeader', null, null), line('context', 40, 40), line('deletion', 41, null), line('deletion', 42, null), line('addition', null, 41), line('context', 43, 42),
    ] }] } as never)
    expect(originalLine).toEqual([40, 41, 42, 43])
    expect(realLine).toEqual([40, 41, 42])
  })
})
