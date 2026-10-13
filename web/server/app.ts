import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, isAbsolute } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { BackgroundTask, ServerEvent, Session, SessionActivity, TranscriptItem, Project, Worktree, FinishedTool, LayerPR, LayerResult, Stack } from '../shared/types.ts'
import { subagentTranscripts } from './agents.ts'
import {
  loadState, saveState, loadTranscript, saveTranscript, RUNNING_RECORD, type AppState,
} from './state.ts'
import { pidIsAlive, readRunningRecord, reapOrphans, writeRunningRecord } from './orphans.ts'
import * as gitService from './git.ts'
import { snapshotTree } from './git.ts'
import { parseDiff } from './diff.ts'
import { infraItems, readInfraFile, writeInfraFile, skillCatalog, type InfraCategory } from './infra.ts'
import { usageReport } from './usage.ts'
import { planUsage } from './planUsage.ts'
import { codexPlanUsage, codexRates, codexUsageReport } from './codexUsage.ts'
import {
  failureText, listMyPRComments, mergePullRequest, openPullRequestFor, postLineComment, preferredMergeMethod,
  pullRequestBase, pullRequestBaseFor, pullRequestConversations, retargetPullRequest, reviewerCommand,
} from './github.ts'
import { PRCache } from './prCache.ts'
import { descendantsOf, processTable } from './processes.ts'
import { openStackPRs, updateLayers } from './stacks.ts'
import { modelCatalog } from './models.ts'
import { browseHome, listFolders } from './folders.ts'
import * as worktreeService from './worktrees.ts'
import { transcribe, voiceStatus } from './voice.ts'
import { definition, hover, lspStatus, references, stopAllLanguageServers } from './lsp.ts'
import { closeAllTerminals, closeTerminal, getTerminal, listTerminals, openTerminal } from './terminals.ts'
import { allowedRoots, fetchSiteIsAllowed, hostIsLocal, isInsideAny, originIsAllowed } from './guard.ts'
import { approveTool, askUserAnswer, handleMCP, PermissionBroker, PROMPT_SERVER, renameTool, type MCPTool } from './permissions.ts'
import { CONTROL_OPERATIONS, runControl, type ControlContext } from './control.ts'
import type { PermissionDecision, PermissionRequest } from '../shared/types.ts'
import { bridgePrompt, composePrompt, parseComments } from './compose.ts'
import { isWatching, notify, setAttention, type Notice } from './notify.ts'
import { AUTO_TITLE_MESSAGES, DEFAULT_SESSION_TITLE, generateTitle, titleFromMessage, titlePrompt } from './titles.ts'
import {
  claudeArgs, codexArgs, killTree, parseClaudeLine, parseCodexLine, spawnAgent, agentEnv,
  type AgentEvent, type Usage,
} from './engines.ts'

export interface ServerOptions {
  /** 0 picks a free port; tests use that. */
  port?: number
  /** Skip the GitHub comment poller (tests, or an offline machine). */
  background?: boolean
  /** Skip installing SIGINT/SIGTERM handlers (tests own the process). */
  signals?: boolean
}

/** Builds and starts the orchestrator server. The CLI entry calls it once; tests call it per suite. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
}

/** Where an engine binary is looked for: the fake engines under test, otherwise the agent's PATH. */
export function enginePaths(): string[] {
  return process.env.ORCHESTRATOR_ENGINES_DIR
    ? [process.env.ORCHESTRATOR_ENGINES_DIR]
    : String(agentEnv().PATH).split(':')   // agentEnv always sets one
}

/** A socket between its close frame and its close event refuses writes; nothing to do about that. */
const ignoreSendError = () => {}

/** Background work that failed has nobody to answer to; the log is where it goes. */
export function reportFailure(error: unknown) {
  console.error('[orchestrator]', error)
}

/** The port the app listens on when nobody says otherwise. */
export function defaultPort(): number {
  return Number(process.env.PORT ?? 8787)
}

