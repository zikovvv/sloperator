#!/usr/bin/env node
// Asks the running Sloperator to do what its sidebar does, from any shell or agent.
//   sloperator                              lists the operations
//   sloperator list_workspace
//   sloperator update_session session="Fix login" title="Login fix" pinned=true
//   sloperator update_worktree '{"worktree":"feature/x","folder":"review"}'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const stateDir = process.env.ORCHESTRATOR_STATE_DIR ?? join(homedir(), 'Library/Application Support/ClaudeOrchestrator')

function serverURL() {
  if (process.env.SLOPERATOR_URL) return process.env.SLOPERATOR_URL
  try { return JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')).url } catch { return null }
}

/** key=value pairs, where true and false mean what they say; or one JSON object. */
function argumentsFrom(words) {
  if (words.length === 1 && words[0].startsWith('{')) return JSON.parse(words[0])
  return Object.fromEntries(words.map((word) => {
    const split = word.indexOf('=')
    if (split < 1) throw new Error(`Expected key=value, got "${word}"`)
    const value = word.slice(split + 1)
    return [word.slice(0, split), value === 'true' || value === 'false' ? value === 'true' : value]
  }))
}

async function main([operation, ...words]) {
  const url = serverURL()
  if (!url) throw new Error('Sloperator has not run here: no server.json in its state folder. Start the app, or set SLOPERATOR_URL.')
  const request = !operation || operation === 'help'
    ? fetch(`${url}/api/control`)
    : fetch(`${url}/api/control/${encodeURIComponent(operation)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(argumentsFrom(words)),
      })
  const reply = await request.catch(() => { throw new Error(`Sloperator is not answering at ${url}. Is the app running?`) })
  const answer = await reply.json()
  if (!reply.ok) throw new Error(answer.error)
  console.log(JSON.stringify(answer.result ?? answer, null, 2))
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
