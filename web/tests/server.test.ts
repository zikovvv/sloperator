import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let projectID = ''
let mainWorktreeID = ''

beforeAll(async () => { h = await startHarness() })
afterAll(async () => { await h.stop() })

const json = async (response: Response) => ({ status: response.status, body: await response.json() })

describe('guard', () => {
  it('refuses a foreign Host and a foreign Origin', async () => {
    const http = await import('node:http')
    const foreignHost = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: h.port, path: '/api/state', headers: { Host: 'evil.example.com' } },
        (response) => { resolve(response.statusCode ?? 0); response.resume() })
    })
    expect(foreignHost).toBe(403)
    const foreignOrigin = await fetch(`${h.base}/api/state`, { headers: { Origin: 'https://evil.example.com' } })
    expect(foreignOrigin.status).toBe(403)
  })
  it('answers its own origin', async () => {
    expect((await h.get('/api/state')).status).toBe(200)
  })
  it('refuses a request a browser marks as cross-site even without an Origin: an <img> or a link from another site', async () => {
    expect((await h.get('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    expect((await h.get('/api/state', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200)
    expect((await h.get('/api/state', { headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(200)
  })
})

describe('projects', () => {
  it('rejects a missing folder', async () => {
    expect((await json(await h.post('/api/project', { path: '/nope/never' }))).status).toBe(400)
  })
  it('adds a git project with a main worktree in the main folder', async () => {
    const { status } = await json(await h.post('/api/project', { path: h.repo }))
    expect(status).toBe(200)
    const state = (await json(await h.get('/api/state'))).body
    const project = state.projects.find((entry: any) => entry.path === h.repo)
    projectID = project.id
    expect(project.worktreeGroups).toEqual(['main'])
    const main = state.worktrees.find((entry: any) => entry.projectID === projectID && entry.isMain)
    mainWorktreeID = main.id
    expect(main.group).toBe('main')
  })
  it('is idempotent for the same path', async () => {
    const { body } = await json(await h.post('/api/project', { path: h.repo }))
    expect(body.alreadyAdded).toBe(true)
  })
  it('git-inits a plain folder', async () => {
    const plain = join(h.stateDir, 'plain'); mkdirSync(plain)
    writeFileSync(join(plain, 'x.txt'), 'x')
    expect((await h.post('/api/project', { path: plain })).status).toBe(200)
    expect(existsSync(join(plain, '.git'))).toBe(true)
    const state = (await json(await h.get('/api/state'))).body
    const id = state.projects.find((entry: any) => entry.path === plain).id
    expect((await h.del(`/api/project/${id}`)).status).toBe(200)
  })
})

describe('folders (groups)', () => {
  it('adds, refuses empty names, reorders, refuses to drop a non-empty one, removes an empty one', async () => {
    expect((await h.post(`/api/project/${projectID}/group`, { name: '  ' })).status).toBe(400)
    expect((await json(await h.post(`/api/project/${projectID}/group`, { name: 'review' }))).body.groups).toEqual(['main', 'review'])
    expect((await json(await h.put(`/api/project/${projectID}/groups`, { order: ['review', 'main', 'bogus'] }))).body.groups).toEqual(['review', 'main'])
    expect((await h.put(`/api/project/nope/groups`, { order: [] })).status).toBe(404)
    expect((await h.post(`/api/project/nope/group`, { name: 'x' })).status).toBe(404)
    expect((await h.del(`/api/project/nope/group/x`)).status).toBe(404)
    // main has the main worktree in it, so it cannot go.
    expect((await h.del(`/api/project/${projectID}/group/main`)).status).toBe(400)
    expect((await h.del(`/api/project/${projectID}/group/review`)).status).toBe(200)
  })
})

describe('worktrees', () => {
  let worktreeID = ''
  let worktreePath = ''
  it('creates one with an auto branch, a session, and lands in main', async () => {
    const { status, body } = await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'probe' }))
    expect(status).toBe(200)
    worktreeID = body.worktree.id; worktreePath = body.worktree.path
    expect(body.worktree.group).toBe('main')
    expect(body.session.worktreeID).toBe(worktreeID)
    expect(existsSync(worktreePath)).toBe(true)
  })
  it('checks out an existing branch and forks from a base', async () => {
    const existing = await json(await h.post(`/api/project/${projectID}/worktree`, { branch: 'feature/one', checkoutExisting: true }))
    expect(existing.status).toBe(200)
    expect(existing.body.worktree.branch).toBe('feature/one')
    const forked = await json(await h.post(`/api/project/${projectID}/worktree`, { branch: 'forked', base: 'main' }))
    expect(forked.body.worktree.branch).toBe('forked')
    await h.del(`/api/worktree/${existing.body.worktree.id}`)
    await h.del(`/api/worktree/${forked.body.worktree.id}`)
  })
  it('reports git\'s reason when a branch does not exist', async () => {
    const { status, body } = await json(await h.post(`/api/project/${projectID}/worktree`, { branch: 'no/such', checkoutExisting: true }))
    expect(status).toBe(500)
    expect(body.error).toMatch(/does not exist|invalid reference|fatal/i)
  })
  it('renames, pins, archives; ignores unknown fields', async () => {
    const { body } = await json(await h.patch(`/api/worktree/${worktreeID}`, { name: 'renamed', isPinned: true, isMain: true, id: 'hack' }))
    expect(body.worktree.name).toBe('renamed'); expect(body.worktree.isPinned).toBe(true)
    expect(body.worktree.path).toBe(worktreePath); expect(body.worktree.isMain).toBe(false); expect(body.worktree.id).toBe(worktreeID)
    // A path that is not a checkout of this repository refuses the whole patch.
    expect((await h.patch(`/api/worktree/${worktreeID}`, { name: 'half applied', path: '/hack' })).status).toBe(400)
    expect((await json(await h.get('/api/state'))).body.worktrees.find((entry: any) => entry.id === worktreeID))
      .toMatchObject({ name: 'renamed', path: worktreePath })
    expect((await h.patch('/api/worktree/nope', {})).status).toBe(404)
    // The project's own checkout can never be archived, whoever asks.
    const refused = await json(await h.patch(`/api/worktree/${mainWorktreeID}`, { isArchived: true }))
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/own checkout/)
    const state = (await json(await h.get('/api/state'))).body
    expect(state.worktrees.find((entry: any) => entry.id === mainWorktreeID).isArchived).toBe(false)
  })
  it('gives info with a live branch and change count', async () => {
    const { body } = await json(await h.get(`/api/worktree/${worktreeID}/info`))
    expect(JSON.stringify(body)).toMatch(/orch\//)
    expect(JSON.stringify(body)).toMatch(/changedFiles/)
    expect((await h.get('/api/worktree/nope/info')).status).toBe(404)
  })
  it('moves between folders with git worktree move, and refuses for main', async () => {
    await h.post(`/api/project/${projectID}/group`, { name: 'review' })
    const moved = await json(await h.post(`/api/worktree/${worktreeID}/move`, { group: 'review' }))
    expect(moved.body.error ?? null).toBeNull()
    expect(moved.body.worktree.group).toBe('review')
    expect(moved.body.worktree.path).toContain('/review/')
    expect(existsSync(moved.body.worktree.path)).toBe(true)
    worktreePath = moved.body.worktree.path
    expect((await h.post(`/api/worktree/${mainWorktreeID}/move`, { group: 'review' })).status).toBe(400)
    expect((await h.post('/api/worktree/nope/move', { group: 'review' })).status).toBe(404)
  })
  it('moves current uncommitted work into a new worktree, keeping a conflicted stash', async () => {
    writeFileSync(join(h.repo, 'README.md'), '# dirty\n')
    const { body } = await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'carry', moveCurrentWork: true }))
    expect(readFileSync(join(body.worktree.path, 'README.md'), 'utf8')).toBe('# dirty\n')
    expect(readFileSync(join(h.repo, 'README.md'), 'utf8')).toBe('# probe\n')
    await h.del(`/api/worktree/${body.worktree.id}`)
    const clean = await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'nothing', moveCurrentWork: true }))
    expect(clean.body.warning ?? null).toBeNull()
    await h.del(`/api/worktree/${clean.body.worktree.id}`)
  })
  it('never deletes main; deletes a worktree from disk but keeps the branch; can keep on disk', async () => {
    expect((await h.del(`/api/worktree/${mainWorktreeID}`)).status).toBe(400)
    expect((await h.del('/api/worktree/nope')).status).toBe(404)
    const keep = await json(await h.post(`/api/project/${projectID}/worktree`, { name: 'kept' }))
    expect(keep.body.error ?? null).toBeNull()
    expect((await h.del(`/api/worktree/${keep.body.worktree.id}?keepOnDisk=1`)).status).toBe(200)
    expect(existsSync(keep.body.worktree.path)).toBe(true)
    rmSync(keep.body.worktree.path, { recursive: true, force: true })
    expect((await h.del(`/api/worktree/${worktreeID}`)).status).toBe(200)
    expect(existsSync(worktreePath)).toBe(false)
    const state = (await json(await h.get('/api/state'))).body
    expect(state.worktrees.some((entry: any) => entry.id === worktreeID)).toBe(false)
    expect(state.sessions.some((entry: any) => entry.worktreeID === worktreeID)).toBe(false)
    const branches = (await json(await h.get(`/api/branches?path=${encodeURIComponent(h.repo)}`))).body.branches
    expect(branches.some((name: string) => name.startsWith('orch/'))).toBe(true)
  })
})