export async function startServer(options: ServerOptions) {
  // `let`: with port 0 the real port is only known after listen, and the guard must use it.
  let PORT = options.port ?? defaultPort()
  const state: AppState = loadState()
  const transcripts = new Map<string, TranscriptItem[]>()
  interface InFlightTool { name: string; detail: string; startedAt: number; input?: unknown }
  /** A turn in progress. It always has a pid: a spawn that failed is never tracked here. */
  const running = new Map<string, {
    session: Session; child: ChildProcess; pid: number; engine: Session['engine']; toolItems: Map<string, string>
    /** What the agent left running behind the turn, and how often it was told not to end the turn on it. */
    background: BackgroundTask[]; stopsRefused: number
    inFlight: Map<string, InFlightTool>; finished: FinishedTool[]; startedAt: number
  }>()
  /** What the last turn of each session ran, kept for the panel once the turn is over. */
  const lastFinished = new Map<string, FinishedTool[]>()
  const FINISHED_KEPT = 40
  const clients = new Set<WebSocket>()

  for (const session of state.sessions) transcripts.set(session.id, loadTranscript(session.id))

  /** Mirror of `running` on disk, so a crashed or restarted server can find its agents again. */
  /**
   * Interrupts an agent the way a terminal would, then escalates: SIGINT for a graceful stop,
   * SIGTERM if it is still there after two seconds, SIGKILL after six. A single SIGINT is
   * ignored by anything mid-command, and the turn then runs to completion as if nothing happened.
   */
  /** Sessions whose turn we cut short on purpose: what the engine says on its way out is not an error. */
  const interrupted = new Set<string>()

  // Claude Code brings every permission prompt and every question here, through a per-turn URL
  // only that turn knows. The request shows up in the chat and waits for the person's answer.
  const broker = new PermissionBroker()
  const promptTokens = new Map<string, string>()   // token -> session
  /** A request still waiting for the person; its permission object is the one inside the transcript item. */
  type Asked = { sessionID: string; itemID: string; permission: PermissionRequest }
  const permissionItems = new Map<string, Asked>()
  /** Which sessions are running, and which of them are waiting on the person. */
  function pushRunning() {
    broadcast({ type: 'running', sessionIDs: [...running.keys()],
                asking: [...new Set([...permissionItems.values()].map((entry) => entry.sessionID))] })
  }
  function settlePermission(requestID: string, asked: Asked, changes: Partial<PermissionRequest>) {
    permissionItems.delete(requestID)
    pushRunning()
    const items = transcripts.get(asked.sessionID)
    if (!items) return   // the session was deleted while it was asking
    Object.assign(asked.permission, changes)
    saveTranscript(asked.sessionID, items)
    broadcast({ type: 'permission', sessionID: asked.sessionID, itemID: asked.itemID, permission: asked.permission })
  }

  // How long a stopped agent gets to finish on its own before the harder signals; tests shorten it.
  const KILL_GRACE_MS = Number(process.env.ORCHESTRATOR_KILL_GRACE_MS ?? 2000)
  function interrupt(pid: number, sessionID: string) {
    interrupted.add(sessionID)
    killTree(pid, 'SIGINT')
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    setTimeout(() => { if (alive()) killTree(pid, 'SIGTERM') }, KILL_GRACE_MS).unref()
    setTimeout(() => { if (alive()) killTree(pid, 'SIGKILL') }, KILL_GRACE_MS * 3).unref()
  }

  function recordRunning() {
    const record: Record<string, number> = {}
    for (const [sessionID, active] of running) record[sessionID] = active.pid
    writeRunningRecord(RUNNING_RECORD, record)
  }

  // Agents from a previous instance have nobody reading their output: kill them and say so.
  for (const sessionID of reapOrphans(readRunningRecord(RUNNING_RECORD), pidIsAlive,
                                      (pid) => killTree(pid, 'SIGKILL'))) {
    if (!transcripts.has(sessionID)) continue
    const items = transcripts.get(sessionID)!
    items.push({
      id: crypto.randomUUID(), role: 'error', timestamp: Date.now(),
      text: 'This turn was interrupted by an app restart. Send your message again to continue.',
    })
    saveTranscript(sessionID, items)
  }
  writeRunningRecord(RUNNING_RECORD, {})

  function broadcast(event: ServerEvent) {
    const payload = JSON.stringify(event)
    for (const client of clients) client.send(payload, ignoreSendError)
  }

  function raise(notice: Notice) {
    notify(notice, (payload) => broadcast({ type: 'notify', notice: payload }))
  }

  /** The branch a worktree is on is git's answer, not ours: an agent may switch it any time. */
  async function refreshBranches(): Promise<boolean> {
    const label = (branch?: string | null) => (branch ?? '').replace(/^orch\//, '')
    const seen = await Promise.all(state.worktrees.map(async (worktree) => {
      const branch = existsSync(worktree.path) ? await gitService.currentBranch(worktree.path) : null
      if (branch === worktree.branch) return false
      // A worktree still carrying its branch's own label was never named by hand: let it follow.
      if (branch && worktree.name === label(worktree.branch)) worktree.name = label(branch)
      worktree.branch = branch
      return true
    }))
    return seen.some(Boolean)
  }

  /** A layer's open pull request, from the PR list already fetched: by its head branch or its review checkout. */
  function layerPR(worktree: Worktree | undefined): LayerPR | null {
    if (!worktree?.branch) return null
    const pr = prCache.peek(worktree.projectID).find((candidate) => (candidate.state === 'open' || candidate.state === 'draft')
      && (candidate.headRefName === worktree.branch || `orch/pr-${candidate.number}` === worktree.branch))
    return pr ? { number: pr.number, url: pr.url, state: pr.state } : null
  }

  function stateEvent(): Extract<ServerEvent, { type: 'state' }> {
    const stacks = state.stacks.map((stack) => ({
      ...stack, prs: stack.layers.map((id) => layerPR(state.worktrees.find((worktree) => worktree.id === id))),
    }))
    return { type: 'state', projects: state.projects, worktrees: state.worktrees, sessions: state.sessions, stacks }
  }

  function pushState() {
    broadcast(stateEvent())
    void refreshBranches().then((changed) => {
      if (!changed) return
      saveState(state)
      broadcast(stateEvent())
    }).catch(reportFailure)
    pushRunning()
  }

  /** A session's transcript; one is started the first time it is asked for. */
  function itemsOf(sessionID: string): TranscriptItem[] {
    const items = transcripts.get(sessionID) ?? []
    transcripts.set(sessionID, items)
    return items
  }
  const queuedFor = (sessionID: string) => state.queuedMessages[sessionID] ?? []

  function append(sessionID: string, item: Omit<TranscriptItem, 'id' | 'timestamp'>) {
    const full: TranscriptItem = { ...item, id: crypto.randomUUID(), timestamp: Date.now() }
    const items = itemsOf(sessionID)
    items.push(full)
    saveTranscript(sessionID, items)
    broadcast({ type: 'append', sessionID, item: full })
    return full
  }

  function findExecutable(name: string): string | null {
    for (const directory of enginePaths()) {
      const candidate = `${directory}/${name}`
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /** A session's worktree: deleting a worktree deletes its sessions, so it is always there. */
  function worktreeFor(session: Session): Worktree {
    return state.worktrees.find((worktree) => worktree.id === session.worktreeID)!
  }
  /** A worktree's project, for the same reason. */
  function projectFor(worktree: Worktree): Project {
    return state.projects.find((candidate) => candidate.id === worktree.projectID)!
  }
  /**
   * What a worktree's branch is measured against: the base of its open pull request when GitHub
   * knows one (a stacked PR is opened against another branch, not main), else what it forked from.
   * The branch is read from git, not the record: a checkout changes under a running server.
   */
  /** A worktree not named by hand is called what its first named session is about; the main checkout keeps its folder's name. */
  function inheritWorktreeName(session: Session): boolean {
    const worktree = worktreeFor(session)
    const first = state.sessions.find((candidate) => candidate.worktreeID === worktree.id && !candidate.isArchived
      && candidate.title !== DEFAULT_SESSION_TITLE)
    if (worktree.isMain || worktree.nameIsManual || first !== session || worktree.name === session.title) return false
    worktree.name = session.title
    return true
  }

  function setTitle(session: Session, title: string) {
    session.title = title
    const renamed = inheritWorktreeName(session)
    saveState(state)
    broadcast({ type: 'session', session })
    if (renamed) pushState()
  }

  // Naming calls run one at a time, and only the newest request for a session is applied.
  let namingQueue: Promise<unknown> = Promise.resolve()
  const namingRound = new Map<string, number>()
  function nameSession(session: Session, withReply: boolean): Promise<string | null> {
    const executable = findExecutable('claude')
    const items = itemsOf(session.id)
    const messages = items.filter((item) => item.role === 'user').map((item) => item.text)
    if (!executable || !messages.length) return Promise.resolve(null)
    const round = (namingRound.get(session.id) ?? 0) + 1
    namingRound.set(session.id, round)
    const reply = withReply ? [...items].reverse().find((item) => item.role === 'assistant')?.text ?? null : null
    const prompt = titlePrompt(messages, reply)
    const run = namingQueue.then(async () => {
      const title = await generateTitle(executable, prompt)
      // A newer request, a name typed meanwhile, or a deleted session: this answer is no longer wanted.
      if (!title || namingRound.get(session.id) !== round || session.titleIsManual || !state.sessions.includes(session)) return null
      setTitle(session, title)
      return title
    })
    namingQueue = run.catch(reportFailure)
    return run
  }

  /** A rename the person asked for in the chat: the title they gave, or one Claude picks from the conversation. */
  async function renameByRequest(sessionID: string, title: string | null): Promise<string> {
    const session = state.sessions.find((candidate) => candidate.id === sessionID)!
    if (title) {
      session.titleIsManual = true
      setTitle(session, title.slice(0, 80))
    } else {
      const wasManual = session.titleIsManual
      session.titleIsManual = false
      if (!(await nameSession(session, true))) {
        session.titleIsManual = wasManual
        append(sessionID, { role: 'info', text: 'Could not get a name from Claude for this session.' })
        return 'No name could be chosen for this session. Ask the person what to call it.'
      }
    }
    append(sessionID, { role: 'info', text: `Session renamed to “${session.title}”` })
    return `Renamed this session to "${session.title}".`
  }

  async function baseFor(worktree: Worktree): Promise<string | null> {
    const branch = await gitService.currentBranch(worktree.path)
    return pullRequestBaseFor(branch, prCache.peek(worktree.projectID)) ?? worktree.baseBranch
  }

  /** Everything the engine emits, applied to the session and pushed to the UI. */
  function applyEvent(session: Session, event: AgentEvent, toolItems: Map<string, string>) {
    switch (event.type) {
      case 'backend':
        if (session.engine === 'claude') session.claudeSessionID = event.id
        else session.codexThreadID = event.id
        saveState(state)
        broadcast({ type: 'session', session })
        break
      case 'assistant':
        append(session.id, { role: 'assistant', text: event.text, engine: session.engine })
        break
      case 'thinking':
        append(session.id, { role: 'thinking', text: event.text, engine: session.engine })
        break
      case 'toolStart': {
        running.get(session.id)?.inFlight.set(event.id, { name: event.name, detail: event.detail, input: event.input, startedAt: Date.now() })
        const item = append(session.id, {
          role: 'tool', text: event.detail, toolName: event.name, toolInput: event.input, engine: session.engine,
        })
        toolItems.set(event.id, item.id)
        break
      }
      case 'info':
        append(session.id, { role: 'info', text: event.text })
        break
      case 'toolEnd': {
        // A tool that ended while its approval was still shown was given up on by the engine: close the card.
        for (const [requestID, asked] of permissionItems) {
          if (asked.sessionID === session.id && asked.permission.toolUseID === event.id) {
            broker.giveUp(requestID, 'Claude stopped waiting for this answer.')
          }
        }
        const active = running.get(session.id)
        const started = active?.inFlight.get(event.id)
        if (active && started) {
          active.inFlight.delete(event.id)
          const output = event.output ?? (event.failed ? 'failed' : '')
          active.finished = [...active.finished, { id: event.id, ...started, endedAt: Date.now(), failed: event.failed,
            output: output.length > 4000 ? `${output.slice(0, 4000)}\n…(more in the chat)` : output }].slice(-FINISHED_KEPT)
        }
        const itemID = toolItems.get(event.id)
        if (!itemID) break
        const items = itemsOf(session.id)
        const target = items.find((item) => item.id === itemID)!
        let text = event.output ?? (event.failed ? 'failed' : '')
        if (text.length > 40000) text = `${text.slice(0, 40000)}\n…(truncated)`
        target.toolOutput = (event.failed ? '⚠️ ' : '') + text
        saveTranscript(session.id, items)
        broadcast({ type: 'patch', sessionID: session.id, itemID, toolOutput: target.toolOutput })
        break
      }
      case 'background': {
        // Events are only applied for the turn that is running, so it is there.
        const active = running.get(session.id)!
        active.background = event.tasks.map((task) => (
          { ...task, startedAt: active.background.find((known) => known.id === task.id)?.startedAt ?? Date.now() }))
        break
      }
      case 'done': {
        const usage: Usage = event.usage
        session.inputTokens += usage.input
        session.cachedInputTokens += usage.cached
        session.outputTokens += usage.output
        if (usage.costUSD != null) session.totalCostUSD += usage.costUSD
        else if (session.engine === 'codex') {
          const uncached = Math.max(0, usage.input - usage.cached)
          const rates = state.settings.codexPricing
          session.totalCostUSD +=
            (uncached / 1e6) * rates.input + (usage.cached / 1e6) * rates.cached
            + (usage.output / 1e6) * rates.output
        }
        saveState(state)
        broadcast({ type: 'session', session })
        pushState()
        if (event.summary) append(session.id, { role: 'info', text: event.summary })
        if (!isWatching(session.id)) {
          raise({
            title: `${session.title} finished`,
            body: event.summary ?? 'The turn finished.',
            sound: 'Glass', sessionID: session.id, tab: 'sessions',
          })
        }
        break
      }
      case 'failed':
        if (interrupted.has(session.id)) break   // we asked it to stop; the reason is already in the log
        append(session.id, { role: 'error', text: event.message, engine: session.engine, canRetry: true })
        raise({
          title: `${session.title} failed`,
          body: event.message.split('\n')[0].slice(0, 180),
          sound: 'Basso', sessionID: session.id, tab: 'sessions',
        })
        if (/no conversation found/i.test(event.message)) {
          if (session.engine === 'claude') session.claudeSessionID = null
          else session.codexThreadID = null
          saveState(state)
          append(session.id, {
            role: 'info',
            text: 'That conversation no longer exists on disk. The next message starts a fresh one.',
          })
        }
        break
    }
  }

  /** Starts the next turn of a session that exists: every caller checked, or holds, the session. */
  function launchQueued(sessionID: string) {
    const session = state.sessions.find((candidate) => candidate.id === sessionID)!
    const queued = queuedFor(sessionID)
    if (!queued.length) return
    const worktree = worktreeFor(session)

    // An engine resuming its own thread already has everything it said and heard. It only needs
    // a bridge when it has never run here, or when the other engine has spoken since its last turn.
    const items = itemsOf(sessionID)
    const other: Session['engine'] = session.engine === 'claude' ? 'codex' : 'claude'
    const seen = state.lastSeen[sessionID]?.[session.engine] ?? 0
    const otherSeen = state.lastSeen[sessionID]?.[other] ?? 0
    const resuming = session.engine === 'claude' ? session.claudeSessionID : session.codexThreadID
    const needsBridge = !resuming || otherSeen > seen
    // What is being sent is the prompt, not also context: its own messages are left out and nothing else,
    // wherever they sit (a retry's note follows its message; a reply can follow a queued one).
    const sending = new Set<TranscriptItem | undefined>()
    // Newest first, each to a message of its own: the same words queued twice are two messages.
    for (const text of [...queued].reverse()) {
      sending.add(items.findLast((item) => item.role === 'user' && item.text === text && !sending.has(item)))
    }
    // A thread that starts fresh knows nothing, whatever this engine saw in a thread it no longer has.
    const unseen = items.slice(resuming ? seen : 0).filter((item) => !sending.has(item))
    const bridge = needsBridge ? bridgePrompt(unseen, 0) : null
    const prompt = bridge ? bridge + queued.join('\n\n') : queued.join('\n\n')

    const executable = findExecutable(session.engine)
    if (!executable) {
      append(sessionID, { role: 'error', text: `Could not find \`${session.engine}\` on PATH.`, canRetry: true })
      return
    }
    const promptToken = crypto.randomUUID()
    const host = `http://127.0.0.1:${PORT}/mcp/${promptToken}`
    const args = session.engine === 'claude'
      ? claudeArgs(session, prompt, session.claudeSessionID ?? null, crypto.randomUUID(), host)
      : codexArgs(session, prompt, session.codexThreadID ?? null, host)

    // The working tree as the turn finds it; against the tree it leaves, that is what the turn did.
    // Started before the agent and read in parallel with it: a turn takes far longer than this snapshot.
    const before = snapshotTree(worktree.path)
    const child = spawnAgent(executable, args, worktree.path)
    child.on('error', (error) => {
      append(sessionID, { role: 'error', text: `Could not start ${session.engine}: ${error.message}`, canRetry: true })
    })
    // A spawn that failed has no pid and nothing to track; its error event, above, says why.
    if (!child.pid) return
    promptTokens.set(promptToken, sessionID)
    const toolItems = new Map<string, string>()
    const startedCodexItems = new Set<string>()
    running.set(sessionID, { session, child, pid: child.pid, engine: session.engine, toolItems, background: [], stopsRefused: 0, inFlight: new Map(), finished: [], startedAt: Date.now() })
    recordRunning()
    state.queuedMessages[sessionID] = []
    saveState(state)
    pushRunning()

    let stdout = ''
    let stderr = ''
    // A session deleted mid-turn has nothing left to write to; whatever its engine still says is dropped.
    const owned = () => running.get(sessionID)?.child === child
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!owned()) return
      stdout += chunk.toString('utf8')
      let newline: number
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        if (!line.trim()) continue
        const events = session.engine === 'claude'
          ? parseClaudeLine(line)
          : parseCodexLine(line, startedCodexItems)
        for (const event of events) applyEvent(session, event, toolItems)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
    })
    child.on('close', async (code) => {
      promptTokens.delete(promptToken)
      broker.cancelSession(sessionID, 'The turn ended before anyone answered.')
      const mine = owned()
      if (mine) { lastFinished.set(sessionID, running.get(sessionID)!.finished); running.delete(sessionID) }
      recordRunning()
      const moveTo = state.worktrees.find((candidate) => candidate.id === pendingMoves.get(sessionID))
      pendingMoves.delete(sessionID)
      if (!mine) return
      // Asked to move while it ran: it goes in the same breath as the turn ending, so nothing can start in between.
      if (moveTo) moveSession(session, moveTo)
      state.lastSeen[sessionID] = {
        ...(state.lastSeen[sessionID] ?? {}), [session.engine]: itemsOf(sessionID).length,
      }
      const alreadyReported = itemsOf(sessionID).slice(-2).some((item) => item.role === 'error')
      const wasInterrupted = interrupted.delete(sessionID)
      // A deliberate stop or steer ends the process early; that is not something to report as an error.
      if (code !== 0 && code !== null && !alreadyReported && !wasInterrupted) {
        const detail = stderr.split('\n').slice(-6).join('\n')
        append(sessionID, {
          role: 'error',
          text: `Process exited with status ${code}${detail ? `\n${detail}` : ''}`,
          canRetry: true,
        })
      }
      const [start, end] = await Promise.all([before, snapshotTree(worktree.path)])
      if (start && end) state.lastTurn[worktree.id] = { before: start, after: end, sessionID, endedAt: Date.now() }
      saveState(state)
      pushRunning()
      launchQueued(sessionID)
    })
  }

  const app = express()

  // Any page the user visits can reach a localhost port; DNS rebinding defeats the address check
  // alone. Every request must name us by a local Host, carry no foreign Origin, and not be one a
  // browser marks as coming from another site (an <img> or a link there sends no Origin at all).
  app.use((request, response, next) => {
    if (!hostIsLocal(request.headers.host, PORT) || !originIsAllowed(request.headers.origin, PORT)
        || !fetchSiteIsAllowed(request.headers['sec-fetch-site'] as string | undefined)) {
      return response.status(403).json({ error: 'This API only answers the orchestrator itself.' })
    }
    next()
  })

  // Every mutating request is logged with who sent it, so a deletion can always be traced.
  app.use((request, response, next) => {
    if (request.method === 'GET') return next()
    const started = Date.now()
    response.on('finish', () => {
      console.log(`[api] ${request.method} ${request.originalUrl} -> ${response.statusCode} `
        + `(${Date.now() - started}ms, ua=${String(request.headers['user-agent'] ?? '').slice(0, 40)})`)
    })
    next()
  })

  /** Files the UI may read or write: the Claude config tree, projects, and their worktrees. */
  function fileRoots(): string[] {
    return allowedRoots(state.projects.map((project) => project.path),
                        state.worktrees.map((worktree) => worktree.path))
  }

  function refuseOutsideRoots(path: string, response: express.Response): boolean {
    if (path && isInsideAny(path, fileRoots())) return false
    response.status(403).json({ error: 'That path is outside your projects and Claude config.' })
    return true
  }
  app.use(express.json({ limit: '4mb' }))
  // A malformed body must come back as JSON like every other error, not as an HTML page.
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error && (error as { type?: string }).type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'Malformed JSON body' })
    }
    next(error)
  })

  // Packaged builds serve the compiled UI from this same origin, so the API and the WebSocket
  // are same-origin in production exactly as the Vite proxy makes them in development.
  const staticRoot = process.env.SERVE_STATIC
  if (staticRoot) app.use(express.static(staticRoot))

  app.get('/api/state', async (_request, response) => {
    if (await refreshBranches()) { saveState(state); pushState() }
    const { type: _type, ...snapshot } = stateEvent()
    response.json(snapshot)
  })

  app.get('/api/transcript/:id', (request, response) => {
    response.json(transcripts.get(request.params.id) ?? [])
  })

  app.post('/api/session/:id/send', async (request, response) => {
    const sessionID = request.params.id
    const session = state.sessions.find((candidate) => candidate.id === sessionID)
    if (!session) return response.status(404).json({ error: 'no such session' })
    const text = String(request.body.text ?? '').trim()
    if (!text) return response.status(400).json({ error: 'empty message' })
    // "/rename [title]" is the orchestrator's own command for any engine; it never reaches the agent.
    const rename = /^\/rename(?:\s+([\s\S]+))?$/.exec(text)
    if (rename) {
      const message = await renameByRequest(sessionID, rename[1] ?? null)
      return response.json({ ok: true, title: session.title, message })
    }
    // The composer's comment chips are part of the message; without this they are dropped here.
    const prompt = composePrompt(text, parseComments(request.body.comments))

    if (session.title === DEFAULT_SESSION_TITLE) setTitle(session, titleFromMessage(text) ?? session.title)

    append(sessionID, { role: 'user', text: prompt, engine: session.engine })
    const asked = itemsOf(sessionID).filter((item) => item.role === 'user').length
    if (!session.titleIsManual && asked <= AUTO_TITLE_MESSAGES) nameSession(session, false).catch(reportFailure)
    state.queuedMessages[sessionID] = [...queuedFor(sessionID), prompt]
    saveState(state)

    const active = running.get(sessionID)
    if (active) {
      if (session.steeringMode === 'steer') {
        append(sessionID, { role: 'info', text: 'Steering: interrupting current turn…' })
        interrupt(active.pid, sessionID)
      } else {
        append(sessionID, { role: 'info', text: 'Queued — will be delivered when the agent finishes.' })
      }
    } else {
      launchQueued(sessionID)
    }
    response.json({ ok: true })
  })

  /** Picks the failed turn back up: the last thing you asked for is sent again. */
  app.post('/api/session/:id/retry', (request, response) => {
    const sessionID = request.params.id
    const session = state.sessions.find((candidate) => candidate.id === sessionID)
    if (!session) return response.status(404).json({ error: 'no such session' })
    if (running.has(sessionID)) return response.status(409).json({ error: 'That session is already running' })
    const last = itemsOf(sessionID).filter((item) => item.role === 'user').at(-1)
    if (!last) return response.status(400).json({ error: 'Nothing to continue: no message was sent yet' })
    append(sessionID, { role: 'info', text: 'Continuing after the failure…' })
    // A failure before the engine ever started leaves the message still queued; re-adding it
    // would send the same instruction twice.
    if (!queuedFor(sessionID).length) state.queuedMessages[sessionID] = [last.text]
    saveState(state)
    launchQueued(sessionID)
    response.json({ ok: true })
  })

  app.post('/api/session/:id/stop', (request, response) => {
    const active = running.get(request.params.id)
    if (active) interrupt(active.pid, request.params.id)
    response.json({ ok: true })
  })

  const SESSION_PREFERENCES = ['engine', 'accessMode', 'steeringMode', 'model', 'effort'] as const

  /**
   * What a new session in this worktree starts as: the last session here, else the choices the
   * user made most recently anywhere. Set the engine once and every later session follows.
   */
  function inheritedSettings(worktreeID: string) {
    const previous = state.sessions.filter((session) => session.worktreeID === worktreeID && !session.isArchived).at(-1)
    const defaults = state.settings.sessionDefaults
    // Always Claude, on the model last used with Claude; access and steering follow the last session here.
    return {
      engine: 'claude' as const,
      accessMode: previous?.accessMode ?? defaults.accessMode,
      steeringMode: previous?.steeringMode ?? defaults.steeringMode,
      model: defaults.models.claude.model,
      effort: defaults.models.claude.effort,
    }
  }

  const SESSION_PATCHABLE = [
    'title', 'engine', 'accessMode', 'steeringMode', 'model', 'effort', 'isPinned', 'isArchived',
  ] as const

  app.patch('/api/session/:id', (request, response) => {
    const session = state.sessions.find((candidate) => candidate.id === request.params.id)
    if (!session) return response.status(404).json({ error: 'no such session' })
    const body = request.body
    // A move names a worktree that exists, or nothing at all changes.
    const target = 'worktreeID' in body ? state.worktrees.find((candidate) => candidate.id === body.worktreeID) : null
    if (target === undefined) return response.status(404).json({ error: 'No such worktree' })
    const before = { engine: session.engine, accessMode: session.accessMode, model: session.model, effort: session.effort }
    for (const key of SESSION_PATCHABLE) {
      if (key in body) (session as unknown as Record<string, unknown>)[key] = body[key]
    }
    if ('title' in body) {
      session.titleIsManual = true
      if (inheritWorktreeName(session)) pushState()
    }
    // The latest ask is the one that counts: a move that was waiting gives way to it, or to staying put.
    if (target && pendingMoves.delete(session.id) && target.id === session.worktreeID) {
      append(session.id, { role: 'info', text: `Session stays in ${target.name}` })
    }
    if (target && target.id !== session.worktreeID) {
      // An agent at work stays where it is, and its session with it: the move waits for the turn to end.
      if (running.has(session.id)) {
        pendingMoves.set(session.id, target.id)
        append(session.id, { role: 'info', text: `Session moves to ${target.name} when this turn ends` })
      } else {
        moveSession(session, target)
      }
    }
    // Switching engines lands on that engine's remembered model, never on one it cannot run.
    if ('engine' in body && !('model' in body)) {
      const remembered = state.settings.sessionDefaults.models[session.engine]
      session.model = remembered.model
      session.effort = remembered.effort
    }
    // Whatever was just chosen becomes what the next session starts with; the model and effort
    // are remembered for the engine they were chosen on.
    if (SESSION_PREFERENCES.some((key) => key in body)) {
      const defaults = state.settings.sessionDefaults
      defaults.accessMode = session.accessMode
      defaults.steeringMode = session.steeringMode
      if (session.model) defaults.models[session.engine] = { model: session.model, effort: session.effort ?? null }
    }
    saveState(state)
    broadcast({ type: 'session', session })
    applyMidTurn(session, before)
    response.json(session)
  })

  const describeTask = (task: BackgroundTask) => `${task.description} (${task.kind === 'agent' ? 'subagent' : 'command'})`
  /** How often one turn is told to wait for its background work before it is let go, so it cannot loop forever. */
  const STOP_REFUSALS = 5

  /** Sessions asked to move while their turn ran, and where to: carried out when the turn ends. */
  const pendingMoves = new Map<string, string>()

  function moveSession(session: Session, target: Worktree) {
    session.worktreeID = target.id
    forgetClaudeThread(session)
    append(session.id, { role: 'info', text: `Session moved to ${target.name}: ${target.path}` })
    pushState()
  }

  /** Whether an agent is at work in this worktree. A session stays with its running turn, so its sessions say. */
  const turnRunsIn = (worktreeID: string) => state.sessions.some((session) => session.worktreeID === worktreeID && running.has(session.id))

  /** Claude keys a conversation by the folder it ran in: after a move the next turn starts fresh and is handed the conversation so far. */
  function forgetClaudeThread(session: Session) {
    session.claudeSessionID = null
  }

  /** Names the session from its whole conversation now, whatever it was called: the person asked. */
  app.post('/api/session/:id/name', async (request, response) => {
    const session = state.sessions.find((candidate) => candidate.id === request.params.id)
    if (!session) return response.status(404).json({ error: 'no such session' })
    session.titleIsManual = false
    const title = await nameSession(session, true)
    if (!title) return response.status(502).json({ error: 'No name came back: nothing has been asked here yet, or Claude could not be reached.' })
    response.json({ ok: true, title })
  })

  /**
   * A running agent was started with its model, effort and permissions on the command line, so a
   * change to any of them lands by restarting the turn: the engine resumes its own thread from
   * where it was, with the new settings, and is told to carry on.
   */
  function applyMidTurn(session: Session, before: Pick<Session, 'engine' | 'accessMode' | 'model' | 'effort'>) {
    const active = running.get(session.id)
    if (!active) return
    const changes = [
      before.engine !== session.engine ? `engine ${session.engine}` : '',
      before.model !== session.model ? `model ${session.model ?? 'default'}` : '',
      before.effort !== session.effort ? `effort ${session.effort ?? 'default'}` : '',
      before.accessMode !== session.accessMode ? `access ${session.accessMode}` : '',
    ].filter(Boolean)
    if (!changes.length) return
    append(session.id, { role: 'info', text: `Applying mid-turn: ${changes.join(', ')}. The turn restarts from where it was.` })
    state.queuedMessages[session.id] = [...queuedFor(session.id),
      `Settings changed while you were working (${changes.join(', ')}). Continue exactly where you left off; do not redo what already finished.`]
    saveState(state)
    interrupt(active.pid, session.id)
  }

  app.post('/api/worktree/:id/session', (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'no such worktree' })
    const session: Session = {
      id: crypto.randomUUID(),
      worktreeID: worktree.id,
      title: DEFAULT_SESSION_TITLE,
      ...inheritedSettings(worktree.id),
      claudeSessionID: null, codexThreadID: null,
      isPinned: false, isArchived: false,
      totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    }
    state.sessions.push(session)
    transcripts.set(session.id, [])
    saveState(state)
    pushState()
    response.json(session)
  })

  /** A commit is named by its hash and nothing else: anything else in its place would reach git as an option. */
  const commitSHA = (value: unknown): string | null => (/^[0-9a-f]{4,40}$/i.test(String(value ?? '')) ? String(value) : null)

  const KNOWN_SCOPES = ['uncommitted', 'staged', 'branch', 'main', 'remote', 'commit', 'turn'] as const
  const isScope = (value: string): value is (typeof KNOWN_SCOPES)[number] => (KNOWN_SCOPES as readonly string[]).includes(value)

  /**
   * What a review request compares, from its query: the scope, the branch it is measured against
   * (echoed back so the panel can say which), and the turn a "turn" scope shows. A scope of null is
   * a turn scope with no finished turn to show. Null altogether means the request was refused and
   * answered already.
   */
  async function scopeOf(request: express.Request, response: express.Response, path: string): Promise<{
    scope: gitService.DiffScope | null; base: string | null; turn: { sessionID: string; endedAt: number } | null
  } | null> {
    const scopeKind = String(request.query.scope ?? 'uncommitted')
    if (!isScope(scopeKind)) { response.status(400).json({ error: `Unknown scope: ${scopeKind}` }); return null }
    const worktree = state.worktrees.find((candidate) => candidate.path === path)
    if (scopeKind === 'commit') {
      const sha = commitSHA(request.query.sha)
      if (!sha) { response.status(400).json({ error: 'sha must be a commit hash' }); return null }
      return { scope: { kind: 'commit', sha }, base: null, turn: null }
    }
    if (scopeKind === 'turn') {
      const record = state.lastTurn[worktree?.id ?? '']
      if (!record) return { scope: null, base: null, turn: null }
      return { scope: { kind: 'turn', before: record.before, after: record.after }, base: null,
               turn: { sessionID: record.sessionID, endedAt: record.endedAt } }
    }
    if (scopeKind === 'branch') {
      // A path with no worktree record (a plain repository) is measured against whatever the caller says.
      const base = worktree ? await baseFor(worktree) : (request.query.base ? String(request.query.base) : null)
      return { scope: { kind: 'branch' }, base, turn: null }
    }
    if (scopeKind === 'main') return { scope: { kind: 'main' }, base: await gitService.defaultBranch(path), turn: null }
    return { scope: { kind: scopeKind }, base: null, turn: null }
  }

  app.get('/api/diff', async (request, response) => {
    const path = String(request.query.path ?? '')
    if (!path) return response.status(400).json({ error: 'path required' })
    if (refuseOutsideRoots(path, response)) return
    const context = Number(request.query.context ?? 3)
    const resolved = await scopeOf(request, response, path)
    if (!resolved) return
    const { scope, base, turn } = resolved
    if (!scope) return response.json({ files: [], base, turn })
    // The refresh button: origin's copy of the branch compared against is brought up to date first.
    const fresh = request.query.fresh === '1'
    if (fresh && base) await gitService.fetchBranch(path, base)
    if (fresh && scope.kind === 'remote') await gitService.fetchBranch(path)
    response.json({ files: parseDiff(await gitService.diff(path, scope, base, context)), base, turn })
  })

  /** One file whole, as it is on each side of the scope: what the review's editor shows. */
  app.get('/api/diff/file', async (request, response) => {
    const path = String(request.query.path ?? '')
    const file = String(request.query.file ?? '')
    if (!path || !file) return response.status(400).json({ error: 'path and file required' })
    if (refuseOutsideRoots(path, response)) return
    // The file is named within the worktree; a name that leaves it is not a file of the review.
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) return response.status(400).json({ error: 'file must be a path inside the worktree' })
    const resolved = await scopeOf(request, response, path)
    if (!resolved) return
    if (!resolved.scope) return response.json({ before: null, after: null })
    response.json(await gitService.sides(path, resolved.scope, resolved.base, file))
  })

  app.get('/api/commits', async (request, response) => {
    const path = String(request.query.path ?? '')
    const base = request.query.base ? String(request.query.base) : null
    response.json({ commits: await gitService.commits(path, base) })
  })

  app.get('/api/branches', async (request, response) => {
    const path = String(request.query.path ?? '')
    const [list, base] = await Promise.all([gitService.branches(path), gitService.defaultBranch(path)])
    response.json({ branches: list, defaultBranch: base })
  })

  /** Every file in the worktree plus the diff numbers of the changed ones, for the project tree. */
  app.get('/api/tree', async (request, response) => {
    const path = String(request.query.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    if (!existsSync(path)) return response.status(404).json({ error: 'not found' })
    const scope = String(request.query.scope ?? 'uncommitted')
    const sha = scope === 'commit' ? commitSHA(request.query.sha) : null
    if (scope === 'commit' && !sha) return response.status(400).json({ error: 'sha must be a commit hash' })
    const kind: gitService.DiffScope | null = sha ? { kind: 'commit', sha }
      : scope === 'uncommitted' || scope === 'staged' || scope === 'branch' || scope === 'remote' ? { kind: scope } : null
    if (!kind) return response.status(400).json({ error: `Unknown scope: ${scope}` })
    const base = request.query.base ? String(request.query.base) : null
    const [tracked, untracked, diff] = await Promise.all([
      gitService.git(path, ['ls-files', '-z']),
      gitService.git(path, ['ls-files', '-z', '--others', '--exclude-standard']),
      gitService.diff(path, kind, base, 0),
    ])
    const changed = new Map(parseDiff(diff).map((file) => [file.path, file]))
    const files = [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))]
      .map((file) => {
        const stats = changed.get(file)
        return { path: file, status: stats?.status ?? null, added: stats?.added ?? 0, removed: stats?.removed ?? 0 }
      })
    response.json({ files })
  })

  /**
   * The bytes of an image the agent wrote or read, so the chat can show it. Anything else is
   * handed over as a download: a file served as HTML or script would run on this origin, with
   * every route of this API in reach.
   */
  app.get('/api/file/raw', (request, response) => {
    const path = String(request.query.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    if (!existsSync(path) || !statSync(path).isFile()) return response.status(404).json({ error: 'not found' })
    const image = IMAGE_TYPES[extname(path).toLowerCase()]
    response.set('X-Content-Type-Options', 'nosniff')
    if (image) {
      response.type(image)
      if (image === 'image/svg+xml') response.set('Content-Security-Policy', "default-src 'none'")
    } else {
      response.type('application/octet-stream')
      response.set('Content-Disposition', `attachment; filename="${basename(path).replace(/["\r\n]/g, '')}"`)
    }
    response.sendFile(path, { dotfiles: 'allow' }, (error) => {
      if (error && !response.headersSent) response.status(404).json({ error: 'not found' })
    })
  })

  app.get('/api/file', (request, response) => {
    const path = String(request.query.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    if (!existsSync(path)) return response.status(404).json({ error: 'not found' })
    response.json({ path, name: basename(path), text: readFileSync(path, 'utf8') })
  })

  const server = createServer(app)
  // A permission prompt holds its request open until someone answers; Node would cut it at 5 minutes.
  server.requestTimeout = 0
  app.get('/api/worktree/:id/terminals', (request, response) => {
    response.json({ terminals: listTerminals(request.params.id) })
  })

  app.post('/api/worktree/:id/terminals', (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    if (!existsSync(worktree.path)) return response.status(400).json({ error: 'Worktree folder is missing' })
    const existing = listTerminals(worktree.id)
    // The drawer asks for "one if none": two mounts racing must not open two shells.
    if (request.body.ifNone && existing.length) return response.json(existing[0])
    // Signing an engine in again runs its own login, in a shell where its browser link and prompts can be answered.
    const login = request.body.login === 'claude' || request.body.login === 'codex' ? request.body.login as 'claude' | 'codex' : null
    const executable = login ? findExecutable(login) : null
    if (login && !executable) return response.status(400).json({ error: `Could not find \`${login}\` on PATH.` })
    const command = login ? `'${executable}' ${login === 'claude' ? 'auth login' : 'login'}` : undefined
    const title = login ? `Sign in to ${login === 'claude' ? 'Claude' : 'Codex'}` : String(request.body.title ?? `Terminal ${existing.length + 1}`)
    const handle = openTerminal(worktree.id, worktree.path, title, command)
    response.json({ id: handle.id, worktreeID: handle.worktreeID, title: handle.title, pid: handle.process.pid })
  })

  app.delete('/api/terminal/:id', (request, response) => {
    response.json({ ok: closeTerminal(request.params.id) })
  })

  // WebSockets bypass the same-origin policy, so the socket needs the same check as the routes.
  // Two socket servers share one HTTP server, so upgrades are routed by path here: `ws` would
  // otherwise answer 400 for any path it was not itself given.
  const wss = new WebSocketServer({ noServer: true })
  const terminalSockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (!hostIsLocal(request.headers.host, PORT) || !originIsAllowed(request.headers.origin, PORT)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return
    }
    const pathname = new URL(String(request.url), 'http://localhost').pathname
    const target = pathname === '/ws' ? wss : pathname === '/terminal' ? terminalSockets : null
    if (!target) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return }
    target.handleUpgrade(request, socket, head, (client) => target.emit('connection', client, request))
  })


  // ---- projects -------------------------------------------------------------------------

  const DEFAULT_GROUP = 'main'
  /** "." and ".." are not folders of their own: as a name they would lead out of the worktree root. */
  const ONLY_DOTS = /^\.+$/
  /** A worktree goes into the default folder or one the project has; anything else is refused before it reaches the disk. */
  const noSuchFolder = (project: Project, group: unknown) =>
    !!group && group !== DEFAULT_GROUP && !project.worktreeGroups.includes(String(group))

  /** The folders inside a folder (home when none is named), for browsing to a project to add. */
  app.get('/api/folders', (request, response) => {
    try {
      response.json(listFolders(request.query.path ? String(request.query.path) : browseHome()))
    } catch {
      response.status(400).json({ error: 'That folder cannot be read' })
    }
  })

  app.post('/api/project', async (request, response) => {
    const path = String(request.body.path ?? '')
    if (!path || !existsSync(path)) return response.status(400).json({ error: 'No such folder' })
    if (state.projects.some((project) => project.path === path)) {
      return response.json({ ok: true, alreadyAdded: true })
    }
    let isGit = await gitService.isGitRepo(path)
    if (!isGit) {
      await gitService.git(path, ['init'])
      await gitService.git(path, ['add', '-A'])
      await gitService.git(path, ['commit', '--allow-empty', '-m', 'Initial commit'])
      isGit = await gitService.isGitRepo(path)
    }
    const project = {
      id: crypto.randomUUID(), name: basename(path), path, isGit, isExpanded: true,
      worktreeGroups: [DEFAULT_GROUP],
    }
    state.projects.push(project)
    state.worktrees.push({
      id: crypto.randomUUID(), projectID: project.id, name: basename(path), path,
      branch: await gitService.currentBranch(path), baseBranch: await gitService.defaultBranch(path),
      isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: DEFAULT_GROUP,
    })
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  app.delete('/api/project/:id', (request, response) => {
    const worktrees = state.worktrees.filter((worktree) => worktree.projectID === request.params.id)
    for (const worktree of worktrees) forgetWorktree(worktree.id)
    state.projects = state.projects.filter((project) => project.id !== request.params.id)
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  // ---- worktrees ------------------------------------------------------------------------

  function forgetWorktree(worktreeID: string) {
    for (const session of state.sessions.filter((item) => item.worktreeID === worktreeID)) {
      const active = running.get(session.id)
      if (active) killTree(active.pid, 'SIGTERM')
      running.delete(session.id)
      transcripts.delete(session.id)
      delete state.queuedMessages[session.id]
      delete state.drafts[session.id]
    }
    state.sessions = state.sessions.filter((session) => session.worktreeID !== worktreeID)
    state.worktrees = state.worktrees.filter((worktree) => worktree.id !== worktreeID)
    leaveStack(worktreeID)
  }

  /** A worktree on a new branch and its first session; what the + button and every stack layer are. */
  async function newWorktreeWithSession(project: Project, body: Record<string, any>) {
    const created = await worktreeService.createWorktree({
      projectPath: project.path, projectName: project.name, name: '', branch: null, base: body.base ?? null,
      checkoutExisting: false, rootOverride: state.settings.worktreeRoot, group: DEFAULT_GROUP,
    })
    const worktree: Worktree = {
      id: crypto.randomUUID(), projectID: project.id, name: created.path.split('/').pop()!,
      path: created.path, branch: created.branch, baseBranch: body.baseBranch ?? created.base,
      isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: DEFAULT_GROUP,
    }
    state.worktrees.push(worktree)
    const session: Session = {
      id: crypto.randomUUID(), worktreeID: worktree.id, title: DEFAULT_SESSION_TITLE,
      ...inheritedSettings(worktree.id),
      claudeSessionID: null, codexThreadID: null,
      isPinned: false, isArchived: false,
      totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    }
    state.sessions.push(session)
    return { worktree, session }
  }

  function nextStackName(projectID: string): string {
    const taken = new Set(state.stacks.filter((stack) => stack.projectID === projectID).map((stack) => stack.name))
    let number = 1
    while (taken.has(`Stack ${number}`)) number += 1
    return `Stack ${number}`
  }

  /** A pull request built on another open worktree's branch joins that worktree's stack, right above it. */
  async function stackOnParent(worktree: Worktree, project: Project, prBase: string | null) {
    if (!prBase || prBase === await gitService.defaultBranch(project.path)) return
    const prs = prCache.peek(project.id)
    const parent = state.worktrees.find((candidate) => candidate.id !== worktree.id && candidate.projectID === project.id
      && !candidate.isArchived && (candidate.branch === prBase
        || prs.some((pr) => pr.headRefName === prBase && candidate.branch === `orch/pr-${pr.number}`)))
    if (!parent) return
    const stack = state.stacks.find((candidate) => candidate.layers.includes(parent.id))
    if (stack) stack.layers.splice(stack.layers.indexOf(parent.id) + 1, 0, worktree.id)
    else {
      state.stacks.push({ id: crypto.randomUUID(), projectID: project.id, name: nextStackName(project.id),
        base: await gitService.defaultBranch(project.path), layers: [parent.id, worktree.id] })
    }
  }

  function leaveStack(worktreeID: string) {
    for (const stack of state.stacks) stack.layers = stack.layers.filter((id) => id !== worktreeID)
    state.stacks = state.stacks.filter((stack) => stack.layers.length)
  }

  /** A stack's layers that are still worktrees, bottom first, as the stack operations take them. */
  function layersOf(stack: Stack) {
    return stack.layers.map((id) => state.worktrees.find((worktree) => worktree.id === id)!)
      .map((worktree) => ({
        id: worktree.id, path: worktree.path,
        title: state.sessions.find((session) => session.worktreeID === worktree.id && session.title !== DEFAULT_SESSION_TITLE)?.title
          ?? worktree.name,
      }))
  }

  const stackOf = (request: express.Request) => state.stacks.find((stack) => stack.id === request.params.id)

  /** A stack and its first layer: a fresh branch from the latest default branch, with a session. */
  app.post('/api/project/:id/stack', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    try {
      const { worktree, session } = await newWorktreeWithSession(project, {})
      const stack: Stack = {
        id: crypto.randomUUID(), projectID: project.id, name: nextStackName(project.id),
        base: await gitService.defaultBranch(project.path), layers: [worktree.id],
      }
      state.stacks.push(stack)
      saveState(state)
      pushState()
      response.json({ ok: true, stack, worktree, session })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  /** A new layer on top: a branch from the top layer's branch, measured against it, with a session. */
  app.post('/api/stack/:id/layer', async (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    const project = state.projects.find((candidate) => candidate.id === stack.projectID)!
    const top = state.worktrees.find((worktree) => worktree.id === stack.layers.at(-1))!
    try {
      const parent = await gitService.currentBranch(top.path)
      if (!parent || parent === 'HEAD') return response.status(400).json({ error: 'The top layer is not on a branch' })
      const { worktree, session } = await newWorktreeWithSession(project, { base: parent, baseBranch: parent })
      stack.layers.push(worktree.id)
      saveState(state)
      pushState()
      response.json({ ok: true, worktree, session })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.patch('/api/stack/:id', (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    const name = String(request.body.name ?? '').trim()
    if (!name) return response.status(400).json({ error: 'Give the stack a name' })
    stack.name = name
    saveState(state)
    pushState()
    response.json({ ok: true, stack })
  })

  /** Dissolves a stack: its worktrees, branches and sessions all stay, back in their folders. */
  app.delete('/api/stack/:id', (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    state.stacks = state.stacks.filter((candidate) => candidate !== stack)
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  app.delete('/api/stack/:id/layer/:worktreeID', (request, response) => {
    const stack = stackOf(request)
    if (!stack?.layers.includes(request.params.worktreeID)) return response.status(404).json({ error: 'No such layer' })
    leaveStack(request.params.worktreeID)
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  app.post('/api/stack/:id/update', async (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    try {
      response.json({ ok: true, results: await updateLayers(layersOf(stack)) })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/stack/:id/prs', async (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    const project = state.projects.find((candidate) => candidate.id === stack.projectID)!
    try {
      const results = await openStackPRs(project.path, stack.base, layersOf(stack))
      prCache.warm(project.id, project.path)
      response.json({ ok: true, results })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  /**
   * Lands the bottom layer: its pull request is merged the way the repository prefers, the next
   * layer's is pointed at the stack's base, and the rest are brought up to date with it.
   */
  app.post('/api/stack/:id/land', async (request, response) => {
    const stack = stackOf(request)
    if (!stack) return response.status(404).json({ error: 'No such stack' })
    const project = state.projects.find((candidate) => candidate.id === stack.projectID)!
    const [bottom, next] = layersOf(stack)
    try {
      const bottomBranch = await gitService.currentBranch(bottom.path)
      const pr = bottomBranch ? await openPullRequestFor(project.path, bottomBranch) : null
      if (!pr) return response.status(400).json({ error: `${bottom.title} has no open pull request: open the stack's PRs first` })
      const method = await preferredMergeMethod(project.path)
      await mergePullRequest(project.path, pr.number, method)
      const results: LayerResult[] = [{ worktreeID: bottom.id, branch: bottomBranch!, status: 'landed', message: `#${pr.number} merged (${method})`, url: pr.url }]
      leaveStack(bottom.id)
      if (next) {
        // The new bottom layer is measured against the stack's base from here on, whatever GitHub says next.
        state.worktrees.find((worktree) => worktree.id === next.id)!.baseBranch = stack.base
        const nextBranch = await gitService.currentBranch(next.path)
        const nextPR = nextBranch ? await openPullRequestFor(project.path, nextBranch) : null
        if (nextPR) await retargetPullRequest(project.path, nextPR.number, stack.base)
        await gitService.fetchBranch(project.path, stack.base)
        results.push(...await updateLayers(layersOf(stack), `origin/${stack.base}`))   // the stack still holds the rest
      }
      prCache.warm(project.id, project.path)
      saveState(state)
      pushState()
      response.json({ ok: true, results })
    } catch (error) {
      saveState(state)
      pushState()
      response.status(500).json({ error: failureText(error) })
    }
  })

  app.post('/api/project/:id/worktree', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const body = request.body
    if (noSuchFolder(project, body.group)) return response.status(400).json({ error: `No such folder: ${body.group}` })
    try {
      const created = await worktreeService.createWorktree({
        projectPath: project.path,
        projectName: project.name,
        // No name and no branch: a generated branch names both.
        name: body.name ? String(body.name) : '',
        branch: body.branch ?? null,
        base: body.base ?? null,
        checkoutExisting: !!body.checkoutExisting,
        rootOverride: state.settings.worktreeRoot,
        group: body.group ?? DEFAULT_GROUP,
      })
      let warning: string | null = null
      if (body.moveCurrentWork) {
        warning = await worktreeService.moveCurrentWork(project.path, created.path)
      }
      const worktree = {
        id: crypto.randomUUID(), projectID: project.id,
        name: String(body.name || created.path.split('/').pop()),
        path: created.path, branch: created.branch,
        baseBranch: ('base' in created && created.base ? created.base : body.base ?? (await gitService.currentBranch(project.path))),
        isMain: false, isExpanded: true, isPinned: false, isArchived: false,
        group: body.group ?? DEFAULT_GROUP,
      }
      state.worktrees.push(worktree)
      const session: Session = {
        id: crypto.randomUUID(), worktreeID: worktree.id, title: DEFAULT_SESSION_TITLE,
        ...inheritedSettings(worktree.id),
        claudeSessionID: null, codexThreadID: null,
        isPinned: false, isArchived: false,
        totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      }
      state.sessions.push(session)
      saveState(state)
      pushState()
      response.json({ ok: true, worktree, session, warning })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/project/:id/group', (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const name = String(request.body.name ?? '').trim().replace(/[^\w.-]+/g, '-')
    if (!name) return response.status(400).json({ error: 'Give the group a name' })
    if (ONLY_DOTS.test(name)) return response.status(400).json({ error: 'A folder needs a plain name' })
    project.worktreeGroups = [...new Set([...(project.worktreeGroups), name])]
    saveState(state)
    pushState()
    response.json({ ok: true, name, groups: project.worktreeGroups })
  })

  /** The folder order is the display order; "main" may move like any other. */
  app.put('/api/project/:id/groups', (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const requested: string[] = Array.isArray(request.body.order) ? request.body.order.map(String) : []
    const known = new Set(project.worktreeGroups)
    const order = [...new Set([...requested.filter((name) => known.has(name)), ...(project.worktreeGroups)])]
    project.worktreeGroups = order
    saveState(state)
    pushState()
    response.json({ ok: true, groups: order })
  })

  app.delete('/api/project/:id/group/:name', (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const inUse = state.worktrees.some(
      (worktree) => worktree.projectID === project.id && worktree.group === request.params.name)
    if (inUse) return response.status(400).json({ error: 'That group still has worktrees in it' })
    project.worktreeGroups = (project.worktreeGroups).filter((name) => name !== request.params.name)
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  /** Renames a group directory by moving every worktree in it; git's bookkeeping follows. */
  app.patch('/api/project/:id/group/:name', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.params.id)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const current = request.params.name
    const next = String(request.body.name ?? '').trim()
    if (current === DEFAULT_GROUP) return response.status(400).json({ error: 'The main folder keeps its name' })
    if (!next || next.includes('/') || ONLY_DOTS.test(next)) return response.status(400).json({ error: 'A folder needs a plain name' })
    const groups = project.worktreeGroups
    if (!groups.includes(current)) return response.status(404).json({ error: 'No such folder' })
    if (groups.includes(next) || next === DEFAULT_GROUP) return response.status(400).json({ error: `A folder named ${next} already exists` })
    const members = state.worktrees.filter((worktree) => worktree.projectID === project.id && worktree.group === current)
    if (members.some((worktree) => turnRunsIn(worktree.id))) {
      return response.status(409).json({ error: 'A turn is running in a worktree of this folder: it can be renamed once the turn ends' })
    }
    try {
      for (const worktree of members) {
        worktree.path = await worktreeService.moveWorktree(
          project.path, project.name, worktree.path, next, state.settings.worktreeRoot)
        worktree.group = next
        state.sessions.filter((session) => session.worktreeID === worktree.id).forEach(forgetClaudeThread)
      }
      project.worktreeGroups = groups.map((name) => (name === current ? next : name))
      saveState(state)
      pushState()
      response.json({ ok: true, groups: project.worktreeGroups })
    } catch (error) {
      // Whatever moved so far is recorded, so nothing is lost; the folder keeps both names until retried.
      saveState(state)
      pushState()
      response.status(500).json({ error: (error as Error).message })
    }
  })

  /** Rename the branch, check out another one, or re-fork an untouched worktree. */
  app.post('/api/worktree/:id/branch', async (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    if (worktree.isMain) return response.status(400).json({ error: "A project's own checkout keeps its branch" })
    const project = projectFor(worktree)
    const body = request.body
    try {
      const result = await worktreeService.switchBranch(project.path, worktree.path, {
        rename: body.rename, branch: body.branch, base: body.base, currentBase: worktree.baseBranch,
      })
      if (result.base) worktree.baseBranch = result.base
      await refreshBranches()
      saveState(state)
      pushState()
      response.json({ ok: true, worktree })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/worktree/:id/move', async (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    if (worktree.isMain) return response.status(400).json({ error: "A project's own checkout cannot be moved" })
    const project = projectFor(worktree)
    const group = request.body.group ? String(request.body.group) : null
    if (noSuchFolder(project, group)) return response.status(400).json({ error: `No such folder: ${group}` })
    // Already there: moving it onto itself would rename its directory for nothing.
    if ((worktree.group ?? null) === group) return response.json({ ok: true, worktree })
    // An agent at work here holds this directory by name: moved now, it would write where the checkout used to be.
    if (turnRunsIn(worktree.id)) return response.status(409).json({ error: 'A turn is running in this worktree: its directory can be moved once the turn ends' })
    try {
      worktree.path = await worktreeService.moveWorktree(
        project.path, project.name, worktree.path, group, state.settings.worktreeRoot)
      worktree.group = group
      state.sessions.filter((session) => session.worktreeID === worktree.id).forEach(forgetClaudeThread)
      saveState(state)
      pushState()
      response.json({ ok: true, worktree })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.patch('/api/worktree/:id', async (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    // Only these may change from the UI; id, project and isMain are never client-writable.
    const body = request.body
    if (worktree.isMain && body.isArchived) return response.status(400).json({ error: "A project's own checkout stays in the sidebar" })
    if ('path' in body && body.path !== worktree.path) {
      // Repointing: the record follows a checkout that already exists; nothing on disk moves.
      if (worktree.isMain) return response.status(400).json({ error: "A project's own checkout cannot be repointed" })
      const project = projectFor(worktree)
      let path: string
      try {
        path = await worktreeService.checkoutAt(project.path, String(body.path))
      } catch (error) {
        return response.status(400).json({ error: (error as Error).message })
      }
      // From here to the assignment nothing waits, so nothing can start or take the checkout in between.
      // A running turn keeps the folder it started in, and its diff would compare two checkouts.
      if (turnRunsIn(worktree.id)) {
        return response.status(409).json({ error: 'A turn is running in this worktree: stop it before pointing the worktree somewhere else' })
      }
      if (state.worktrees.some((other) => other !== worktree && worktreeService.realPath(other.path) === path)) {
        return response.status(400).json({ error: 'Another worktree already points there' })
      }
      // Its own folder under another spelling is not a repoint.
      if (path !== worktreeService.realPath(worktree.path)) {
        worktree.path = path
        worktree.group = worktreeService.folderHolding(project.name, path, project.worktreeGroups, state.settings.worktreeRoot)
        state.sessions.filter((session) => session.worktreeID === worktree.id).forEach(forgetClaudeThread)
        await refreshBranches()
      }
    }
    for (const key of ['name', 'isPinned', 'isArchived', 'isExpanded', 'baseBranch'] as const) {
      if (key in body) (worktree as unknown as Record<string, unknown>)[key] = body[key]
    }
    if ('name' in body) worktree.nameIsManual = true
    saveState(state)
    pushState()
    response.json({ ok: true, worktree })
  })

  app.delete('/api/worktree/:id', async (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    if (worktree.isMain) return response.status(400).json({ error: "A project's own checkout is never deleted" })
    const keepOnDisk = request.query.keepOnDisk === '1'
    try {
      // Disk first: if this fails the records stay, so the worktree is still reachable.
      if (!keepOnDisk) await worktreeService.deleteWorktree(projectFor(worktree).path, worktree.path)
      forgetWorktree(worktree.id)
      saveState(state)
      pushState()
      response.json({ ok: true })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.get('/api/worktree/:id/info', async (request, response) => {
    const worktree = state.worktrees.find((candidate) => candidate.id === request.params.id)
    if (!worktree) return response.status(404).json({ error: 'No such worktree' })
    const [branch, inUse] = await Promise.all([
      gitService.currentBranch(worktree.path),
      worktreeService.branchesInUse(projectFor(worktree).path),
    ])
    const files = parseDiff(await gitService.diff(
      worktree.path, { kind: worktree.isMain ? 'uncommitted' : 'branch' }, await baseFor(worktree)))
    if (await refreshBranches()) { saveState(state); pushState() }
    response.json({ liveBranch: branch, changedFiles: files.length, branchesInUse: inUse })
  })

  // ---- sessions -------------------------------------------------------------------------

  app.delete('/api/session/:id', (request, response) => {
    if (!state.sessions.some((session) => session.id === request.params.id)) {
      return response.status(404).json({ error: 'No such session' })
    }
    const active = running.get(request.params.id)
    if (active) killTree(active.pid, 'SIGTERM')
    running.delete(request.params.id)
    transcripts.delete(request.params.id)
    state.sessions = state.sessions.filter((session) => session.id !== request.params.id)
    delete state.queuedMessages[request.params.id]
    delete state.drafts[request.params.id]
    saveState(state)
    pushState()
    response.json({ ok: true })
  })

  app.get('/api/session/:id/draft', (request, response) => {
    response.json({ text: state.drafts[request.params.id] ?? '' })
  })

  app.put('/api/session/:id/draft', (request, response) => {
    state.drafts[request.params.id] = String(request.body.text ?? '')
    saveState(state)
    response.json({ ok: true })
  })

  // ---- claude infrastructure -------------------------------------------------------------

  app.get('/api/infra', (request, response) => {
    const category = String(request.query.category ?? 'claudemd') as InfraCategory
    response.json({ items: infraItems(category, state.projects) })
  })

  app.get('/api/infra/file', (request, response) => {
    const path = String(request.query.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    try {
      response.json(readInfraFile(path))
    } catch (error) {
      response.status(404).json({ error: (error as Error).message })
    }
  })

  app.put('/api/infra/file', (request, response) => {
    const path = String(request.body.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    try {
      const modified = writeInfraFile(path, String(request.body.text ?? ''), request.body.modified)
      response.json({ ok: true, modified })
    } catch (error) {
      response.status(409).json({ error: (error as Error).message })
    }
  })

  app.get('/api/skills', (_request, response) => {
    response.json({ skills: skillCatalog(state.projects.map((project) => project.path)) })
  })

  // ---- usage, pull requests, voice --------------------------------------------------------

  const forCodex = (request: express.Request) => request.query.engine === 'codex'

  app.get('/api/usage', async (request, response) => {
    const report = forCodex(request)
      ? await codexUsageReport(codexRates(state.settings.codexPricing))
      : await usageReport(state.settings.claudePricing)
    response.json({ ...report, sessions: state.sessions })
  })

  app.get('/api/plan-usage', async (request, response) => {
    try {
      response.json(await (forCodex(request) ? codexPlanUsage() : planUsage()))
    } catch (error) {
      response.json({ error: (error as Error).message })
    }
  })

  const prCache = new PRCache(
    join(dirname(RUNNING_RECORD), 'prs.json'),
    () => state.settings.linearWorkspace,
    (workspace) => { state.settings.linearWorkspace = workspace; saveState(state) },
  )

  /** Rows plus which worktree (by live branch) already holds each PR. */
  async function withWorktrees(project: Project, result: Awaited<ReturnType<PRCache['list']>>) {
    if (!result.ok) return result
    const live = await Promise.all(
      state.worktrees
        .filter((worktree) => worktree.projectID === project.id && !worktree.isArchived)
        .map(async (worktree) => ({ worktree, branch: await gitService.currentBranch(worktree.path) })))
    const prs = result.prs.map((pr) => {
      const match = live.find(({ branch }) =>
        branch && (branch === pr.headRefName || branch === `orch/pr-${pr.number}`))
      return { ...pr, worktreeID: match?.worktree.id ?? null, worktreeName: match?.worktree.name ?? null }
    })
    return { ...result, prs }
  }

  app.get('/api/prs', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.query.project)
    if (!project) return response.status(404).json({ error: 'No such project' })
    response.json(await withWorktrees(project, await prCache.list(project.id, project.path, request.query.refresh === '1')))
  })

  app.get('/api/prs/details', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.query.project)
    if (!project) return response.status(404).json({ error: 'No such project' })
    response.json(await withWorktrees(project, await prCache.details(project.id, project.path)))
  })

  /** Every conversation on the pull request for a worktree's branch, for the review panel. */
  app.get('/api/pr/conversations', async (request, response) => {
    const path = String(request.query.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    const branch = String(request.query.branch ?? '')
    if (!branch) return response.status(400).json({ error: 'branch required' })
    response.json(await pullRequestConversations(path, branch))
  })

  /** A review comment on one line. The line must be in the head commit, so the caller sends its sha. */
  app.post('/api/pr/comment', async (request, response) => {
    // express.json always leaves an object here, even for a body it did not parse.
    const body = request.body
    const path = String(body.path ?? '')
    if (refuseOutsideRoots(path, response)) return
    const line = Number(body.line)
    if (!body.file || !Number.isInteger(line) || line < 1 || !String(body.body ?? '').trim()) {
      return response.status(400).json({ error: 'file, a whole line number and a body are required' })
    }
    const result = await postLineComment({
      projectPath: path, prNumber: Number(body.prNumber), commitSHA: String(body.commitSHA ?? ''),
      file: String(body.file), line, body: String(body.body),
    })
    response.status(result.ok ? 200 : 502).json(result)
  })

  app.get('/api/github/comments', async (request, response) => {
    const project = state.projects.find((candidate) => candidate.id === request.query.project)
    if (!project) return response.status(404).json({ error: 'No such project' })
    response.json(await listMyPRComments(project.path))
  })

  const PR_REVIEW_GROUP = 'PR Reviews'

  /** Worktree + session for a pull request, then the first prompt, in one action. */
  async function openPRWorkspace(options: {
    projectID: string
    prNumber: number
    group: string | null
    title: string
    prompt: string
  }) {
    const project = state.projects.find((candidate) => candidate.id === options.projectID)
    if (!project) throw new Error('No such project')

    // A PR's branch can only be checked out once: a second review or an autofix of a PR that
    // already has a worktree opens a new session in that worktree instead of failing.
    // git decides which worktree holds the PR branch; the record only caches what it last said.
    const live = await Promise.all(
      state.worktrees
        .filter((candidate) => candidate.projectID === project.id && !candidate.isArchived)
        .map(async (candidate) => ({ candidate, branch: await gitService.currentBranch(candidate.path) })))
    let worktree = live.find(({ branch }) => branch === `orch/pr-${options.prNumber}`)?.candidate
    if (!worktree) {
      if (options.group) {
        project.worktreeGroups = [...new Set([...(project.worktreeGroups), options.group])]
      }
      const created = await worktreeService.createPRWorktree({
        projectPath: project.path, projectName: project.name, prNumber: options.prNumber,
        group: options.group, rootOverride: state.settings.worktreeRoot,
      })
      const prBase = await pullRequestBase(project.path, options.prNumber)
      worktree = {
        id: crypto.randomUUID(), projectID: project.id,
        name: `PR #${options.prNumber}`, path: created.path, branch: created.branch,
        // A pull request is measured against the branch it was opened on, which need not be main.
        baseBranch: prBase ?? await gitService.defaultBranch(project.path),
        isMain: false, isExpanded: true, isPinned: false, isArchived: false,
        group: options.group,
      }
      state.worktrees.push(worktree)
      await stackOnParent(worktree, project, prBase)
    }

    const session: Session = {
      id: crypto.randomUUID(), worktreeID: worktree.id, title: options.title,
      engine: 'claude', accessMode: 'edits', steeringMode: 'steer',
      model: null, effort: null, claudeSessionID: null, codexThreadID: null,
      isPinned: false, isArchived: false,
      totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    }
    state.sessions.push(session)
    saveState(state)
    pushState()

    state.queuedMessages[session.id] = [...(state.queuedMessages[session.id] ?? []), options.prompt]
    append(session.id, { role: 'user', text: options.prompt, engine: session.engine })
    saveState(state)
    launchQueued(session.id)
    return { worktree, session }
  }

  /** The worktree for a PR's branch — reused, checked out, or a copy of the head when it cannot be. */
  app.post('/api/pr/worktree', async (request, response) => {
    const { projectID, prNumber, branch } = request.body
    const project = state.projects.find((candidate) => candidate.id === projectID)
    if (!project) return response.status(404).json({ error: 'No such project' })
    const number = Number(prNumber)
    try {
      const live = await Promise.all(
        state.worktrees
          .filter((worktree) => worktree.projectID === project.id && !worktree.isArchived)
          .map(async (worktree) => ({ worktree, branch: await gitService.currentBranch(worktree.path) })))
      const match = live.find((entry) => entry.branch === branch || entry.branch === `orch/pr-${number}`)
      if (match) return response.json({ ok: true, worktree: match.worktree, copied: false, reused: true })

      const created = await worktreeService.createPRBranchWorktree({
        projectPath: project.path, projectName: project.name, prNumber: number,
        branch: String(branch), group: DEFAULT_GROUP, rootOverride: state.settings.worktreeRoot,
      })
      const prBase = await pullRequestBase(project.path, number)
      const worktree = {
        id: crypto.randomUUID(), projectID: project.id,
        name: created.branch.replace(/^orch\//, ''), path: created.path, branch: created.branch,
        baseBranch: prBase ?? await gitService.defaultBranch(project.path),
        isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: DEFAULT_GROUP,
      }
      state.worktrees.push(worktree)
      await stackOnParent(worktree, project, prBase)
      saveState(state)
      pushState()
      response.json({ ok: true, worktree, copied: created.copied, reused: false })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/pr/review', async (request, response) => {
    const { projectID, prNumber, title } = request.body
    const project = state.projects.find((candidate) => candidate.id === projectID)
    if (!project) return response.status(404).json({ error: 'No such project' })
    try {
      const command = reviewerCommand(project.name, project.path)
      const result = await openPRWorkspace({
        projectID, prNumber: Number(prNumber), group: PR_REVIEW_GROUP,
        title: `Review PR #${prNumber}${title ? `: ${title}` : ''}`,
        prompt: `${command} Review pull request #${prNumber} — the branch checked out in this worktree.`,
      })
      response.json({ ok: true, ...result, command })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  app.post('/api/pr/autofix', async (request, response) => {
    const { projectID, prNumber, title } = request.body
    try {
      // Fixes land in the project's own worktree root, not the review group.
      const result = await openPRWorkspace({
        projectID, prNumber: Number(prNumber), group: null,
        title: `Fix comments on PR #${prNumber}${title ? `: ${title}` : ''}`,
        prompt: `Fix all review comments left under pull request #${prNumber}. `
          + 'Read them with the GitHub CLI (gh pr view --comments and '
          + `gh api repos/{owner}/{repo}/pulls/${prNumber}/comments), then make the changes. `
          + 'Do NOT reply to the comments and do not post anything to GitHub.',
      })
      response.json({ ok: true, ...result })
    } catch (error) {
      response.status(500).json({ error: (error as Error).message })
    }
  })

  // ---- language servers (go to definition, hover types) ----------------------------------

  app.get('/api/lsp/status', (request, response) => {
    response.json(lspStatus(String(request.query.path ?? '')))
  })

  // ---- the sidebar's moves, for agents ---------------------------------------------------------

  /** An operation does what the same click does because it goes through the same route. */
  const controlContext = (sessionID: string | null): ControlContext => ({
    sessionID,
    workspace: () => ({
      projects: state.projects, worktrees: state.worktrees, sessions: state.sessions, stacks: state.stacks,
      running: [...running.keys()],
    }),
    call: async (method, path, body) => {
      const reply = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      })
      const answer = await reply.json()
      if (!reply.ok) throw new Error(answer.error)
      return answer
    },
  })

  /** Shows a request in the session's chat and waits for the person's answer to it. */
  function askPerson(sessionID: string, toolName: string, input: unknown, toolUseID: string): Promise<PermissionDecision> {
    const session = state.sessions.find((candidate) => candidate.id === sessionID)!
    const permission: PermissionRequest = { id: crypto.randomUUID(), toolName, input, toolUseID, status: 'pending' }
    const item = append(sessionID, { role: 'permission', text: `${toolName} needs your answer`, permission, engine: session.engine })
    const asked: Asked = { sessionID, itemID: item.id, permission }
    permissionItems.set(permission.id, asked)
    pushRunning()
    return broker.ask(permission, sessionID, () => settlePermission(permission.id, asked, { status: 'expired' }))
  }

  /**
   * The app asks about its own tools itself, the same card for Claude and Codex: a session without
   * full access changes nothing in the sidebar until the person says yes.
   */
  const controlTools = (sessionID: string): MCPTool[] => CONTROL_OPERATIONS.map((operation) => ({
    name: operation.name, description: operation.description, inputSchema: operation.inputSchema,
    call: async (args) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionID)!
      if (!operation.readOnly && session.accessMode !== 'full') {
        const decision = await askPerson(sessionID, `mcp__${PROMPT_SERVER}__${operation.name}`, args, crypto.randomUUID())
        if (decision.behavior === 'deny') throw new Error(decision.message)
      }
      return JSON.stringify(await runControl(operation.name, args, controlContext(sessionID)))
    },
  }))

  app.get('/api/control', (_request, response) => {
    response.json({
      usage: 'POST /api/control/<name> with the arguments as a JSON body.',
      operations: CONTROL_OPERATIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
  })

  app.post('/api/control/:name', async (request, response) => {
    try {
      response.json({ ok: true, result: await runControl(request.params.name, request.body, controlContext(null)) })
    } catch (error) {
      response.status(400).json({ error: (error as Error).message })
    }
  })

  // ---- the permission host Claude Code talks to ---------------------------------------------

  app.post('/mcp/:token', async (request, response) => {
    const sessionID = promptTokens.get(request.params.token)
    if (!sessionID) return response.status(404).json({ error: 'No such turn' })
    const result = await handleMCP(request.body, [
      approveTool((args) => askPerson(sessionID, args.tool_name, args.input, args.tool_use_id)),
      renameTool((title) => renameByRequest(sessionID, title)),
      ...controlTools(sessionID),
    ], '0.1.0')
    for (const [name, value] of Object.entries(result.headers ?? {})) response.set(name, value)
    if (result.body === undefined) return response.status(result.status).end()
    response.status(result.status).json(result.body)
  })
  /**
   * The turn's stop hook: Claude Code asks before it ends a turn. While something the agent started is
   * still running in the background the answer is no, with why, because ending the turn kills it.
   */
  app.get('/mcp/:token/stop', (request, response) => {
    const active = running.get(promptTokens.get(request.params.token) ?? '')
    if (!active?.background.length || active.stopsRefused >= STOP_REFUSALS) return response.json({})
    active.stopsRefused += 1
    response.json({
      decision: 'block',
      reason: `Still running in the background: ${active.background.map(describeTask).join('; ')}. `
        + 'This turn is a one-shot process: when it ends they are killed, and nothing wakes you when they finish. '
        + 'Wait for them now (sleep and read their output, or block on them), then give your final answer. '
        + 'Stop any you no longer need. If one is meant to outlive this turn, stop it, start it again fully detached (nohup … &) and say so.',
    })
  })
  app.get('/mcp/:token', (_request, response) => response.status(405).end())
  app.delete('/mcp/:token', (_request, response) => response.status(405).end())

  /** The person's answer to a request shown in the chat. */
  app.post('/api/permission/:id', (request, response) => {
    const asked = permissionItems.get(request.params.id)
    if (!asked) return response.status(404).json({ error: 'Nothing is waiting for that answer' })
    const body = request.body
    let decision: PermissionDecision
    let changes: Partial<PermissionRequest>
    if (body.behavior === 'allow') {
      const answers = body.answers ? body.answers as Record<string, string | string[]> : undefined
      decision = asked.permission.toolName === 'AskUserQuestion' && answers
        ? askUserAnswer(asked.permission.input, answers)
        : { behavior: 'allow', updatedInput: asked.permission.input }
      changes = { status: 'allowed', answers }
    } else {
      const message = String(body.message ?? '').trim() || 'The user denied this.'
      decision = { behavior: 'deny', message }
      changes = { status: 'denied', message }
    }
    settlePermission(request.params.id, asked, changes)
    broker.answer(request.params.id, decision)
    response.json({ ok: true })
  })

  app.post('/api/lsp/definition', async (request, response) => {
    const { workspace, path, line, character } = request.body
    response.json(await definition(String(workspace), String(path), Number(line), Number(character)))
  })

  app.post('/api/lsp/references', async (request, response) => {
    const { workspace, path, line, character } = request.body
    response.json(await references(String(workspace), String(path), Number(line), Number(character)))
  })

  app.post('/api/lsp/hover', async (request, response) => {
    const { workspace, path, line, character } = request.body
    response.json(await hover(String(workspace), String(path), Number(line), Number(character)))
  })

  // ---- settings ---------------------------------------------------------------------------

  /** The page reports what it is showing so a turn the user watched does not also ping them. */
  app.post('/api/attention', (request, response) => {
    setAttention(
      request.body.sessionID ? String(request.body.sessionID) : null,
      !!request.body.focused)
    response.json({ ok: true })
  })

  // ---- tasks: every running agent, what it is doing, and its processes -----------------

  /** pid -> { ppid, command } for the whole machine, from one ps call. */
  /** What one session is doing now: tools in flight, the processes under its agent, its subagents' transcripts. */
  app.get('/api/session/:id/activity', (request, response) => {
    const session = state.sessions.find((candidate) => candidate.id === request.params.id)
    if (!session) return response.status(404).json({ error: 'No such session' })
    const active = running.get(session.id)
    const activity: SessionActivity = {
      running: !!active,
      startedAt: active?.startedAt ?? null,
      tools: active ? [...active.inFlight.entries()].map(([id, tool]) => ({ id, ...tool })) : [],
      background: active?.background ?? [],
      finished: active?.finished ?? lastFinished.get(session.id) ?? [],
      processes: active ? descendantsOf(active.pid, processTable()) : [],
      agents: subagentTranscripts(worktreeFor(session).path, session.claudeSessionID),
    }
    response.json(activity)
  })

  app.get('/api/tasks', (_request, response) => {
    const table = processTable()
    const tasks = [...running.entries()].map(([sessionID, active]) => ({
      sessionID, title: active.session.title, engine: active.engine,
      worktree: worktreeFor(active.session).name, pid: active.pid, startedAt: active.startedAt,
      tools: [...active.inFlight.entries()].map(([id, tool]) => ({ id, ...tool })),
      background: active.background,
      finished: active.finished,
      processes: descendantsOf(active.pid, table),
    }))
    response.json({ tasks, terminals: listTerminals() })
  })

  /** Kills one process tree under one of our agents; anything else is refused. */
  app.delete('/api/tasks/process/:pid', (request, response) => {
    const pid = Number(request.params.pid)
    const table = processTable()
    const ours = [...running.values()].some((active) =>
      active.pid === pid || descendantsOf(active.pid, table).some((entry) => entry.pid === pid))
    if (!ours) return response.status(403).json({ error: 'That process does not belong to an agent of this app.' })
    killTree(pid, 'SIGKILL')
    response.json({ ok: true })
  })

  app.get('/api/settings', (_request, response) => response.json(state.settings))
  /** The models each engine offers now, from the engines' own caches. */
  app.get('/api/models', (_request, response) => response.json(modelCatalog()))

  app.put('/api/settings', (request, response) => {
    state.settings = { ...state.settings, ...(request.body) }
    saveState(state)
    pushState()
    response.json(state.settings)
  })

  app.get('/api/voice/status', (_request, response) => response.json(voiceStatus()))

  app.post('/api/voice/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (request, response) => {
    try {
      response.json({ text: await transcribe(request.body as Buffer) })
    } catch (error) {
      response.status(503).json({ error: (error as Error).message })
    }
  })

  // Each terminal socket attaches to one pty; the shell itself outlives page reloads.
  terminalSockets.on('connection', (socket, request) => {
    const id = new URL(String(request.url), 'http://localhost').searchParams.get('id') ?? ''
    const handle = getTerminal(id)
    if (!handle) { socket.close(4004, 'no such terminal'); return }
    if (handle.scrollback) socket.send(handle.scrollback)
    const subscription = handle.process.onData((chunk) => socket.send(chunk, ignoreSendError))
    const exit = handle.process.onExit(({ exitCode }) => {
      socket.send(`\r\n[process exited with code ${exitCode}]\r\n`, ignoreSendError)
      socket.close()
    })
    socket.on('message', (raw) => {
      let message: any
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message.type === 'input') handle.process.write(String(message.data ?? ''))
      else if (message.type === 'resize') handle.process.resize(Number(message.cols) || 80, Number(message.rows) || 24)
    })
    socket.on('close', () => { subscription.dispose(); exit.dispose() })
  })

  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.send(JSON.stringify(stateEvent() satisfies ServerEvent))
    socket.send(JSON.stringify({ type: 'running', sessionIDs: [...running.keys()] } satisfies ServerEvent))
    socket.on('close', () => clients.delete(socket))
  })

  /** Ends everything that would otherwise outlive the process: agents, shells, language servers. */
  function windDown() {
    closeAllTerminals()
    for (const [, active] of running) killTree(active.pid, 'SIGKILL')
    stopAllLanguageServers()
    writeRunningRecord(RUNNING_RECORD, {})
    saveState(state)
  }
  function shutdown() {
    windDown()
    process.exit(0)
  }
  if (options.signals !== false) {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
  // Electron quits without signalling itself, so the shell calls this directly on before-quit.
  // Without it every running agent would be orphaned when the window closes.
  ;(globalThis as Record<string, unknown>).orchestratorShutdown = windDown

  if (staticRoot) {
    app.get('*', (_request, response) => response.sendFile(`${staticRoot}/index.html`))
  }

  /**
   * Watches for comments other people leave on the user's open PRs. The first poll of a project
   * only records what is already there: nobody wants seventeen notifications on launch.
   */
  const REQUESTED_POLL = Number(process.env.ORCHESTRATOR_POLL_MS)
  const POLL_INTERVAL = Number.isFinite(REQUESTED_POLL) && REQUESTED_POLL > 0 ? REQUESTED_POLL : 3 * 60 * 1000

  async function pollGitHubComments() {
    for (const project of state.projects) {
      prCache.warm(project.id, project.path)
      const result = await listMyPRComments(project.path)
      if (!result.ok) continue
      const firstPoll = !state.seenComments[project.id]
      const seen = new Set(state.seenComments[project.id] ?? [])
      const fresh = result.comments.filter((comment) => !seen.has(comment.id))
      if (!firstPoll) {
        for (const comment of fresh.slice(0, 5)) {
          raise({
            title: `${comment.author} commented on #${comment.prNumber}`,
            body: comment.body.replace(/\s+/g, ' ').slice(0, 180),
            sound: 'Submarine', tab: 'github',
          })
        }
        if (fresh.length > 5) {
          raise({
            title: `${fresh.length - 5} more comments`,
            body: `on your open pull requests in ${project.name}.`,
            sound: 'Submarine', tab: 'github',
          })
        }
      }
      // Keep the list bounded: only ids still visible on open PRs matter.
      state.seenComments[project.id] = result.comments.map((comment) => comment.id)
      saveState(state)
    }
  }

  const poll = () => pollGitHubComments().catch(reportFailure)
  /** Checks GitHub for new comments on your pull requests now rather than at the next poll. */
  app.post('/api/github/poll', async (_request, response) => { await poll(); response.json({ ok: true }) })
  // With background off (tests) the timers exist only to be cleared: they never fire on their own.
  const githubTimer = setInterval(poll, options.background === false ? 1 << 30 : POLL_INTERVAL)
  const githubKickoff = setTimeout(poll, options.background === false ? 1 << 30 : 5000)

  // Worktrees named before their sessions were take their first session's name now.
  const homed = state.sessions.filter((session) => state.worktrees.some((worktree) => worktree.id === session.worktreeID))
  if (homed.map(inheritWorktreeName).some(Boolean)) saveState(state)
  await refreshBranches()
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()))
  const boundPort = (server.address() as AddressInfo).port
  PORT = boundPort
  console.log(`orchestrator server on http://127.0.0.1:${boundPort}`)
  // Where this server answers, for `sloperator` run from outside the app.
  writeFileSync(join(dirname(RUNNING_RECORD), 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, pid: process.pid }))

  /** Stops everything this server started: agents, shells, language servers, timers, sockets. */
  async function stop() {
    clearInterval(githubTimer)
    clearTimeout(githubKickoff)
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    windDown()
    for (const client of clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return { app, server, port: boundPort, stop, state }

}
