import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { writeRunningRecord } from '../server/orphans.ts'
import { RUNNING_RECORD } from '../server/state.ts'
import { startHarness } from './helpers/server.ts'

const json = async (response: Response) => response.json()
const until = async <T,>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('the server over its whole life', () => {
  it('escalates to SIGKILL for an agent that ignores the polite signals, and stops there for one that listens', async () => {
    process.env.ORCHESTRATOR_KILL_GRACE_MS = '150'
    const h = await startHarness()
    try {
      await h.post('/api/project', { path: h.repo })
      const mainID = (await json(await h.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
      const session = async (text: string) => {
        const created = await json(await h.post(`/api/worktree/${mainID}/session`, {}))
        await h.patch(`/api/session/${created.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
        await h.post(`/api/session/${created.id}/send`, { text })
        const [task] = await until(async () => (await json(await h.get('/api/tasks'))).tasks,
          (all: any[]) => all.some((task) => task.sessionID === created.id), 'the agent')
        return { id: created.id as string, pid: task.pid as number }
      }
      const stubborn = await session('STUBBORN')
      await h.post(`/api/session/${stubborn.id}/stop`, {})
      await until(async () => alive(stubborn.pid), (still) => !still, 'the stubborn agent to be killed', 5000)
      const polite = await session('SLOW')
      await h.post(`/api/session/${polite.id}/stop`, {})
      await until(async () => alive(polite.pid), (still) => !still, 'the polite agent to go', 5000)
      await sleep(600)   // both escalation timers fire and find nothing to do
      expect((await h.get('/api/state')).status).toBe(200)
    } finally {
      delete process.env.ORCHESTRATOR_KILL_GRACE_MS
      await h.stop()
    }
  })

  it('kills an orphan of a previous run even when its session is no longer known, and clears its sockets and agents when it stops', async () => {
    const first = await startHarness()
    await first.post('/api/project', { path: first.repo })
    const mainID = (await json(await first.get('/api/state'))).worktrees.find((entry: any) => entry.isMain).id
    const created = await json(await first.post(`/api/worktree/${mainID}/session`, {}))
    await first.patch(`/api/session/${created.id}`, { engine: 'claude', accessMode: 'edits', steeringMode: 'queue' })
    await first.post(`/api/session/${created.id}/send`, { text: 'STALL' })
    const [task] = await until(async () => (await json(await first.get('/api/tasks'))).tasks, (all: any[]) => all.length > 0, 'the agent')
    const socket = new WebSocket(`ws://127.0.0.1:${first.port}/ws`, { headers: { Origin: first.base } })
    await new Promise<void>((resolve) => socket.on('open', () => resolve()))
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
    await first.stop()
    await closed
    await until(async () => alive(task.pid), (still) => !still, 'the agent to be killed with the server', 5000)

    // The same state directory, a record of a "running" agent whose session was never known here.
    const ghost = spawn('sleep', ['30'], { stdio: 'ignore' })
    writeRunningRecord(RUNNING_RECORD, { ghost: ghost.pid! })   // the record every server of this file reads
    const { startServer } = await import('../server/app.ts')
    const second = await startServer({ background: true, signals: true })   // the port comes from the environment: 0 under test
    try {
      await until(async () => alive(ghost.pid!), (still) => !still, 'the orphan to be killed', 5000)
      const origin = `http://127.0.0.1:${second.port}`
      expect((await fetch(`${origin}/api/state`, { headers: { Origin: origin } })).status).toBe(200)
      // A signal winds everything down and leaves; Electron calls the same wind-down without leaving.
      const handlers = process.listeners('SIGINT')
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      try {
        ;(handlers[handlers.length - 1] as () => void)()
        expect(exit).toHaveBeenCalledWith(0)
      } finally { exit.mockRestore() }
      ;(globalThis as Record<string, unknown> & { orchestratorShutdown: () => void }).orchestratorShutdown()
    } finally { await second.stop() }
  })
})
