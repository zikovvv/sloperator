import { DEFAULT_CLAUDE_PRICING, type ClaudePricing } from './usage.ts'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project, Session, TranscriptItem, Worktree } from '../shared/types.ts'

/** The same directory the native app used, so existing projects and sessions carry over. */
function defaultRoot(): string {
  // Under vitest the state directory must be a throwaway one: the user's real state is off limits.
  if (process.env.VITEST) {
    throw new Error('Refusing to touch the real state directory from a test: set ORCHESTRATOR_STATE_DIR')
  }
  return join(homedir(), 'Library/Application Support/ClaudeOrchestrator')
}

const ROOT = process.env.ORCHESTRATOR_STATE_DIR ?? defaultRoot()
const STATE = join(ROOT, 'state.json')
const TRANSCRIPTS = join(ROOT, 'transcripts')

import { STRONGEST_MODEL } from '../shared/models.ts'
export { STRONGEST_MODEL }

/**
 * What a new session starts with. The engine is always Claude; the model and effort are the
 * last ones used on that engine; access and steering are whatever was last chosen anywhere.
 */
export interface SessionDefaults {
  accessMode: Session['accessMode']
  steeringMode: Session['steeringMode']
  models: Record<Session['engine'], { model: string; effort: string | null }>
}

export const DEFAULT_SESSION_SETTINGS: SessionDefaults = {
  // A message sent mid-run is delivered when the turn ends; interrupting is the opt-in.
  accessMode: 'edits', steeringMode: 'queue',
  models: { claude: { model: STRONGEST_MODEL.claude, effort: null }, codex: { model: STRONGEST_MODEL.codex, effort: null } },
}

export interface AppSettings {
  worktreeRoot: string | null
  sessionDefaults: SessionDefaults
  /** Linear workspace slug (linear.app/<slug>/…); learned from PR bodies when unset. */
  linearWorkspace: string | null
  codexPricing: { input: number; cached: number; output: number }
  /// USD per million tokens by Claude model family, used for the API-equivalent figures.
  claudePricing: ClaudePricing
}

export interface AppState {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  queuedMessages: Record<string, string[]>
  drafts: Record<string, string>
  /// How many transcript items each engine has already been shown, per session. Drives the
  /// context bridge when the engine is switched mid-conversation.
  lastSeen: Record<string, Partial<Record<'claude' | 'codex', number>>>
  /// GitHub comment ids already reported, per project, so a restart does not re-announce them.
  seenComments: Record<string, string[]>
  /// What the last finished turn in each worktree changed: the working tree before and after it.
  lastTurn: Record<string, LastTurn>
  settings: AppSettings
}

export interface LastTurn {
  before: string
  after: string
  sessionID: string
  endedAt: number
}

const DEFAULT_SETTINGS: AppSettings = {
  worktreeRoot: null,
  sessionDefaults: { ...DEFAULT_SESSION_SETTINGS },
  linearWorkspace: null,
  codexPricing: { input: 1.25, cached: 0.125, output: 10 },
  claudePricing: DEFAULT_CLAUDE_PRICING,
}

/** Missing keys fall back to defaults — never throw away someone's whole state file. */
function normalizeSession(raw: any): Session {
  return {
    id: raw.id ?? crypto.randomUUID(),
    worktreeID: raw.worktreeID,
    title: raw.title ?? 'Session',
    engine: raw.engine === 'codex' ? 'codex' : 'claude',
    accessMode: raw.accessMode ?? 'edits',
    steeringMode: raw.steeringMode ?? DEFAULT_SESSION_SETTINGS.steeringMode,
    // A session that never chose a model now runs the strongest one, and the header says so.
    model: raw.model ?? STRONGEST_MODEL[raw.engine === 'codex' ? 'codex' : 'claude'],
    effort: raw.effort ?? null,
    claudeSessionID: raw.claudeSessionID ?? null,
    codexThreadID: raw.codexThreadID ?? null,
    isPinned: !!raw.isPinned,
    isArchived: !!raw.isArchived,
    titleIsManual: !!raw.titleIsManual,
    totalCostUSD: raw.totalCostUSD ?? 0,
    inputTokens: raw.inputTokens ?? 0,
    cachedInputTokens: raw.cachedInputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
  }
}

