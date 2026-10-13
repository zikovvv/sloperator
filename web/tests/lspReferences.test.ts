import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const json = async (response: Response) => response.json()

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  mkdirSync(join(h.repo, 'src'), { recursive: true })
  writeFileSync(join(h.repo, 'src', 'app.py'), 'def x():\n    return 1\n\nx()\n')
})
afterAll(async () => { await h.stop() })

describe('find usages', () => {
  it('lists every usage the language server knows, in this file and elsewhere, or none', async () => {
    const path = join(h.repo, 'src', 'app.py')
    const found = await json(await h.post('/api/lsp/references', { workspace: h.repo, path, line: 0, character: 4 }))
    expect(found.error).toBeNull()
    expect(found.locations).toEqual([
      { path, line: 3, character: 4 },
      { path: join(h.repo, 'src', 'other.py'), line: 10, character: 0 },
    ])
    const none = await json(await h.post('/api/lsp/references', { workspace: h.repo, path, line: 50, character: 0 }))
    expect(none.locations).toEqual([])
    const odd = await json(await h.post('/api/lsp/references', { workspace: h.repo, path, line: 52, character: 0 }))
    expect(odd.locations).toEqual([])
    const failed = await json(await h.post('/api/lsp/references', { workspace: h.repo, path, line: 51, character: 0 }))
    expect(failed).toEqual({ locations: [], error: 'references exploded' })
  })

  it('names a missing server for a supported file, and answers nothing for an unsupported one', async () => {
    const saved = process.env.ORCHESTRATOR_BIN_DIR
    process.env.ORCHESTRATOR_BIN_DIR = join(h.stateDir, 'no-bin')
    try {
      const { references, stopAllLanguageServers } = await import('../server/lsp.ts')
      stopAllLanguageServers()
      const missing = await references(h.repo, join(h.repo, 'src', 'app.py'), 0, 0)
      expect(missing).toEqual({ locations: [], error: 'pyright-langserver is not installed' })
      const unsupported = await references(h.repo, join(h.repo, 'README.md'), 0, 0)
      expect(unsupported).toEqual({ locations: [], error: null })
    } finally {
      process.env.ORCHESTRATOR_BIN_DIR = saved
    }
  })
})
