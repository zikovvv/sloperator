import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeWorkspace, pick } from '../server/control.ts'
import { deleteWorktree } from '../server/worktrees.ts'
import { makeRepo, startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
const json = async (response: Response) => response.json()
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const stateOf = async () => json(await h.get('/api/state'))
const sessionOf = async (id: string) => (await stateOf()).sessions.find((entry: any) => entry.id === id)
const worktreeOf = async (id: string) => (await stateOf()).worktrees.find((entry: any) => entry.id === id)
const transcript = async (id: string) => json(await h.get(`/api/transcript/${id}`)) as Promise<any[]>
const said = (id: string, pattern: RegExp) =>
  until(() => transcript(id), (items) => items.some((item) => item.role === 'assistant' && pattern.test(item.text)), `a reply matching ${pattern}`)
const idle = (id: string) => until(async () => (await json(await h.get('/api/tasks'))).tasks as any[],
  (tasks) => !tasks.some((task) => task.sessionID === id), 'the turn to end')

/** One operation, the way anything outside the app asks for it. */
const run = async (name: string, args?: unknown) => {
  const response = await h.post(`/api/control/${name}`, args)
  const body = await json(response)
  return response.ok ? body.result : Promise.reject(new Error(body.error))
}
const newWorktree = async (body: Record<string, unknown> = {}) => json(await h.post(`/api/project/${projectID}/worktree`, body))
const newSession = async (worktreeID: string, patch: Record<string, unknown> = {}) => {
  const session = await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))
  await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue', ...patch })
  return session.id as string
}

beforeAll(async () => {
  h = await startHarness()
  await h.post('/api/project', { path: h.repo })
  projectID = (await stateOf()).projects[0].id
})
afterAll(async () => { await h.stop() })

describe('finding what was named', () => {
  const items = [
    { id: 'aaaa1111-0000', title: 'Fix login' }, { id: 'aaaa2222-0000', title: 'fix login' }, { id: 'bbbb3333-0000', title: 'Billing' },
  ]
  const names = (item: { title: string }) => [item.title, null]
  it('takes an id, the start of one, or a name nothing else shares, whatever the case', () => {
    expect(pick('session', 'bbbb3333-0000', items, names)).toBe(items[2])
    expect(pick('session', 'BBBB', items, names)).toBe(items[2])
    expect(pick('session', ' billing ', items, names)).toBe(items[2])
    expect(pick('session', undefined, items, names, items[0])).toBe(items[0])
    expect(pick('session', '  ', items, names, items[1])).toBe(items[1])
  })
  it('says what it could not tell apart, what it could not find, and when nothing is current', () => {
    expect(() => pick('session', 'Fix login', items, names)).toThrow('"Fix login" matches 2 sessions: Fix login (aaaa1111), fix login (aaaa2222). Use the id.')
    expect(() => pick('session', 'aaaa', items, names)).toThrow(/matches 2 sessions/)
    expect(() => pick('session', 'bbb', items, names)).toThrow('No session matches "bbb". list_workspace shows what there is.')   // too short to be an id
    expect(() => pick('session', null, items, names)).toThrow(/Say which session/)
    // A number is a reference like any other, never a quiet way of saying "mine".
    expect(() => pick('session', 12345678, items, names, items[0])).toThrow('No session matches "12345678"')
  })
})

