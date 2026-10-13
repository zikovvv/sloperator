import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { agentEnv, binary } from './engines.ts'

interface Server {
  command: string
  args: string[]
  languageId: string
}

function serverFor(path: string): Server | null {
  const extension = String(path.split('.').pop()).toLowerCase()
  if (['py', 'pyi'].includes(extension)) {
    return { command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' }
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return {
      command: 'typescript-language-server', args: ['--stdio'],
      languageId: extension.startsWith('t') ? 'typescript' : 'javascript',
    }
  }
  return null
}

function resolve(command: string): string | null {
  if (process.env.ORCHESTRATOR_BIN_DIR) {
    const candidate = binary(command)
    return existsSync(candidate) ? candidate : null
  }
  for (const directory of String(agentEnv().PATH).split(':')) {
    const candidate = join(directory, command)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** One long-lived language server per (workspace, binary), speaking JSON-RPC over stdio. */
class Client {
  private child: ChildProcess
  private buffer = Buffer.alloc(0)
  private nextID = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private openDocuments = new Map<string, number>()
  ready: Promise<void>

  constructor(private workspace: string, executable: string, args: string[]) {
    this.child = spawn(executable, args, { cwd: workspace, env: agentEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout!.on('data', (chunk: Buffer) => this.consume(chunk))
    this.child.on('exit', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('language server exited'))
      this.pending.clear()
    })
    this.ready = this.initialize()
  }

  get alive() { return !this.child.killed && this.child.exitCode === null }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n')
      if (separator < 0) return
      const header = this.buffer.subarray(0, separator).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      const start = separator + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let message: any
      try { message = JSON.parse(body) } catch { continue }
      if (message.id != null && message.method == null) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (!entry) continue
        message.error ? entry.reject(new Error(message.error.message ?? 'LSP error'))
                      : entry.resolve(message.result)
      } else if (message.id != null && message.method) {
        // Answer server-to-client requests generically so it never stalls.
        const result = message.method === 'workspace/configuration'
          ? (message.params?.items ?? [{}]).map(() => ({})) : null
        this.write({ jsonrpc: '2.0', id: message.id, result })
      }
    }
  }

  private write(message: unknown) {
    const body = JSON.stringify(message)
    this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Every request has a deadline: an indexing server may simply never answer. */
  private request(method: string, params: unknown, timeout = 8000): Promise<any> {
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private async initialize() {
    const uri = pathToFileURL(this.workspace).href
    await this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: this.workspace.split('/').pop() }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          synchronization: { didSave: true },
        },
        workspace: { configuration: true },
      },
    }, 20000)
    this.notify('initialized', {})
  }

  sync(path: string, languageId: string) {
    const uri = pathToFileURL(path).href
    const text = readFileSync(path, 'utf8')
    const version = (this.openDocuments.get(uri) ?? 0) + 1
    this.openDocuments.set(uri, version)
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
    } else {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version }, contentChanges: [{ text }],
      })
    }
    return uri
  }

  async definition(uri: string, line: number, character: number) {
    const result = await this.request('textDocument/definition', {
      textDocument: { uri }, position: { line, character },
    })
    const entries = Array.isArray(result) ? result : result ? [result] : []
    return entries.map((entry: any) => {
      const target = entry.uri ?? entry.targetUri
      const range = entry.range ?? entry.targetSelectionRange
      if (!target || !range) return null
      return {
        path: fileURLToPath(target),
        line: range.start.line + 1,
        character: range.start.character,
      }
    }).filter(Boolean)
  }

  async references(uri: string, line: number, character: number) {
    const result = await this.request('textDocument/references', {
      textDocument: { uri }, position: { line, character }, context: { includeDeclaration: true },
    })
    return (Array.isArray(result) ? result : []).map((entry: any) => ({
      path: fileURLToPath(entry.uri),
      line: entry.range.start.line + 1,
      character: entry.range.start.character,
    }))
  }

  async hover(uri: string, line: number, character: number): Promise<string | null> {
    const result = await this.request('textDocument/hover', {
      textDocument: { uri }, position: { line, character },
    })
    const contents = result?.contents
    if (!contents) return null
    if (typeof contents === 'string') return contents
    if (Array.isArray(contents)) {
      return contents.map((part: any) => (typeof part === 'string' ? part : part?.value)).filter(Boolean).join('\n\n')
    }
    return contents.value ?? null
  }

  stop() { this.child.kill('SIGTERM') }
}

const clients = new Map<string, Client>()
const starting = new Map<string, Promise<Client | null>>()

async function clientFor(workspace: string, path: string) {
  const server = serverFor(path)
  if (!server) return null
  const key = `${workspace}|${server.command}`
  const existing = clients.get(key)
  if (existing?.alive) return { client: existing, languageId: server.languageId }

  // A burst of hovers must await the same startup, not spawn a pyright each.
  let pending = starting.get(key)
  if (!pending) {
    const executable = resolve(server.command)
    if (!executable) return null
    pending = (async () => {
      const client = new Client(workspace, executable, server.args)
      try { await client.ready; clients.set(key, client); return client }
      catch { client.stop(); return null }
      finally { starting.delete(key) }
    })()
    starting.set(key, pending)
  }
  const client = await pending
  return client ? { client, languageId: server.languageId } : null
}

export function lspStatus(path: string) {
  const server = serverFor(path)
  if (!server) return { supported: false, installed: false, command: null as string | null }
  return { supported: true, installed: !!resolve(server.command), command: server.command }
}

export async function definition(workspace: string, path: string, line: number, character: number) {
  const entry = await clientFor(workspace, path)
  if (!entry) {
    const status = lspStatus(path)
    return { locations: [], error: status.supported && !status.installed ? `${status.command} is not installed` : null }
  }
  const uri = entry.client.sync(path, entry.languageId)
  try {
    return { locations: await entry.client.definition(uri, line, character), error: null }
  } catch (error) {
    return { locations: [], error: (error as Error).message }
  }
}

/** Every place a symbol is used — the same answer an editor's "find usages" gives. */
export async function references(workspace: string, path: string, line: number, character: number) {
  const entry = await clientFor(workspace, path)
  if (!entry) {
    const status = lspStatus(path)
    return { locations: [], error: status.supported && !status.installed ? `${status.command} is not installed` : null }
  }
  const uri = entry.client.sync(path, entry.languageId)
  try {
    return { locations: await entry.client.references(uri, line, character), error: null }
  } catch (error) {
    return { locations: [], error: (error as Error).message }
  }
}

export async function hover(workspace: string, path: string, line: number, character: number) {
  const entry = await clientFor(workspace, path)
  if (!entry) return { text: null, error: null }
  const uri = entry.client.sync(path, entry.languageId)
  try {
    return { text: await entry.client.hover(uri, line, character), error: null }
  } catch (error) {
    return { text: null, error: (error as Error).message }
  }
}

export function stopAllLanguageServers() {
  for (const client of clients.values()) client.stop()
  clients.clear()
}
