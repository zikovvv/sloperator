import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const get = (path: string) => h.get(`/api/file/raw?path=${encodeURIComponent(path)}`)

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  mkdirSync(join(h.repo, 'out'), { recursive: true })
  writeFileSync(join(h.repo, 'out', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(h.repo, 'out', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
  writeFileSync(join(h.repo, 'out', 'page.html'), '<script>fetch("/api/state")</script>')
  writeFileSync(join(h.repo, 'out', 'config.js'), 'window.x = 1')
  writeFileSync(join(h.repo, '.env'), 'SECRET=1')
  symlinkSync('/etc/passwd', join(h.repo, 'out', 'escape'))
})
afterAll(async () => { await h.stop() })

describe('raw files for the chat', () => {
  it('serves images as images, with the type pinned and svg scripts disarmed', async () => {
    const png = await get(join(h.repo, 'out', 'shot.png'))
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await png.arrayBuffer())[0]).toBe(0x89)
    const svg = await get(join(h.repo, 'out', 'chart.svg'))
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toBe("default-src 'none'")
  })

  it('hands anything that could run on this origin over as a download instead', async () => {
    for (const name of ['page.html', 'config.js']) {
      const response = await get(join(h.repo, 'out', name))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
    const dotfile = await get(join(h.repo, '.env'))
    expect(dotfile.status).toBe(200)
    expect(dotfile.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('names a download after the file even when the name holds a newline or a quote', async () => {
    writeFileSync(join(h.repo, 'out', 'a\nb".txt'), 'x')
    const response = await get(join(h.repo, 'out', 'a\nb".txt'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="ab.txt"')
  })

  it('answers every refusal as JSON: outside the roots, a symlink out, a folder, a missing file', async () => {
    expect((await get('/etc/passwd')).status).toBe(403)
    expect((await get(join(h.repo, 'out', 'escape'))).status).toBe(403)
    const folder = await get(join(h.repo, 'out'))
    expect(folder.status).toBe(404)
    expect(await folder.json()).toEqual({ error: 'not found' })
    const missing = await get(join(h.repo, 'out', 'nope.png'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
  })
})

describe('the project tree', () => {
  it('lists tracked and untracked files with the diff numbers of the changed ones, per scope', async () => {
    writeFileSync(join(h.repo, 'README.md'), '# probe\n\nchanged\n')
    writeFileSync(join(h.repo, 'fresh.txt'), 'new\n')
    const tree = await (await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=uncommitted`)).json()
    const byPath = Object.fromEntries(tree.files.map((file: any) => [file.path, file]))
    expect(byPath['README.md']).toMatchObject({ status: 'M', added: 2 })
    expect(byPath['fresh.txt']).toMatchObject({ status: 'A', added: 1 })
    expect(byPath['tests/test_a.py']).toMatchObject({ status: null, added: 0, removed: 0 })
    const staged = await (await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=staged`)).json()
    expect(staged.files.every((file: any) => file.status === null)).toBe(true)
  })

  it('refuses a scope it does not know, a commit without a sha, and paths outside the roots', async () => {
    const bad = await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=nonsense`)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Unknown scope: nonsense' })
    expect((await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=commit`)).status).toBe(400)
    expect((await h.get('/api/tree?path=/etc&scope=uncommitted')).status).toBe(403)
    expect((await h.get(`/api/tree?path=${encodeURIComponent(join(h.repo, 'missing'))}&scope=uncommitted`)).status).toBe(404)
    const failing = await h.get(`/api/tree?path=${encodeURIComponent(h.repo)}&scope=commit&sha=deadbeef`)
    expect(failing.status).toBe(200)   // git answers an empty diff for an unknown sha; the listing still comes
  })

  it('takes a sha and nothing else for a commit: a git option in its place is refused by the tree and the diff alike', async () => {
    const target = join(h.stateDir, 'pwned.txt')
    for (const route of ['/api/tree', '/api/diff']) {
      const response = await h.get(`${route}?path=${encodeURIComponent(h.repo)}&scope=commit&sha=${encodeURIComponent(`--output=${target}`)}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'sha must be a commit hash' })
    }
    expect(existsSync(target)).toBe(false)
    const head = execFileSync('git', ['-C', h.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const shown = await (await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=commit&sha=${head.slice(0, 7)}`)).json()
    expect(shown.files.map((file: any) => file.path)).toContain('README.md')
  })
})