describe('sessions', () => {
  let sessionID = ''
  it('creates, names itself from the first message, patches only allowed fields', async () => {
    const created = await json(await h.post(`/api/worktree/${mainWorktreeID}/session`, {}))
    sessionID = created.body.id
    expect(created.body.title).toBe('New session')
    expect((await h.post('/api/worktree/nope/session', {})).status).toBe(404)
    const patched = await json(await h.patch(`/api/session/${sessionID}`, { engine: 'codex', id: 'hack' }))
    expect(patched.body.engine).toBe('codex'); expect(patched.body.id).toBe(sessionID); expect(patched.body.worktreeID).toBe(mainWorktreeID)
    // A worktree that does not exist refuses the whole patch: nothing else in it lands either.
    expect((await h.patch(`/api/session/${sessionID}`, { title: 'half applied', worktreeID: 'hack' })).status).toBe(404)
    expect((await json(await h.get('/api/state'))).body.sessions.find((entry: any) => entry.id === sessionID))
      .toMatchObject({ title: 'New session', worktreeID: mainWorktreeID })
    expect((await h.patch('/api/session/nope', {})).status).toBe(404)
  })
  it('stores and returns a draft', async () => {
    expect((await h.put(`/api/session/${sessionID}/draft`, { text: 'half a thought' })).status).toBe(200)
    expect((await json(await h.get(`/api/session/${sessionID}/draft`))).body.text).toBe('half a thought')
    expect((await json(await h.get('/api/session/nope/draft'))).body.text).toBe('')
  })
  it('refuses an empty message and 404s an unknown session', async () => {
    expect((await h.post(`/api/session/${sessionID}/send`, { text: '  ' })).status).toBe(400)
    expect((await h.post('/api/session/nope/send', { text: 'x' })).status).toBe(404)
  })
  it('folds review comments into the prompt and names the session (engine binary absent is reported, not thrown)', async () => {
    process.env.ORCHESTRATOR_ENGINES_DIR = join(h.stateDir, 'no-engines'); mkdirSync(process.env.ORCHESTRATOR_ENGINES_DIR)
    const sent = await h.post(`/api/session/${sessionID}/send`, {
      text: 'please look at this', comments: [{ file: 'a.ts', line: 3, snippet: 'x', body: 'wrong' }],
    })
    expect(sent.status).toBe(200)
    const items = (await json(await h.get(`/api/transcript/${sessionID}`))).body
    expect(items[0].text).toContain('a.ts:3'); expect(items[0].text).toContain('wrong')
    expect(items.some((item: any) => item.role === 'error' && /Could not find/.test(item.text))).toBe(true)
    const state = (await json(await h.get('/api/state'))).body
    expect(state.sessions.find((entry: any) => entry.id === sessionID).title).toBe('Look at this')
  })
  it('stop is safe when nothing runs; attention is accepted', async () => {
    expect((await h.post(`/api/session/${sessionID}/stop`, {})).status).toBe(200)
    expect((await h.post('/api/attention', { sessionID, focused: true })).status).toBe(200)
  })
  it('deletes, and 404s a second time', async () => {
    expect((await h.del(`/api/session/${sessionID}`)).status).toBe(200)
    expect((await h.del(`/api/session/${sessionID}`)).status).toBe(404)
    expect((await h.get(`/api/transcript/${sessionID}`)).status).toBe(200)
  })
})