describe('the operations, over HTTP', () => {
  it('lists what there is to call, and refuses a name it does not have', async () => {
    const listing = await json(await h.get('/api/control'))
    expect(listing.operations.map((operation: any) => operation.name)).toEqual(
      ['list_workspace', 'update_session', 'update_worktree', 'create_session', 'create_worktree', 'manage_folder', 'manage_stack'])
    expect(listing.operations[1].inputSchema.properties.worktree.type).toBe('string')
    expect(listing.usage).toMatch(/POST \/api\/control/)
    await expect(run('delete_everything')).rejects.toThrow(/No such operation: delete_everything\. There is: list_workspace, /)
  })

  it('describes the whole workspace: projects, folders, worktrees and their sessions', async () => {
    const { worktree, session } = await newWorktree({ name: 'Listed' })
    const listed = await run('list_workspace', ['not', 'an', 'object'])
    expect(listed.current).toBeNull()
    const project = listed.projects.find((entry: any) => entry.id === projectID)
    expect(project).toMatchObject({ path: h.repo, folders: ['main'], stacks: [] })
    expect(project.worktrees.find((entry: any) => entry.id === worktree.id)).toEqual({
      id: worktree.id, name: 'Listed', branch: worktree.branch, base: 'origin/main', path: worktree.path, folder: 'main',
      main: false, pinned: false, archived: false,
      sessions: [{ id: session.id, title: session.title, engine: 'claude', pinned: false, archived: false, running: false }],
    })
  })

  it('renames, pins and archives a session, by title or by the start of its id', async () => {
    const { worktree } = await newWorktree()
    const id = await newSession(worktree.id, { title: 'Quarterly numbers' })
    expect(await run('update_session', { session: 'quarterly NUMBERS', title: ' Q3 numbers ', pinned: true }))
      .toEqual({ id, title: 'Q3 numbers', worktree: worktree.id, pinned: true, archived: false })
    expect(await sessionOf(id)).toMatchObject({ title: 'Q3 numbers', titleIsManual: true, isPinned: true })
    // A title that is a number is still a title, not something to drop on the way.
    expect((await run('update_session', { session: id, title: 2048, pinned: true })).title).toBe('2048')
    await run('update_session', { session: id.slice(0, 8), archived: true, pinned: false })
    expect(await sessionOf(id)).toMatchObject({ isArchived: true, isPinned: false })
    await expect(run('update_session', { session: id })).rejects.toThrow('Nothing to change: give title, pinned, archived or worktree.')
    await expect(run('update_session', { title: 'x' })).rejects.toThrow(/Say which session/)
    await expect(run('update_session', { session: 'nobody home', title: 'x' })).rejects.toThrow('No session matches "nobody home"')
  })

  it('moves a session and its conversation to another worktree, where its next turn is told what came before', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id)
    await h.post(`/api/session/${id}/send`, { text: 'remember the word heron' })
    await idle(id)
    expect((await sessionOf(id)).claudeSessionID).toMatch(/^fake-/)

    expect(await run('update_session', { session: id, worktree: to.branch })).toMatchObject({ worktree: to.id })
    expect(await sessionOf(id)).toMatchObject({ worktreeID: to.id, claudeSessionID: null })
    expect((await transcript(id)).at(-1)).toMatchObject({ role: 'info', text: `Session moved to ${to.name}: ${to.path}` })

    // Claude cannot resume a conversation from another folder, so the new one is handed the old one's words.
    const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
    process.env.FAKE_ARGS_LOG = log
    await h.post(`/api/session/${id}/send`, { text: 'which word' })
    await idle(id)
    delete process.env.FAKE_ARGS_LOG
    const started = readFileSync(log, 'utf8')
    expect(started).not.toContain('--resume')
    expect(started).toContain('remember the word heron')

    // Moving to where it already is changes nothing; a worktree that is not there is refused.
    await h.patch(`/api/session/${id}`, { worktreeID: to.id })
    expect((await sessionOf(id)).claudeSessionID).toMatch(/^fake-/)
    expect((await h.patch(`/api/session/${id}`, { worktreeID: 'no-such' })).status).toBe(404)
    await expect(run('update_session', { session: id, worktree: 'no such branch' })).rejects.toThrow('No worktree matches')
  })

  it('renames, pins, archives and re-bases a worktree', async () => {
    const { worktree } = await newWorktree()
    const described = await run('update_worktree', { worktree: worktree.branch, name: ' Checkout flow ', pinned: true, base_branch: 'feature/one' })
    expect(described).toMatchObject({ id: worktree.id, name: 'Checkout flow', base: 'feature/one', pinned: true, archived: false })
    expect(await worktreeOf(worktree.id)).toMatchObject({ name: 'Checkout flow', nameIsManual: true, baseBranch: 'feature/one' })
    expect(await run('update_worktree', { worktree: worktree.path, archived: true, pinned: false })).toMatchObject({ archived: true, pinned: false })
    await expect(run('update_worktree', { worktree: worktree.id })).rejects.toThrow(/Nothing to change: give name, pinned/)
    await expect(run('update_worktree', { name: 'x' })).rejects.toThrow(/Say which worktree/)
  })

  it('moves a worktree into a folder, making the folder first, and renames its branch', async () => {
    const { worktree, session } = await newWorktree()
    await h.post(`/api/session/${session.id}/send`, { text: 'hello' })
    await idle(session.id)
    const moved = await run('update_worktree', { worktree: worktree.id, folder: 'review', branch: 'tidy/review-branch' })
    expect(moved).toMatchObject({ folder: 'review', branch: 'tidy/review-branch' })
    expect(moved.path).toContain('/review/'); expect(existsSync(moved.path)).toBe(true); expect(existsSync(worktree.path)).toBe(false)
    expect((await stateOf()).projects[0].worktreeGroups).toContain('review')
    // Its Claude conversation lived under the old path; the next turn starts a new one.
    expect((await sessionOf(session.id)).claudeSessionID).toBeNull()
    // A name the app would not keep as typed is used the way the app registered it, so the worktree stays in sight.
    expect(await run('update_worktree', { worktree: worktree.id, folder: 'on hold!' })).toMatchObject({ folder: 'on-hold-' })
    expect((await stateOf()).projects[0].worktreeGroups).toContain('on-hold-')
    // The project's own checkout does not move, and no folder is made for the attempt.
    const main = (await stateOf()).worktrees.find((entry: any) => entry.isMain)
    await expect(run('update_worktree', { worktree: main.id, folder: 'never-made' })).rejects.toThrow(/cannot be moved to a folder/)
    expect((await stateOf()).projects[0].worktreeGroups).not.toContain('never-made')
    // Filing it where it already is changes nothing: not its path, not its agent's thread.
    await h.post(`/api/session/${session.id}/send`, { text: 'hello again' })
    await idle(session.id)
    const settled = await worktreeOf(worktree.id)
    expect(await run('update_worktree', { worktree: worktree.id, folder: 'on-hold-' })).toMatchObject({ path: settled.path })
    expect((await sessionOf(session.id)).claudeSessionID).toMatch(/^fake-/)
    // A folder that exists is not made twice, and "main" never is.
    expect(await run('update_worktree', { worktree: worktree.id, folder: 'main' })).toMatchObject({ folder: 'main' })
    expect(await run('update_worktree', { worktree: worktree.id, folder: 'review' })).toMatchObject({ folder: 'review' })
    expect((await stateOf()).projects[0].worktreeGroups.filter((name: string) => name === 'review')).toHaveLength(1)
  })

  it('repoints a worktree at another checkout of the same repository, and at nothing else', async () => {
    const { worktree, session } = await newWorktree()
    await h.post(`/api/session/${session.id}/send`, { text: 'hello' })
    await idle(session.id)
    const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-elsewhere-'))), 'checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/elsewhere', elsewhere)

    expect(await run('update_worktree', { worktree: worktree.id, path: elsewhere })).toMatchObject({ path: elsewhere, branch: 'moved/elsewhere' })
    expect(await worktreeOf(worktree.id)).toMatchObject({ path: elsewhere, branch: 'moved/elsewhere' })
    expect((await sessionOf(session.id)).claudeSessionID).toBeNull()
    expect(existsSync(worktree.path)).toBe(true)   // nothing on disk moved or went away

    const refuse = async (target: any, path: string) => json(await h.patch(`/api/worktree/${target.id}`, { path }))
    const other = (await newWorktree()).worktree
    expect(await refuse(other, elsewhere)).toEqual({ error: 'Another worktree already points there' })
    const plain = mkdtempSync(join(tmpdir(), 'orch-plain-'))
    expect(await refuse(other, plain)).toEqual({ error: `${plain} is not the top folder of a git checkout` })
    expect(await refuse(other, join(worktree.path, 'tests'))).toEqual({ error: `${join(worktree.path, 'tests')} is not the top folder of a git checkout` })
    const foreign = realpathSync(makeRepo())
    await expect(run('update_worktree', { worktree: other.id, path: foreign })).rejects.toThrow(`${foreign} is a checkout of another repository`)
    const main = (await stateOf()).worktrees.find((entry: any) => entry.isMain)
    expect(await refuse(main, elsewhere)).toEqual({ error: "A project's own checkout cannot be repointed" })
    expect((await worktreeOf(other.id)).path).toBe(other.path)
    // The path it already has is not a repoint at all.
    expect((await h.patch(`/api/worktree/${other.id}`, { path: other.path })).status).toBe(200)
  })

  it('sees through other spellings of a path when repointing, and keeps the real one', async () => {
    const taken = (await newWorktree()).worktree
    const other = (await newWorktree()).worktree
    const refuse = async (path: string) => json(await h.patch(`/api/worktree/${other.id}`, { path }))
    const link = join(mkdtempSync(join(tmpdir(), 'orch-link-')), 'link')
    symlinkSync(taken.path, link)
    // A record whose folder is gone from disk is compared by the path it has.
    rmSync((await newWorktree()).worktree.path, { recursive: true, force: true })
    for (const alias of [`${taken.path}/`, `${taken.path}/.`, link, `${h.repo}/`]) {
      expect(await refuse(alias)).toEqual({ error: 'Another worktree already points there' })
    }
    expect((await refuse('some/relative/path')).error).toMatch(/is not the top folder of a git checkout/)
    expect((await worktreeOf(other.id)).path).toBe(other.path)
    const fresh = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-fresh-'))), 'checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/fresh', fresh)
    await h.patch(`/api/worktree/${other.id}`, { path: `${fresh}/` })
    expect((await worktreeOf(other.id)).path).toBe(fresh)
    // Its own path under another spelling is no repoint at all: its sessions keep their threads.
    const id = await newSession(other.id)
    await h.post(`/api/session/${id}/send`, { text: 'hello' })
    await idle(id)
    expect((await h.patch(`/api/worktree/${other.id}`, { path: `${fresh}/.` })).status).toBe(200)
    expect((await sessionOf(id)).claudeSessionID).toMatch(/^fake-/)
  })

  it('takes a repointed worktree out of the folder it was filed in, and says what it left behind', async () => {
    const { worktree } = await newWorktree()
    await run('update_worktree', { worktree: worktree.id, folder: 'shelf' })
    const shelved = await worktreeOf(worktree.id)
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-outside-'))), 'my-own-checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/outside', outside)
    await expect(run('update_worktree', { worktree: worktree.id, path: outside, folder: 'shelf' }))
      .rejects.toThrow('Give path or folder, not both')
    const repointed = await run('update_worktree', { worktree: worktree.id, path: outside })
    expect(repointed).toMatchObject({ path: outside, folder: 'main', note: `The checkout at ${shelved.path} is still on disk and is no longer in the sidebar.` })
    // Renaming the folder it used to be in moves what is in that folder, which this checkout never was.
    await run('manage_folder', { action: 'rename', name: 'shelf', new_name: 'shelf-2' })
    expect(existsSync(outside)).toBe(true); expect((await worktreeOf(worktree.id)).path).toBe(outside)
    // Pointed at a checkout that sits in one of the project's folders, it is shown in that folder.
    const filed = (await newWorktree({ group: 'shelf-2' })).worktree
    await h.del(`/api/worktree/${filed.id}?keepOnDisk=1`)
    expect(await run('update_worktree', { worktree: worktree.id, path: filed.path })).toMatchObject({ folder: 'shelf-2' })
  })

  it('does not repoint a worktree a turn is running in', async () => {
    const { worktree, session } = await newWorktree()
    const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-busy-'))), 'checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/busy', elsewhere)
    await h.patch(`/api/session/${session.id}`, { engine: 'claude', steeringMode: 'queue' })
    await h.post(`/api/session/${session.id}/send`, { text: 'SLOW' })
    await until(async () => (await json(await h.get('/api/tasks'))).tasks as any[], (tasks) => tasks.some((task) => task.sessionID === session.id), 'the turn to start')
    const refused = await h.patch(`/api/worktree/${worktree.id}`, { path: elsewhere })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toEqual({ error: 'A turn is running in this worktree: stop it before pointing the worktree somewhere else' })
    await h.post(`/api/session/${session.id}/stop`)
    await idle(session.id)
    expect((await h.patch(`/api/worktree/${worktree.id}`, { path: elsewhere })).status).toBe(200)
  })

  it('keeps a session with its running turn: asked to move, it goes when the turn ends, and its worktree stays busy until then', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id)
    const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-left-'))), 'checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/left', elsewhere)
    await h.post(`/api/session/${id}/send`, { text: 'SLOW' })
    await until(async () => (await json(await h.get('/api/tasks'))).tasks as any[], (tasks) => tasks.some((task) => task.sessionID === id), 'the turn to start')
    expect(await run('update_session', { session: id, worktree: to.id })).toMatchObject({ worktree: from.id, note: expect.stringMatching(/when its turn ends/) })
    expect((await sessionOf(id)).worktreeID).toBe(from.id)
    // Its agent is at work here, and everything that asks says so.
    expect(((await json(await h.get('/api/tasks'))).tasks as any[]).find((task) => task.sessionID === id).worktree).toBe((await worktreeOf(from.id)).name)
    expect((await h.patch(`/api/worktree/${from.id}`, { path: elsewhere })).status).toBe(409)
    await h.post(`/api/session/${id}/stop`)
    await idle(id)
    // The move happened with the turn's end, not some time after it: there is no moment to start a turn in between.
    expect((await sessionOf(id)).worktreeID).toBe(to.id)
    expect((await h.patch(`/api/worktree/${from.id}`, { path: elsewhere })).status).toBe(200)
  })

  it('drops a waiting move when the session is asked back to where it is', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id)
    await h.post(`/api/session/${id}/send`, { text: 'SLOW' })
    await until(async () => (await json(await h.get('/api/tasks'))).tasks as any[], (tasks) => tasks.some((task) => task.sessionID === id), 'the turn to start')
    await run('update_session', { session: id, worktree: to.id })
    expect(await run('update_session', { session: id, worktree: from.id })).not.toHaveProperty('note')
    await h.post(`/api/session/${id}/stop`)
    await idle(id)
    expect((await sessionOf(id)).worktreeID).toBe(from.id)
    const notes = (await transcript(id)).filter((item) => item.role === 'info').map((item) => item.text)
    expect(notes.some((text) => /^Session stays in /.test(text))).toBe(true); expect(notes.some((text) => /^Session moved to/.test(text))).toBe(false)
  })

  it('forgets a move that was waiting when the session is deleted, or its destination is, before the turn ends', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const stays = await newSession(from.id)
    const goes = await newSession(from.id)
    for (const id of [stays, goes]) {
      await h.post(`/api/session/${id}/send`, { text: 'SLOW' })
      await until(async () => (await json(await h.get('/api/tasks'))).tasks as any[], (tasks) => tasks.some((task) => task.sessionID === id), 'the turn to start')
      await run('update_session', { session: id, worktree: to.id })
    }
    await h.del(`/api/session/${goes}`)
    await h.del(`/api/worktree/${to.id}?keepOnDisk=1`)
    await h.post(`/api/session/${stays}/stop`)
    await idle(stays)
    expect(await sessionOf(stays)).toMatchObject({ worktreeID: from.id })
    expect(await sessionOf(goes)).toBeUndefined()
  })

  it('gives one checkout to one record when two ask for it in the same instant', async () => {
    const first = (await newWorktree()).worktree
    const second = (await newWorktree()).worktree
    const prize = join(realpathSync(mkdtempSync(join(tmpdir(), 'orch-prize-'))), 'checkout')
    git(h.repo, 'worktree', 'add', '-q', '-b', 'moved/prize', prize)
    const answers = await Promise.all([first, second].map((entry) => h.patch(`/api/worktree/${entry.id}`, { path: prize })))
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
    expect((await stateOf()).worktrees.filter((entry: any) => entry.path === prize)).toHaveLength(1)
  })

  it('never removes a repository of its own by hand, whatever record points at it', async () => {
    const repo = makeRepo()
    await expect(deleteWorktree(repo, repo)).rejects.toThrow(/is a repository of its own/)
    expect(existsSync(join(repo, '.git'))).toBe(true); expect(existsSync(join(repo, 'README.md'))).toBe(true)
  })

  it('keeps folders inside the worktree root: only a folder the project has, under a name that is one', async () => {
    const { worktree } = await newWorktree()
    for (const group of ['../../escaped', '..', 'never-registered']) {
      expect(await json(await h.post(`/api/worktree/${worktree.id}/move`, { group }))).toEqual({ error: `No such folder: ${group}` })
      expect((await h.post(`/api/project/${projectID}/worktree`, { group })).status).toBe(400)
    }
    expect((await worktreeOf(worktree.id)).path).toBe(worktree.path)
    for (const name of ['..', '.', ' ... ']) {
      expect((await h.post(`/api/project/${projectID}/group`, { name })).status).toBe(400)
    }
    await h.post(`/api/project/${projectID}/group`, { name: 'solid' })
    expect((await h.patch(`/api/project/${projectID}/group/solid`, { name: '..' })).status).toBe(400)
    await expect(run('update_worktree', { worktree: worktree.id, folder: '..' })).rejects.toThrow('A folder needs a plain name')
    expect((await stateOf()).projects[0].worktreeGroups).not.toContain('..')
  })

  it('adds a session to a worktree, and a worktree to a project', async () => {
    const { worktree } = await newWorktree()
    const titled = await run('create_session', { worktree: worktree.id, title: ' Second look ' })
    expect(await sessionOf(titled.id)).toMatchObject({ worktreeID: worktree.id, title: 'Second look', titleIsManual: true })
    const plain = await run('create_session', { worktree: worktree.id })
    expect(plain).toMatchObject({ worktree: worktree.id, title: (await sessionOf(plain.id)).title })

    const made = (await run('create_worktree', { name: ' Spike ', branch: 'spike/cache', base: 'feature/one', folder: 'spikes' })).worktree
    expect(made).toMatchObject({ name: 'Spike', branch: 'spike/cache', base: 'feature/one', folder: 'spikes' })
    expect(made.sessions).toHaveLength(1)
    expect(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('spike/cache')
    const bare = (await run('create_worktree')).worktree
    expect(bare).toMatchObject({ folder: 'main', base: 'origin/main' }); expect(bare.branch).toBeTruthy()
  })

  it('makes, renames and removes folders', async () => {
    const groups = async () => (await stateOf()).projects[0].worktreeGroups as string[]
    await run('manage_folder', { action: 'create', name: 'parked' })
    expect(await groups()).toContain('parked')
    await run('manage_folder', { action: 'rename', name: 'parked', new_name: 'later' })
    expect(await groups()).toContain('later'); expect(await groups()).not.toContain('parked')
    const { worktree } = await newWorktree({ group: 'later' })
    await expect(run('manage_folder', { action: 'remove', name: 'later' })).rejects.toThrow('That group still has worktrees in it')
    await run('update_worktree', { worktree: worktree.id, folder: 'main' })
    await run('manage_folder', { action: 'remove', name: 'later' })
    expect(await groups()).not.toContain('later')
    // Only a folder the project has can be renamed or removed: a name is never a way to somewhere else in the app.
    for (const name of ['..', '.', 'nowhere']) {
      await expect(run('manage_folder', { action: 'remove', name })).rejects.toThrow(`No folder named "${name}"`)
      await expect(run('manage_folder', { action: 'rename', name, new_name: 'x' })).rejects.toThrow(`No folder named "${name}"`)
    }
    expect((await stateOf()).projects.map((entry: any) => entry.id)).toContain(projectID)
    await expect(run('manage_folder', { action: 'rename', name: 'main' })).rejects.toThrow('Give new_name to rename a folder.')
    await expect(run('manage_folder', { action: 'shuffle', name: 'main' })).rejects.toThrow('action is one of: create, rename, remove.')
    await expect(run('manage_folder', { action: 'create' })).rejects.toThrow('Say which folder: give name.')
  })

  it('builds, renames, updates, shrinks and dissolves a stack', async () => {
    const stacks = async () => (await stateOf()).stacks as any[]
    const created = await run('manage_stack', { action: 'create' })
    const added = await run('manage_stack', { action: 'add_layer', stack: created.stack.name })
    expect((await stacks()).find((stack) => stack.id === created.stack.id).layers).toEqual([created.worktree.id, added.worktree.id])
    await run('manage_stack', { action: 'rename', stack: created.stack.id, name: 'Checkout rework' })
    expect((await run('manage_stack', { action: 'update', stack: 'checkout rework' })).results).toHaveLength(1)
    await run('manage_stack', { action: 'remove_layer', stack: 'Checkout rework', worktree: added.worktree.branch })
    expect((await stacks()).find((stack) => stack.id === created.stack.id).layers).toEqual([created.worktree.id])
    await run('manage_stack', { action: 'dissolve', stack: 'Checkout rework' })
    expect((await stacks()).some((stack) => stack.id === created.stack.id)).toBe(false)
    expect(await worktreeOf(created.worktree.id)).toBeTruthy()   // dissolving keeps the worktrees

    const second = await run('manage_stack', { action: 'create', project: h.repo })
    await expect(run('manage_stack', { action: 'rename', stack: second.stack.id })).rejects.toThrow('Give the stack a name')
    await expect(run('manage_stack', { action: 'explode', stack: second.stack.id })).rejects.toThrow(/action is one of: create, add_layer/)
    await expect(run('manage_stack', { action: 'update' })).rejects.toThrow(/Say which stack/)
    expect((await run('list_workspace')).projects[0].stacks).toContainEqual(
      { id: second.stack.id, name: second.stack.name, base: 'main', layers: [second.worktree.id] })
  })

  it('writes down where it answers, for anything started outside the app', () => {
    expect(JSON.parse(readFileSync(join(h.stateDir, 'server.json'), 'utf8'))).toEqual({ url: h.base, pid: process.pid })
  })
})