export function loadState(): AppState {
  mkdirSync(TRANSCRIPTS, { recursive: true })
  if (!existsSync(STATE)) {
    return { projects: [], worktrees: [], sessions: [], queuedMessages: {}, drafts: {},
             lastSeen: {}, seenComments: {}, lastTurn: {}, settings: { ...DEFAULT_SETTINGS, sessionDefaults: normalizeDefaults(undefined) } }
  }
  try {
    const raw = JSON.parse(readFileSync(STATE, 'utf8'))
    // Before per-engine defaults steer was the hard default; new sessions inherit the last session's
    // mode, so a legacy file would perpetuate steer forever. Move such a file to the queue default
    // once. Written back with `models`, a mode is a stored choice and stays.
    const legacy = !raw.settings?.sessionDefaults?.models
    return {
      projects: (raw.projects ?? []).map((project: any) => ({
        id: project.id ?? crypto.randomUUID(),
        name: project.name ?? 'Project',
        path: project.path,
        isGit: project.isGit ?? true,
        isExpanded: project.isExpanded ?? true,
        worktreeGroups: [...new Set(['main', ...(project.worktreeGroups ?? [])])],
      })),
      worktrees: (raw.worktrees ?? []).map((worktree: any) => ({
        id: worktree.id ?? crypto.randomUUID(),
        projectID: worktree.projectID,
        name: worktree.name ?? 'worktree',
        path: worktree.path,
        branch: null,
        baseBranch: worktree.baseBranch ?? null,
        isMain: !!worktree.isMain,
        isExpanded: worktree.isExpanded ?? true,
        isPinned: !!worktree.isPinned,
        isArchived: !!worktree.isArchived,
        group: worktree.group ?? null,
        nameIsManual: !!worktree.nameIsManual,
      })),
      sessions: (raw.sessions ?? []).map((session: any) => normalizeSession(legacy ? { ...session, steeringMode: 'queue' } : session)),
      queuedMessages: raw.queuedMessages ?? {},
      drafts: raw.drafts ?? {},
      lastSeen: raw.lastSeen ?? {},
      seenComments: raw.seenComments ?? {},
      lastTurn: raw.lastTurn ?? {},
      settings: {
        ...DEFAULT_SETTINGS,
        ...(raw.settings ?? {}),
        sessionDefaults: normalizeDefaults(raw.settings?.sessionDefaults),
        codexPricing: { ...DEFAULT_SETTINGS.codexPricing, ...(raw.settings?.codexPricing ?? {}) },
        claudePricing: Object.fromEntries(Object.entries(DEFAULT_CLAUDE_PRICING).map(([model, rates]) =>
          [model, { ...rates, ...(raw.settings?.claudePricing?.[model] ?? {}) }])),
      },
    }
  } catch (error) {
    // Never start empty and then overwrite the only copy.
    const backup = `${STATE}.corrupt-${Date.now()}`
    renameSync(STATE, backup)
    console.error(`state.json could not be read; set aside at ${backup}`, error)
    return { projects: [], worktrees: [], sessions: [], queuedMessages: {}, drafts: {},
             lastSeen: {}, seenComments: {}, lastTurn: {}, settings: { ...DEFAULT_SETTINGS, sessionDefaults: normalizeDefaults(undefined) } }
  }
}

/** Older files carried one engine/model pair; the per-engine shape keeps what it can of it. */
function normalizeDefaults(raw: any): SessionDefaults {
  const stored = raw ?? {}
  const legacy = !stored.models
  const models = { ...DEFAULT_SESSION_SETTINGS.models, ...(stored.models ?? {}) }
  if (legacy && stored.engine && stored.model) {
    models[stored.engine as Session['engine']] = { model: stored.model, effort: stored.effort ?? null }
  }
  return {
    accessMode: stored.accessMode ?? DEFAULT_SESSION_SETTINGS.accessMode,
    steeringMode: (legacy ? null : stored.steeringMode) ?? DEFAULT_SESSION_SETTINGS.steeringMode,
    models: {
      claude: { model: models.claude?.model || STRONGEST_MODEL.claude, effort: models.claude?.effort ?? null },
      codex: { model: models.codex?.model || STRONGEST_MODEL.codex, effort: models.codex?.effort ?? null },
    },
  }
}

function writeAtomic(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, contents)
  renameSync(temporary, path)
}

export function saveState(state: AppState) {
  // branch is read from git on demand; persisting it is what let it go stale.
  const worktrees = state.worktrees.map(({ branch: _branch, ...rest }) => rest)
  writeAtomic(STATE, JSON.stringify({ ...state, worktrees }, null, 2))
}

export const RUNNING_RECORD = join(ROOT, 'running.json')

export function transcriptPath(sessionID: string): string {
  return join(TRANSCRIPTS, `${sessionID}.json`)
}

export function loadTranscript(sessionID: string): TranscriptItem[] {
  const path = transcriptPath(sessionID)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return (raw as any[]).map((item) => ({
      id: item.id ?? crypto.randomUUID(),
      role: item.role,
      text: item.text ?? '',
      toolName: item.toolName ?? undefined,
      toolOutput: item.toolOutput ?? undefined,
      engine: item.engine ?? undefined,
      canRetry: item.canRetry ?? undefined,
      toolInput: item.toolInput ?? undefined,
      permission: item.permission ?? undefined,
      // Swift wrote seconds since 2001; anything smaller than a year is not a JS timestamp.
      timestamp: typeof item.timestamp === 'number'
        ? (item.timestamp < 1e11 ? (item.timestamp + 978307200) * 1000 : item.timestamp)
        : Date.now(),
    }))
  } catch {
    return []
  }
}

export function saveTranscript(sessionID: string, items: TranscriptItem[]) {
  writeAtomic(transcriptPath(sessionID), JSON.stringify(items))
}
