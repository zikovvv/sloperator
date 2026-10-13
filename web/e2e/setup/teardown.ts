import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default async function globalTeardown() {
  try {
    const info = JSON.parse(readFileSync(join(tmpdir(), 'orch-e2e.json'), 'utf8'))
    for (const pid of [info.uiPid, info.serverPid]) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    for (const pid of [info.uiPid, info.serverPid]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    rmSync(info.stateDir, { recursive: true, force: true })
    rmSync(info.repo, { recursive: true, force: true })
  } catch { /* nothing to tear down */ }
}