describe('git views', () => {
  it('diff splits tests from source, commits list, branches list', async () => {
    writeFileSync(join(h.repo, 'README.md'), '# changed\n')
    writeFileSync(join(h.repo, 'tests', 'test_a.py'), 'def test_a(): assert True\n')
    const diff = (await json(await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=uncommitted&context=3`))).body
    expect(diff.files.map((file: any) => file.path).sort()).toEqual(['README.md', 'tests/test_a.py'])
    for (const scope of ['staged', 'branch', 'remote']) {
      expect((await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=${scope}`)).status).toBe(200)
    }
    const commits = (await json(await h.get(`/api/commits?path=${encodeURIComponent(h.repo)}`))).body.commits
    expect(commits[0].subject).toBe('initial')
    expect((await h.get(`/api/diff?path=${encodeURIComponent(h.repo)}&scope=commit&sha=${commits[0].sha}`)).status).toBe(200)
    writeFileSync(join(h.repo, 'README.md'), '# probe\n')
    writeFileSync(join(h.repo, 'tests', 'test_a.py'), 'def test_a(): pass\n')
  })
  it('serves files inside a project and refuses everything else', async () => {
    expect((await json(await h.get(`/api/file?path=${encodeURIComponent(join(h.repo, 'README.md'))}`))).body.text).toContain('probe')
    expect((await h.get('/api/file?path=/etc/passwd')).status).toBe(403)
    expect((await h.get(`/api/file?path=${encodeURIComponent(join(h.repo, 'missing.txt'))}`)).status).toBe(404)
  })
})