describe('the operations, from an agent inside a session', () => {
  it('lets Claude and Codex act on the session and worktree they are in, without naming them', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const { worktree } = await newWorktree()
      const id = await newSession(worktree.id, { engine, accessMode: 'full' })
      await h.post(`/api/session/${id}/send`, { text: `SIDEBAR update_session {"title":"Named by ${engine}","pinned":true}` })
      await said(id, /^DID: /)
      expect(await sessionOf(id)).toMatchObject({ title: `Named by ${engine}`, isPinned: true })
      await idle(id)
      await h.post(`/api/session/${id}/send`, { text: 'SIDEBAR update_worktree {"name":"Renamed from inside"}' })
      await until(() => worktreeOf(worktree.id), (entry) => entry.name === 'Renamed from inside', 'the worktree to be renamed')
      await idle(id)
    }
  })

  it('tells the agent which session it is, and what went wrong in words it can act on', async () => {
    const { worktree } = await newWorktree()
    const id = await newSession(worktree.id)   // not full access: looking is free all the same
    await h.post(`/api/session/${id}/send`, { text: 'SIDEBAR list_workspace' })
    const listed = (await said(id, /^DID: /)).find((item) => item.role === 'assistant' && item.text.startsWith('DID: '))
    expect(JSON.parse(listed.text.slice(5)).current).toEqual({ session: id, worktree: worktree.id })
    await idle(id)
    await h.patch(`/api/session/${id}`, { accessMode: 'full' })
    await h.post(`/api/session/${id}/send`, { text: 'SIDEBAR update_session {"worktree":"nowhere at all"}' })
    await said(id, /^FAILED: No worktree matches "nowhere at all"\. list_workspace shows what there is\.$/)
    await idle(id)
  })

  it('asks the person first unless the session has full access, for Claude and Codex alike', async () => {
    const pending = (id: string) => until(() => transcript(id),
      (items) => items.some((item) => item.role === 'permission' && item.permission.status === 'pending'), 'a card to answer')
      .then((items) => items.find((item) => item.role === 'permission' && item.permission.status === 'pending'))
    for (const [engine, accessMode] of [['claude', 'edits'], ['codex', 'safe']] as const) {
      const { worktree } = await newWorktree()
      const id = await newSession(worktree.id, { engine, accessMode, title: 'Untouched' })
      await h.post(`/api/session/${id}/send`, { text: 'SIDEBAR update_session {"title":"Changed without asking"}' })
      const card = await pending(id)
      expect(card).toMatchObject({ engine, permission: { toolName: 'mcp__orchestrator__update_session', input: { title: 'Changed without asking' } } })
      expect((await sessionOf(id)).title).toBe('Untouched')   // nothing happens while the card waits
      await h.post(`/api/permission/${card.permission.id}`, { behavior: 'deny', message: 'leave my titles alone' })
      await said(id, /^FAILED: leave my titles alone$/)
      expect((await sessionOf(id)).title).toBe('Untouched')
      await idle(id)

      await h.post(`/api/session/${id}/send`, { text: 'SIDEBAR update_session {"title":"Changed with a yes"}' })
      await h.post(`/api/permission/${(await pending(id)).permission.id}`, { behavior: 'allow' })
      await said(id, /^DID: /)
      expect((await sessionOf(id)).title).toBe('Changed with a yes')
      await idle(id)
    }
  })

  it('does not move a worktree\'s directory while a turn runs in it: not by filing it, not by renaming its folder', async () => {
    await run('manage_folder', { action: 'create', name: 'busy' })
    const { worktree, session } = await newWorktree({ group: 'busy' })
    await h.patch(`/api/session/${session.id}`, { engine: 'claude', accessMode: 'full', steeringMode: 'queue' })
    // The agent asks for its own worktree to be renamed and filed elsewhere: it is told why not, and nothing at all changes.
    await h.post(`/api/session/${session.id}/send`, { text: 'SIDEBAR update_worktree {"folder":"made-for-nothing","name":"Half done"}' })
    await said(session.id, /^FAILED: A turn is running in this worktree: its directory can be moved once the turn ends$/)
    await idle(session.id)
    expect((await worktreeOf(worktree.id)).name).not.toBe('Half done')
    expect((await stateOf()).projects[0].worktreeGroups).not.toContain('made-for-nothing')
    await h.post(`/api/session/${session.id}/send`, { text: 'SLOW' })
    await until(async () => (await json(await h.get('/api/tasks'))).tasks as any[], (tasks) => tasks.some((task) => task.sessionID === session.id), 'the turn to start')
    expect((await h.post(`/api/worktree/${worktree.id}/move`, { group: 'main' })).status).toBe(409)
    const renamed = await h.patch(`/api/project/${projectID}/group/busy`, { name: 'busier' })
    expect(renamed.status).toBe(409)
    expect(await json(renamed)).toEqual({ error: 'A turn is running in a worktree of this folder: it can be renamed once the turn ends' })
    expect((await worktreeOf(worktree.id)).path).toBe(worktree.path); expect(existsSync(worktree.path)).toBe(true)
    await h.post(`/api/session/${session.id}/stop`)
    await idle(session.id)
    // Renamed once idle, its directory has a new path, which Claude's thread does not follow.
    expect((await sessionOf(session.id)).claudeSessionID).toMatch(/^fake-/)
    expect((await h.patch(`/api/project/${projectID}/group/busy`, { name: 'busier' })).status).toBe(200)
    expect((await sessionOf(session.id)).claudeSessionID).toBeNull()
  })

  it('sends a retried message once, with what came before it, when the thread has to start fresh', async () => {
    const { worktree } = await newWorktree()
    const id = await newSession(worktree.id)
    await h.post(`/api/session/${id}/send`, { text: 'the fish is a bream' })
    await idle(id)
    await h.post(`/api/session/${id}/send`, { text: 'NOCONV where were we' })
    await idle(id)
    const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
    process.env.FAKE_ARGS_LOG = log
    await h.post(`/api/session/${id}/retry`)
    await idle(id)
    delete process.env.FAKE_ARGS_LOG
    const started = readFileSync(log, 'utf8')
    expect(started).toContain('the fish is a bream')
    expect(started.split('NOCONV where were we')).toHaveLength(2)
  })

  it('moves a session that asks mid-turn once its turn ends, and the next turn begins afresh in the new place', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id, { accessMode: 'full' })
    await h.post(`/api/session/${id}/send`, { text: `the word is osprey\nSIDEBAR update_session {"worktree":"${to.id}"}` })
    const reply = (await said(id, /^DID: /)).find((item) => item.role === 'assistant' && item.text.startsWith('DID: '))
    // The agent is told the truth: it is still where it was, and when that changes.
    expect(JSON.parse(reply.text.slice(5))).toMatchObject({ worktree: from.id, note: `This session moves to ${to.name} when its turn ends; until then it keeps running in ${from.path}.` })
    await idle(id)
    expect(await sessionOf(id)).toMatchObject({ worktreeID: to.id, claudeSessionID: null })
    expect((await transcript(id)).some((item) => item.role === 'info' && item.text === `Session moved to ${to.name}: ${to.path}`)).toBe(true)
    const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
    process.env.FAKE_ARGS_LOG = log
    await h.post(`/api/session/${id}/send`, { text: 'which word' })
    await idle(id)
    delete process.env.FAKE_ARGS_LOG
    expect(readFileSync(log, 'utf8')).toContain('the word is osprey')
  })

  it('hands a fresh thread everything said so far, including what came after a message that was waiting in the queue', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id)   // not full access: the move waits on a card, and the turn with it
    await h.post(`/api/session/${id}/send`, { text: `the word is osprey\nSIDEBAR update_session {"worktree":"${to.id}"}` })
    const card = (await until(() => transcript(id), (items) => items.some((item) => item.role === 'permission'), 'the card')).find((item) => item.role === 'permission')
    await h.post(`/api/session/${id}/send`, { text: 'second message' })   // queued behind the waiting turn
    for (const _ of [1, 2]) await h.post(`/api/session/${id}/send`, { text: 'same words twice' })   // and the same thing said twice
    const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
    process.env.FAKE_ARGS_LOG = log
    await h.post(`/api/permission/${card.permission.id}`, { behavior: 'allow' })
    const started = await until(async () => (existsSync(log) ? readFileSync(log, 'utf8') : ''), (text) => text.includes('second message'), 'the queued message to be sent')
    delete process.env.FAKE_ARGS_LOG
    // The fake engine reads the old request in its context and asks again: say no, and the turn ends on its own.
    const again = await until(() => transcript(id), (items) => items.some((item) => item.role === 'permission' && item.permission.status === 'pending'), 'the second card')
    await h.post(`/api/permission/${again.find((item) => item.role === 'permission' && item.permission.status === 'pending').permission.id}`, { behavior: 'deny', message: 'not again' })
    await idle(id)
    // The reply to the first message came after "second message" was queued; the new thread is told it all the same.
    expect(started).toContain('the word is osprey'); expect(started).toContain('Assistant: DID: ')
    expect(started.split('second message')).toHaveLength(2)
    expect(started.split('same words twice')).toHaveLength(3)   // each as sent, neither repeated as context
  })

  it('still tells Codex what Claude said, when the session moved before going back to Codex', async () => {
    const from = (await newWorktree()).worktree
    const to = (await newWorktree()).worktree
    const id = await newSession(from.id, { engine: 'codex' })
    await h.post(`/api/session/${id}/send`, { text: 'codex goes first' })
    await idle(id)
    await h.patch(`/api/session/${id}`, { engine: 'claude' })
    await h.post(`/api/session/${id}/send`, { text: 'the bird is a wren' })
    await idle(id)
    await run('update_session', { session: id, worktree: to.id })
    await h.patch(`/api/session/${id}`, { engine: 'codex' })
    const log = join(mkdtempSync(join(tmpdir(), 'orch-args-')), 'args.log')
    process.env.FAKE_ARGS_LOG = log
    await h.post(`/api/session/${id}/send`, { text: 'which bird' })
    await idle(id)
    delete process.env.FAKE_ARGS_LOG
    expect(readFileSync(log, 'utf8')).toContain('the bird is a wren')
  })

  it('knows the stack and the project a session is in, with more than one project open', async () => {
    const otherRepo = makeRepo()
    await h.post('/api/project', { path: otherRepo })
    const created = await run('manage_stack', { action: 'create', project: h.repo })
    await h.patch(`/api/session/${created.session.id}`, { accessMode: 'full' })
    await h.post(`/api/session/${created.session.id}/send`, { text: 'SIDEBAR manage_stack {"action":"add_layer"}' })
    await until(async () => (await stateOf()).stacks.find((stack: any) => stack.id === created.stack.id),
      (stack) => stack.layers.length === 2, 'a second layer')
    await idle(created.session.id)
    await h.post(`/api/session/${created.session.id}/send`, { text: 'SIDEBAR manage_folder {"action":"create","name":"from-inside"}' })
    await until(stateOf, (state) => state.projects.find((entry: any) => entry.id === projectID).worktreeGroups.includes('from-inside'), 'the folder')
    await idle(created.session.id)
    // Outside a session, with two projects, there is no saying which one was meant.
    await expect(run('manage_folder', { action: 'create', name: 'which' })).rejects.toThrow(/Say which project/)
    await expect(run('create_worktree', { project: 'no such project' })).rejects.toThrow('No project matches')
  })
})

