import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sides } from '../server/git.ts'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
const json = async (response: Response) => response.json()
const git = (...args: string[]) => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim()
const fileOf = async (file: string, query = 'scope=uncommitted', path = h.repo) =>
  h.get(`/api/diff/file?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&${query}`)
const body = async (file: string, query?: string, path?: string) => json(await fileOf(file, query, path))

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  // On feature/one: README changed, a file added; the working tree changes README again and stages src/new.py.
  git('checkout', '-q', 'feature/one')
  writeFileSync(join(h.repo, 'README.md'), '# probe\ncommitted on the branch\n')
  mkdirSync(join(h.repo, 'src'), { recursive: true }); writeFileSync(join(h.repo, 'src', 'added.py'), 'x = 1\n')
  git('add', '-A'); git('commit', '-qm', 'branch work')
  writeFileSync(join(h.repo, 'README.md'), '# probe\ncommitted on the branch\nand edited since\n')
  writeFileSync(join(h.repo, 'src', 'new.py'), 'y = 2\n'); git('add', 'src/new.py')
  git('branch', '-q', '--set-upstream-to=origin/feature/one')   // origin still has the branch at main's README
})
afterAll(async () => { await h.stop() })

describe('a file whole, on each side of a scope', () => {
  it('shows the committed and the working copy for uncommitted work, the index for staged work', async () => {
    expect(await body('README.md')).toEqual({ before: '# probe\ncommitted on the branch\n', after: '# probe\ncommitted on the branch\nand edited since\n' })
    expect(await body('src/new.py', 'scope=staged')).toEqual({ before: null, after: 'y = 2\n' })
    expect(await body('src/new.py')).toEqual({ before: null, after: 'y = 2\n' })   // untracked to the commit, on disk
  })

  it('measures a branch against its base, the whole file each side, absent where it does not exist', async () => {
    expect(await body('README.md', 'scope=branch&base=main')).toEqual({ before: '# probe\n', after: '# probe\ncommitted on the branch\nand edited since\n' })
    expect(await body('src/added.py', 'scope=branch&base=main')).toEqual({ before: null, after: 'x = 1\n' })
    expect(await body('README.md', 'scope=main')).toMatchObject({ before: '# probe\n' })
    expect(await body('README.md', 'scope=remote')).toMatchObject({ before: '# probe\n' })   // origin/feature/one is at main's README
  })

  it('shows one commit as its parent against itself, and a turn as its two snapshots', async () => {
    const sha = git('rev-parse', 'HEAD')
    expect(await body('README.md', `scope=commit&sha=${sha}`)).toEqual({ before: '# probe\n', after: '# probe\ncommitted on the branch\n' })
    expect(await body('src/added.py', `scope=commit&sha=${sha}`)).toEqual({ before: null, after: 'x = 1\n' })
    // The first commit has no parent: nothing on the before side.
    const root = git('rev-list', '--max-parents=0', 'HEAD')
    expect(await body('README.md', `scope=commit&sha=${root}`)).toEqual({ before: null, after: '# probe\n' })
    expect(await body('README.md', 'scope=turn')).toEqual({ before: null, after: null })   // no turn has finished
    const tree = git('write-tree')
    expect(await sides(h.repo, { kind: 'turn', before: tree, after: tree }, null, 'README.md'))
      .toEqual({ before: '# probe\ncommitted on the branch\n', after: '# probe\ncommitted on the branch\n' })
    await expect(sides(h.repo, { kind: 'nope' } as never, null, 'README.md')).rejects.toThrow(/Unknown diff scope/)
  })

  it('shows a plain folder against HEAD when no base is named, and a branch with no upstream against HEAD', async () => {
    // A path with no worktree record and no base: the file is read at HEAD, and is not on disk under that folder.
    expect(await body('README.md', 'scope=branch', join(h.repo, 'tests'))).toEqual({ before: '# probe\ncommitted on the branch\n', after: null })
    git('branch', '-q', '--unset-upstream')
    expect(await body('README.md', 'scope=remote')).toMatchObject({ before: '# probe\ncommitted on the branch\n' })
    // A tracked file deleted from disk has no after side.
    rmSync(join(h.repo, 'src', 'added.py'))
    expect(await body('src/added.py')).toEqual({ before: 'x = 1\n', after: null })
  })

  it('refuses what is not a file of the worktree', async () => {
    expect((await h.get('/api/diff/file')).status).toBe(400)
    expect((await h.get(`/api/diff/file?path=${encodeURIComponent(h.repo)}`)).status).toBe(400)
    expect((await fileOf('README.md', 'scope=uncommitted', '/etc')).status).toBe(403)
    expect((await fileOf('../README.md')).status).toBe(400)
    expect((await fileOf('/etc/passwd')).status).toBe(400)
    expect((await fileOf('')).status).toBe(400)
    expect((await fileOf('README.md', 'scope=nope')).status).toBe(400)
    expect((await fileOf('README.md', 'scope=commit&sha=nope')).status).toBe(400)
  })
})