describe('infra, skills, usage, settings, misc', () => {
  it('lists infra categories and refuses to read or write outside the roots', async () => {
    for (const category of ['claudemd', 'memories', 'hooks', 'skills', 'agents', 'commands']) {
      expect((await h.get(`/api/infra?category=${category}`)).status).toBe(200)
    }
    expect((await h.get('/api/infra/file?path=/etc/hosts')).status).toBe(403)
    expect((await h.put('/api/infra/file', { path: '/tmp/never.md', text: 'x' })).status).toBe(403)
    const target = join(h.repo, 'NOTES.md')
    const first = await json(await h.put('/api/infra/file', { path: target, text: 'one' }))
    expect(first.status).toBe(200)
    const stale = await h.put('/api/infra/file', { path: target, text: 'two', modified: first.body.modified - 5000 })
    expect(stale.status).toBe(409)
    expect((await json(await h.get(`/api/infra/file?path=${encodeURIComponent(target)}`))).body.text).toBe('one')
    expect((await h.get(`/api/infra/file?path=${encodeURIComponent(join(h.repo, 'nope.md'))}`)).status).toBe(404)
  })
  it('skills, usage, plan usage, voice status, lsp status, tasks all answer', async () => {
    expect(Array.isArray((await json(await h.get('/api/skills'))).body.skills)).toBe(true)
    const usage = (await json(await h.get('/api/usage'))).body
    expect(usage.pricing.opus.input).toBeGreaterThan(0)
    const plan = (await json(await h.get('/api/plan-usage'))).body
    expect('plan' in plan || 'error' in plan).toBe(true)
    expect(typeof (await json(await h.get('/api/voice/status'))).body.available).toBe('boolean')
    expect((await json(await h.get('/api/lsp/status?path=x.py'))).body.supported).toBe(true)
    expect((await json(await h.get('/api/lsp/status?path=x.txt'))).body.supported).toBe(false)
    expect((await json(await h.get('/api/tasks'))).body.tasks).toEqual([])
    expect((await h.del('/api/tasks/process/1')).status).toBe(403)
  })
  it('settings persist and price codex turns', async () => {
    const saved = (await json(await h.put('/api/settings', { codexPricing: { input: 2, cached: 0.2, output: 8 } }))).body
    expect(saved.codexPricing.input).toBe(2)
    expect((await json(await h.get('/api/settings'))).body.codexPricing.output).toBe(8)
  })
  it('voice refuses a non-WAV body', async () => {
    const response = await fetch(`${h.base}/api/voice/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', Origin: h.base }, body: 'not a wav',
    })
    expect([400, 500, 503]).toContain(response.status)
  })
  it('PR routes fail gracefully on a repo with no remote', async () => {
    // Without gh at all. The isolation layer only fills in variables a test deleted, so an
    // override has to be put back here or it leaks into every later file in this worker.
    const realBin = process.env.ORCHESTRATOR_BIN_DIR
    process.env.ORCHESTRATOR_BIN_DIR = join(h.stateDir, 'no-such-bin')
    const { resetGitHubCaches } = await import('../server/github.ts')
    resetGitHubCaches()
    const prs = (await json(await h.get(`/api/prs?project=${projectID}`))).body
    expect(prs.ok).toBe(false)
    const comments = (await json(await h.get(`/api/github/comments?project=${projectID}`))).body
    expect(comments.ok).toBe(false)
    expect((await h.get('/api/prs?project=nope')).status).toBe(404)
    expect((await h.get('/api/github/comments?project=nope')).status).toBe(404)
    expect((await h.post('/api/pr/review', { projectID: 'nope', prNumber: 1 })).status).toBe(404)
    expect((await h.post('/api/pr/review', { projectID, prNumber: 999999 })).status).toBe(500)
    expect((await h.post('/api/pr/autofix', { projectID, prNumber: 999999 })).status).toBe(500)
    process.env.ORCHESTRATOR_BIN_DIR = realBin
    resetGitHubCaches()
  })
})

describe('terminals', () => {
  it('opens, lists, is idempotent with ifNone, streams over the socket, closes', async () => {
    expect((await h.post('/api/worktree/nope/terminals', {})).status).toBe(404)
    const first = (await json(await h.post(`/api/worktree/${mainWorktreeID}/terminals`, { ifNone: true }))).body
    const again = (await json(await h.post(`/api/worktree/${mainWorktreeID}/terminals`, { ifNone: true }))).body
    expect(again.id).toBe(first.id)
    const second = (await json(await h.post(`/api/worktree/${mainWorktreeID}/terminals`, {}))).body
    expect(second.id).not.toBe(first.id)
    expect((await json(await h.get(`/api/worktree/${mainWorktreeID}/terminals`))).body.terminals).toHaveLength(2)

    const { default: WebSocket } = await import('ws')
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/terminal?id=${first.id}`, { headers: { Origin: h.base } })
    let output = ''
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
        setTimeout(() => socket.send(JSON.stringify({ type: 'input', data: 'echo TERM-PROBE-OK\r' })), 500)
        setTimeout(resolve, 2500)
      })
      socket.on('message', (data) => { output += data.toString() })
      socket.on('error', reject)
    })
    socket.close()
    expect(output).toMatch(/TERM-PROBE-OK/)

    const gone = new WebSocket(`ws://127.0.0.1:${h.port}/terminal?id=nope`, { headers: { Origin: h.base } })
    const code = await new Promise<number>((resolve) => gone.on('close', (value) => resolve(value)))
    expect(code).toBe(4004)

    expect((await json(await h.del(`/api/terminal/${first.id}`))).body.ok).toBe(true)
    expect((await json(await h.del(`/api/terminal/${second.id}`))).body.ok).toBe(true)
    expect((await json(await h.del('/api/terminal/nope'))).body.ok).toBe(false)
  })
})

describe('state socket', () => {
  it('sends state to its own origin and refuses a foreign one', async () => {
    const { default: WebSocket } = await import('ws')
    const own = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { Origin: h.base } })
    const first = await new Promise<any>((resolve, reject) => {
      own.on('message', (data) => resolve(JSON.parse(data.toString())))
      own.on('error', reject)
    })
    expect(first.type).toBe('state')
    own.close()
    const foreign = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { Origin: 'https://evil.example.com' } })
    const failure = await new Promise<string>((resolve) => foreign.on('error', (error) => resolve(error.message)))
    expect(failure).toMatch(/401/)
    const unknown = new WebSocket(`ws://127.0.0.1:${h.port}/nowhere`, { headers: { Origin: h.base } })
    const missing = await new Promise<string>((resolve) => unknown.on('error', (error) => resolve(error.message)))
    expect(missing).toMatch(/404/)
  })
})
