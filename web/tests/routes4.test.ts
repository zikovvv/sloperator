import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from './helpers/server.ts'

let h: Harness
let worktreeID = ''
const json = async (response: Response) => ({ status: response.status, body: await response.json() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (await check()) return; await sleep(100) }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin')
  const staticRoot = join(process.env.TMPDIR ?? '/tmp', `static-${process.pid}`)
  mkdirSync(staticRoot, { recursive: true }); writeFileSync(join(staticRoot, 'index.html'), '<h1>packaged</h1>')
  process.env.SERVE_STATIC = staticRoot
  h = await startHarness()
  delete process.env.SERVE_STATIC
  mkdirSync(join(h.stateDir, 'engines'))
  symlinkSync(join(process.cwd(), 'tests/fixtures/engines/claude-crash'), join(h.stateDir, 'engines/claude'))
  process.env.ORCHESTRATOR_ENGINES_DIR = join(h.stateDir, 'engines')
  await h.post('/api/project', { path: h.repo })
  worktreeID = (await json(await h.get('/api/state'))).body.worktrees.find((entry: any) => entry.isMain).id
})
afterAll(async () => { await h.stop() })

describe('a crashing engine', () => {
  it('truncates huge tool output, ignores an orphan result and junk lines, reports the exit code with stderr', async () => {
    const session = (await json(await h.post(`/api/worktree/${worktreeID}/session`, {}))).body
    await h.patch(`/api/session/${session.id}`, { engine: 'claude' })
    const { default: WebSocket } = await import('ws')
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { Origin: h.base } })
    const events: any[] = []
    socket.on('message', (data) => events.push(JSON.parse(data.toString())))
    await new Promise((resolve) => socket.on('open', resolve))
    await h.post(`/api/session/${session.id}/send`, { text: 'go' })
    await waitFor(async () => (await json(await h.get(`/api/transcript/${session.id}`))).body.some((item: any) => /exited with status 2/.test(item.text ?? '')))
    const items = (await json(await h.get(`/api/transcript/${session.id}`))).body
    const tool = items.find((item: any) => item.role === 'tool')
    expect(tool.toolOutput.length).toBeLessThan(40100); expect(tool.toolOutput).toMatch(/truncated/)
    expect(items.some((item: any) => item.text === 'partial')).toBe(true)
    const exit = items.find((item: any) => /exited with status 2/.test(item.text ?? ''))
    expect(exit.text).toMatch(/something went badly wrong/)
    expect(events.some((event) => event.type === 'patch' && event.sessionID === session.id)).toBe(true)
    socket.close()
  })
  it('serves the packaged UI from the same origin when SERVE_STATIC is set', async () => {
    const page = await h.get('/')
    expect(page.status).toBe(200); expect(await page.text()).toContain('packaged')
  })
})
