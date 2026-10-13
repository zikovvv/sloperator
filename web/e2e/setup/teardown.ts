import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Stops the server and Vite, then removes the run's folder: state, repositories and every temp file made in it. */
export default async function globalTeardown() {
  const runDir = process.env.E2E_RUN_DIR
  if (!runDir) return
  try {
    const info = JSON.parse(readFileSync(join(runDir, 'orch-e2e.json'), 'utf8'))
    for (const pid of [info.uiPid, info.serverPid]) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    for (const pid of [info.uiPid, info.serverPid]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  } catch { /* nothing was started */ }
  rmSync(runDir, { recursive: true, force: true })
}
