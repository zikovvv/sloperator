import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'orch-vitest-run-'
const STALE_MS = 24 * 60 * 60 * 1000

/**
 * One folder for everything a test run puts under the temp directory: tests, the server under
 * test and every process they start all read TMPDIR. It is removed when the run ends; a run that
 * was killed leaves its folder, which a later run removes once it is a day old.
 */
export default function setup() {
  const system = tmpdir()
  for (const name of readdirSync(system)) {
    if (!name.startsWith(PREFIX)) continue
    const path = join(system, name)
    try { if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true }) } catch { /* gone already */ }
  }
  const run = mkdtempSync(join(system, PREFIX))
  process.env.TMPDIR = run
  return () => rmSync(run, { recursive: true, force: true })
}
