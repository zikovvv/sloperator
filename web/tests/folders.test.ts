import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browseHome, listFolders } from '../server/folders.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const root = mkdtempSync(join(tmpdir(), 'orch-browse-'))
beforeAll(async () => {
  mkdirSync(join(root, 'zeta')); mkdirSync(join(root, 'alpha', '.git'), { recursive: true }); mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'a-file.txt'), 'x')
  symlinkSync(join(root, 'zeta'), join(root, 'link-to-zeta')); symlinkSync(join(root, 'a-file.txt'), join(root, 'link-to-file'))
  symlinkSync(join(root, 'gone'), join(root, 'broken-link'))
  h = await startHarness()
})
afterAll(async () => { await h.stop() })

describe('browsing folders to add a project', () => {
  it('lists the folders inside one, by name, with git repositories marked; no files, nothing hidden, no broken links', () => {
    const listing = listFolders(root)
    expect(listing).toMatchObject({ path: root, parent: dirname(root), isGit: false })
    expect(listing.folders).toEqual([
      { name: 'alpha', path: join(root, 'alpha'), isGit: true },
      { name: 'link-to-zeta', path: join(root, 'link-to-zeta'), isGit: false },
      { name: 'zeta', path: join(root, 'zeta'), isGit: false },
    ])
    expect(listing.more).toBe(0)
    // A huge folder lists only its first few, and counts the rest.
    expect(listFolders(root, 2)).toMatchObject({ folders: [{ name: 'alpha' }, { name: 'link-to-zeta' }], more: 1 })
    expect(listFolders(join(root, 'alpha')).isGit).toBe(true)
    expect(listFolders('/').parent).toBeNull()
  })

  it('starts at home, which the tests point elsewhere', () => {
    expect(browseHome()).toBe(process.env.ORCHESTRATOR_BROWSE_HOME)
    const kept = process.env.ORCHESTRATOR_BROWSE_HOME
    delete process.env.ORCHESTRATOR_BROWSE_HOME
    try { expect(browseHome()).toBe(homedir()) } finally { process.env.ORCHESTRATOR_BROWSE_HOME = kept }
  })

  it('serves a listing, home by default, and says when a folder cannot be read', async () => {
    const named = await (await h.get(`/api/folders?path=${encodeURIComponent(root)}`)).json()
    expect(named.folders.map((folder: any) => folder.name)).toEqual(['alpha', 'link-to-zeta', 'zeta'])
    expect((await (await h.get('/api/folders')).json()).path).toBe(process.env.ORCHESTRATOR_BROWSE_HOME)
    const missing = await h.get(`/api/folders?path=${encodeURIComponent(join(root, 'nope'))}`)
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('That folder cannot be read')
    expect((await h.get(`/api/folders?path=${encodeURIComponent(join(root, 'a-file.txt'))}`)).status).toBe(400)
  })
})