describe('describeWorkspace', () => {
  it('reads a worktree with no folder as being in main, and says which sessions are running', () => {
    const session = { id: 's', worktreeID: 'w', title: 'T', engine: 'codex', isPinned: false, isArchived: false } as any
    const described = describeWorkspace({
      projects: [{ id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }],
      worktrees: [{ id: 'w', projectID: 'p', name: 'n', path: '/acme', branch: null, baseBranch: null, isMain: true, isExpanded: true }],
      sessions: [session], stacks: [], running: ['s'],
    }, 'elsewhere')
    expect(described.current).toBeNull()
    expect(described.projects[0].worktrees[0]).toMatchObject({ folder: 'main', pinned: false, archived: false, sessions: [{ id: 's', running: true }] })
  })
})

describe('sloperator, the command for sessions outside the app', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    promisify(execFile)('node', [join(__dirname, '..', 'bin', 'sloperator.mjs'), ...args],
      { env: { PATH: process.env.PATH!, ORCHESTRATOR_STATE_DIR: h.stateDir, ...env } })
      .then((out) => ({ code: 0, ...out }), (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }))

  it('finds the running app, lists what it can do, and does it', async () => {
    const help = await cli([])
    expect(JSON.parse(help.stdout).operations.map((operation: any) => operation.name)).toContain('update_worktree')
    expect(JSON.parse((await cli(['help'])).stdout).usage).toBeTruthy()
    const { worktree } = await newWorktree()
    const id = await newSession(worktree.id)
    const renamed = await cli(['update_session', `session=${id}`, 'title=From the shell = fine', 'pinned=true'])
    expect(JSON.parse(renamed.stdout)).toMatchObject({ id, title: 'From the shell = fine', pinned: true })
    // Only true and false are more than text: a title that is a number stays a title.
    expect(JSON.parse((await cli(['update_session', `session=${id}`, 'title=2048'])).stdout).title).toBe('2048')
    await cli(['update_session', `session=${id}`, 'title=From the shell = fine'])
    expect(await sessionOf(id)).toMatchObject({ title: 'From the shell = fine', isPinned: true })
    const viaJSON = await cli(['update_session', JSON.stringify({ session: id, pinned: false })])
    expect(JSON.parse(viaJSON.stdout).pinned).toBe(false)
    expect(JSON.parse((await cli(['list_workspace'])).stdout).current).toBeNull()
  })

  it('says what went wrong and exits 1', async () => {
    expect(await cli(['update_session', 'session=nobody', 'title=x'])).toMatchObject({ code: 1, stderr: expect.stringContaining('No session matches "nobody"') })
    expect(await cli(['update_session', 'oops'])).toMatchObject({ code: 1, stderr: 'Expected key=value, got "oops"\n' })
    // An operation is a name, never a way to another address of the app.
    expect(await cli(['../state'])).toMatchObject({ code: 1, stderr: expect.stringContaining('No such operation: ../state') })
    expect(await cli(['list_workspace'], { SLOPERATOR_URL: 'http://127.0.0.1:9' })).toMatchObject({ code: 1, stderr: expect.stringContaining('is not answering at http://127.0.0.1:9') })
    expect(await cli([], { ORCHESTRATOR_STATE_DIR: mkdtempSync(join(tmpdir(), 'orch-empty-state-')) })).toMatchObject({ code: 1, stderr: expect.stringContaining('has not run here') })
  })
})
