import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const FAKE_BIN = join(process.cwd(), 'tests/fixtures/bin')

describe('lsp leftovers', () => {
  afterEach(async () => { (await import('../server/lsp.ts')).stopAllLanguageServers(); process.env.ORCHESTRATOR_BIN_DIR = FAKE_BIN })

  it('maps js/jsx to javascript, resolves through PATH without the override, and returns null for a server that dies', async () => {
    const { lspStatus, definition } = await import('../server/lsp.ts')
    delete process.env.ORCHESTRATOR_BIN_DIR
    expect(lspStatus('x.jsx').command).toBe('typescript-language-server')
    expect(typeof lspStatus('x.py').installed).toBe('boolean')   // real PATH lookup
    const dir = mkdtempSync(join(tmpdir(), 'lsp-dead-'))
    writeFileSync(join(dir, 'pyright-langserver'), '#!/bin/bash\nexit 3\n'); chmodSync(join(dir, 'pyright-langserver'), 0o755)
    process.env.ORCHESTRATOR_BIN_DIR = dir
    const workspace = mkdtempSync(join(tmpdir(), 'ws-')); writeFileSync(join(workspace, 'a.py'), 'x = 1\n')
    const [first, second] = await Promise.all([definition(workspace, join(workspace, 'a.py'), 0, 0), definition(workspace, join(workspace, 'a.py'), 0, 0)])
    expect(first.locations).toEqual([]); expect(second.locations).toEqual([])
  }, 30_000)

  it('ignores malformed frames, unknown ids, answers arbitrary server requests, handles errors without a message and string hovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-odd-'))
    writeFileSync(join(dir, 'pyright-langserver'), `#!/usr/bin/env python3
import sys, json
def read():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        if line in (b"\\r\\n", b"\\n"): break
        k, v = line.decode().split(":", 1); headers[k.strip().lower()] = v.strip()
    return json.loads(sys.stdin.buffer.read(int(headers["content-length"])))
def raw(body):
    sys.stdout.buffer.write(b"Content-Length: %d\\r\\n\\r\\n" % len(body) + body); sys.stdout.buffer.flush()
def write(msg): raw(json.dumps(msg).encode())
while True:
    m = read()
    if m is None: break
    method = m.get("method")
    if method == "initialize":
        raw(b"{not json")
        write({"jsonrpc":"2.0","id":999,"result":"nobody asked"})
        write({"jsonrpc":"2.0","id":7001,"method":"client/registerCapability","params":{}})
        write({"jsonrpc":"2.0","id":m["id"],"result":{}})
    elif method == "textDocument/definition":
        write({"jsonrpc":"2.0","id":m["id"],"error":{}})
    elif method == "textDocument/hover":
        write({"jsonrpc":"2.0","id":m["id"],"result":{"contents":"just text"}})
    elif "id" in m:
        write({"jsonrpc":"2.0","id":m["id"],"result":None})
`); chmodSync(join(dir, 'pyright-langserver'), 0o755)
    process.env.ORCHESTRATOR_BIN_DIR = dir
    const { definition, hover } = await import('../server/lsp.ts')
    const workspace = mkdtempSync(join(tmpdir(), 'ws-')); writeFileSync(join(workspace, 'a.py'), 'x = 1\n')
    expect((await definition(workspace, join(workspace, 'a.py'), 0, 0)).error).toBe('LSP error')
    expect((await hover(workspace, join(workspace, 'a.py'), 0, 0)).text).toBe('just text')
  }, 30_000)
})

describe('planUsage leftovers', () => {
  it('treats a keychain entry without a token as not signed in, and fills missing limit fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'))
    writeFileSync(join(dir, 'security'), '#!/bin/bash\necho "{}"\n'); chmodSync(join(dir, 'security'), 0o755)
    process.env.ORCHESTRATOR_BIN_DIR = dir
    const { planUsage, resetPlanUsageCache } = await import('../server/planUsage.ts')
    resetPlanUsageCache()
    expect(((await planUsage()) as any).error).toMatch(/Not signed in/)
    process.env.ORCHESTRATOR_BIN_DIR = FAKE_BIN
    const { createServer } = await import('node:http')
    const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ limits: [{ kind: 'session', group: 'session' }], extra_usage: {} })) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.ORCHESTRATOR_USAGE_URL = `http://127.0.0.1:${(server.address() as any).port}/`
    resetPlanUsageCache()
    const result = (await planUsage()) as any
    expect(result.limits[0]).toMatchObject({ percent: 0, resetsAt: null, isActive: false })
    expect(result.extra).toMatchObject({ enabled: false, usedUSD: 0, limitUSD: 0, percent: 0, disabledReason: null })
    server.close(); delete process.env.ORCHESTRATOR_USAGE_URL
  })
})

describe('voice leftovers', () => {
  it('looks up whisper and the model through the real PATH and default locations when unseamed', async () => {
    const savedBin = process.env.ORCHESTRATOR_BIN_DIR; const savedModel = process.env.ORCHESTRATOR_WHISPER_MODEL
    delete process.env.ORCHESTRATOR_BIN_DIR; delete process.env.ORCHESTRATOR_WHISPER_MODEL
    const { voiceStatus } = await import('../server/voice.ts')
    const status = voiceStatus()
    expect(typeof status.available).toBe('boolean')
    process.env.ORCHESTRATOR_BIN_DIR = savedBin; if (savedModel) process.env.ORCHESTRATOR_WHISPER_MODEL = savedModel
  })
})
