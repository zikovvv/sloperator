import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BIN = mkdtempSync(join(tmpdir(), 'gh-sweep-'))
const fakeGH = (body: string) => {
  writeFileSync(join(BIN, 'gh'), `#!/bin/bash\n${body}\n`)
  chmodSync(join(BIN, 'gh'), 0o755)
}

beforeEach(async () => {
  process.env.ORCHESTRATOR_BIN_DIR = BIN
  ;(await import('../server/github.ts')).resetGitHubCaches()
})
afterEach(() => { process.env.ORCHESTRATOR_BIN_DIR = join(process.cwd(), 'tests/fixtures/bin') })

describe('listMyPRComments on thin payloads', () => {
  it('reads a pull request with no reviews and no threads, and a payload with no search at all', async () => {
    fakeGH(`
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  echo '{"data":{"search":{"nodes":[{"number":5,"title":"t","headRefName":"h","comments":{"nodes":[{"id":"c","author":{"login":"alice"},"body":"look","url":"u","createdAt":"2026-01-01T00:00:00Z"}]}}]}}}'
  exit 0
fi
exit 2`)
    const { listMyPRComments, resetGitHubCaches } = await import('../server/github.ts')
    const withNothing = (await listMyPRComments('/tmp')) as any
    expect(withNothing.ok).toBe(true)
    expect(withNothing.comments.map((comment: any) => comment.id)).toEqual(['discussion-c'])

    fakeGH(`
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "me"; exit 0; fi
if [ "$1" = "repo" ]; then echo '{"owner":{"login":"o"},"name":"r"}'; exit 0; fi
echo '{"data":{}}'`)
    resetGitHubCaches()
    const empty = (await listMyPRComments('/tmp')) as any
    expect(empty.ok).toBe(true)
    expect(empty.comments).toEqual([])
  })
})
