import type { SplitTotals } from './testPaths.ts'
export type { SplitTotals }
export type EngineKind = 'claude' | 'codex'
export type AccessMode = 'safe' | 'edits' | 'full'
export type SteeringMode = 'steer' | 'queue'

export interface Project {
  id: string
  name: string
  path: string
  isGit: boolean
  isExpanded: boolean
  /// Sub-directories the user has made under the worktree root, e.g. "work", "review".
  /// Empty by default: nothing is created until they ask for it.
  worktreeGroups: string[]
}

export interface Worktree {
  id: string
  projectID: string
  name: string
  path: string
  branch: string | null
  baseBranch: string | null
  isMain: boolean
  isExpanded: boolean
  /// Which group directory it lives in; null means directly under the worktree root.
  group?: string | null
  isPinned?: boolean
  isArchived?: boolean
  /** Named by the person: it no longer takes its first session's name. */
  nameIsManual?: boolean
}

export interface Session {
  id: string
  worktreeID: string
  title: string
  engine: EngineKind
  accessMode: AccessMode
  steeringMode: SteeringMode
  model?: string | null
  effort?: string | null
  claudeSessionID?: string | null
  codexThreadID?: string | null
  isPinned?: boolean
  isArchived?: boolean
  /** Typed by the person: never renamed on its own again, only when they ask. */
  titleIsManual?: boolean
  totalCostUSD: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export type TranscriptRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'info' | 'error' | 'permission'

/** What Claude asked when it needed a person: permission for a tool, or answers to its questions. */
export interface PermissionRequest {
  id: string
  toolName: string
  /** The tool's input, exactly as Claude proposed it. For AskUserQuestion: `{ questions: [...] }`. */
  input: unknown
  toolUseID: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  /** For AskUserQuestion, what was chosen, keyed by the question text. */
  answers?: Record<string, string | string[]>
  /** Why it was denied, or what the person typed instead of choosing. */
  message?: string
}

/** The person's decision, in the shape Claude Code's permission host expects. */
/** One thing a subagent said or ran, from its transcript on disk. */
export interface AgentRow { role: 'assistant' | 'tool' | 'info'; text: string }
export interface AgentTranscript {
  id: string
  updatedAt: number
  idleMS: number
  prompt: string
  rows: AgentRow[]
  /** True when the transcript is longer than the rows kept here. */
  truncated: boolean
}
export interface ActiveTool { id: string; name: string; detail: string; startedAt: number; input?: unknown }
/** A tool call that ended during the turn, with what it printed (trimmed for the panel). */
export interface FinishedTool extends ActiveTool { endedAt: number; output: string; failed: boolean }
/** A process under the agent: elapsed seconds and CPU share as ps reports them. */
export interface ActiveProcess { pid: number; ppid: number; command: string; depth: number; elapsed: number; cpu: number }
/** Something the agent started and left running behind its turn: a command, or a subagent. */
export interface BackgroundTask { id: string; kind: 'command' | 'agent'; description: string; startedAt: number }
/** What a session is doing right now, and what its subagents have done. */
export interface SessionActivity {
  running: boolean
  startedAt: number | null
  tools: ActiveTool[]
  /** Still going behind the turn. Only a running turn has any: they end with it. */
  background: BackgroundTask[]
  /** This turn's finished tool calls while it runs; the last turn's once it has ended. */
  finished: FinishedTool[]
  processes: ActiveProcess[]
  agents: AgentTranscript[]
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string }

export interface TranscriptItem {
  id: string
  role: TranscriptRole
  text: string
  toolName?: string
  /** The tool's input as Claude sent it, so the row can show a command, a path or a question properly. */
  toolInput?: unknown
  toolOutput?: string
  /** Present on a 'permission' item: the request, and how it was answered. */
  permission?: PermissionRequest
  engine?: EngineKind
  /** An error the engine can be asked to pick up from: the UI offers Continue. */
  canRetry?: boolean
  timestamp: number
}

/** Everything the server pushes to the UI. */
export interface Notice {
  title: string
  body: string
  sound?: string
  sessionID?: string
  tab?: 'sessions' | 'github'
}

export type ServerEvent =
  | { type: 'state'; projects: Project[]; worktrees: Worktree[]; sessions: Session[]; stacks: StackView[] }
  | { type: 'transcript'; sessionID: string; items: TranscriptItem[] }
  | { type: 'append'; sessionID: string; item: TranscriptItem }
  | { type: 'patch'; sessionID: string; itemID: string; toolOutput: string }
  | { type: 'permission'; sessionID: string; itemID: string; permission: PermissionRequest }
  | { type: 'running'; sessionIDs: string[]; asking?: string[] }
  | { type: 'session'; session: Session }
  | { type: 'error'; message: string }
  | { type: 'notify'; notice: Notice }

export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'hunkHeader'

export interface DiffLine {
  id: number
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface DiffHunk {
  id: number
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string | null
  status: 'A' | 'M' | 'D' | 'R'
  added: number
  removed: number
  isBinary: boolean
  hunks: DiffHunk[]
}

// ---- pull requests -----------------------------------------------------------------------

/** What the viewer themselves has done on a pull request, and what is still waiting for them. */
export interface PRActivity {
  inlineComments: number
  discussionComments: number
  commits: number
  reviews: number
  reviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | null
  threadsOpen: number
  threadsResolved: number
  threadsForMe: number
}

export interface GitHubUser { login: string; avatarUrl: string }

export type PRState = 'open' | 'draft' | 'merged' | 'closed'

/** One folder's sub-folders, for browsing to a project. */
export interface FolderListing {
  path: string
  parent: string | null
  isGit: boolean
  folders: Array<{ name: string; path: string; isGit: boolean }>
  /** How many more folders there are than the ones listed. */
  more: number
}

/** Worktrees whose branches build on each other, bottom first: each layer's base is the one below it. */
export interface Stack {
  id: string
  projectID: string
  name: string
  /** What the bottom layer builds on: the project's default branch when the stack was made. */
  base: string
  /** Worktree ids, bottom first. */
  layers: string[]
}
/** A layer's open pull request, as far as the PR list already fetched knows. */
export interface LayerPR { number: number; url: string; state: PRState }
export interface StackView extends Stack { prs: Array<LayerPR | null> }
/** What one step of a stack operation did to one layer. */
export interface LayerResult {
  worktreeID: string
  branch: string
  status: 'merged' | 'up-to-date' | 'conflict' | 'failed' | 'created' | 'exists' | 'landed'
  message: string
  url?: string
}
export type CheckResult = 'pass' | 'fail' | 'pending' | 'skipped'
export interface CheckRun { name: string; result: CheckResult; url: string | null }

/** A teammate's part in a PR: their latest verdict and how much they said. */
export interface Participant {
  login: string
  avatarUrl: string
  verdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | null
  inlineComments: number
  discussionComments: number
}

export interface PullRequest {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName: string
  state: PRState
  mergedAt: string | null
  closedAt: string | null
  isDraft: boolean
  author: string
  authorAvatar: string
  assignees: GitHubUser[]
  /** Requested reviewers (logins and team names); `reviewRequested` says whether you are one. */
  reviewers: string[]
  reviewRequested: boolean
  isMine: boolean
  createdAt: string
  updatedAt: string
  lastCommitAt: string | null
  commitCount: number
  additions: number
  deletions: number
  changedFiles: number
  checks: 'pass' | 'fail' | 'pending' | ''
  /** Every check on the head commit, so a failure can be named without opening GitHub. */
  checkRuns: CheckRun[]
  /** Unread GitHub notifications for you on this PR. */
  unread: number
  linearKey: string | null
  linearURL: string | null
  /** Second tier: only after the detailed query has answered. */
  totals: SplitTotals | null
  activity: PRActivity | null
  participants: Participant[] | null
}

/** A row as the server hands it over: the pull request plus the worktree holding its branch. */
export interface PRRow extends PullRequest {
  worktreeID: string | null
  worktreeName: string | null
}

export interface PRListing {
  ok: true
  viewer: string | null
  prs: PRRow[]
  fetchedAt: number
  /** The detailed tier is still on its way: ask `/api/prs/details` for the rest. */
  pending: boolean
}

export type PRResult = PRListing | { ok: false; message: string }

/** One comment inside a pull-request conversation. */
export interface PRThreadComment {
  id: string
  author: string
  avatarURL: string | null
  body: string
  createdAt: string
  url: string
}

/**
 * A review conversation anchored to a line, or a general one on the pull request itself.
 * A thread whose line no longer exists in the head is `outdated`: it keeps the snippet it was
 * written against, and nothing in the current diff can be pointed at.
 */
export interface PRThread {
  id: string
  /** Null for a general conversation on the pull request rather than on a line. */
  path: string | null
  /** The line in the head commit, or null once the thread went outdated. */
  line: number | null
  /** Where it was written, which survives the line going away. */
  originalLine: number | null
  outdated: boolean
  resolved: boolean
  /** The diff it was written against, so an outdated thread still shows its code. */
  snippet: string | null
  comments: PRThreadComment[]
}

export interface PRConversations {
  ok: true
  number: number
  title: string
  url: string
  /** The commit the line numbers refer to; a comment can only be posted against this. */
  headSHA: string
  threads: PRThread[]
}

export type PRConversationResult = PRConversations | { ok: false; message: string }
