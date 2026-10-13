import type { EngineKind, PRResult, Session } from '../../shared/types.ts'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => ({}))
  // A bare 500 with an empty body must still say something the toast can show.
  if (!response.ok) throw new Error((body as { error?: string }).error || response.statusText || `HTTP ${response.status}`)
  return body as T
}

const post = (url: string, data?: unknown) =>
  json<any>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  })

export interface PlanLimit {
  kind: string
  group: string
  label: string
  percent: number
  resetsAt: string | null
  isActive: boolean
}
export interface ExtraUsage {
  enabled: boolean
  usedUSD: number
  limitUSD: number
  percent: number
  disabledReason: string | null
}
export type PlanUsageResponse =
  | { plan: string; limits: PlanLimit[]; extra: ExtraUsage | null; fetchedAt: number }
  | { error: string }

export interface UsageBucket {
  messages: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  costUSD: number
}
export interface UsageReport {
  blocks: Array<UsageBucket & { start: number; end: number; isActive: boolean; byModel: Record<string, UsageBucket> }>
  today: UsageBucket
  last7: UsageBucket
  last30: UsageBucket
  byModel: Record<string, UsageBucket>
  daily: Array<UsageBucket & { date: string; byModel: Record<string, UsageBucket> }>
  byProject: Array<UsageBucket & { project: string }>
  pricing: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>
  scannedFiles: number
  sessions: Session[]
}

export interface TerminalInfo { id: string; worktreeID: string; title: string; pid: number }
export type TaskProcess = import('../../shared/types.ts').ActiveProcess
export interface AgentTask {
  sessionID: string
  title: string
  engine: string
  worktree: string | null
  pid: number | null
  startedAt: number
  tools: import('../../shared/types.ts').ActiveTool[]
  background: import('../../shared/types.ts').BackgroundTask[]
  finished: import('../../shared/types.ts').FinishedTool[]
  processes: TaskProcess[]
}
export interface TasksResponse { tasks: AgentTask[]; terminals: TerminalInfo[] }

export const api = {
  send: (sessionID: string, text: string, comments?: unknown[]) =>
    post(`/api/session/${sessionID}/send`, { text, comments }),
  stop: (sessionID: string) => post(`/api/session/${sessionID}/stop`),
  nameSession: (sessionID: string) =>
    json<{ ok: boolean; title: string }>(`/api/session/${sessionID}/name`, { method: 'POST' }),
  patchSession: (sessionID: string, patch: Partial<Session>) =>
    json(`/api/session/${sessionID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteSession: (sessionID: string) => json(`/api/session/${sessionID}`, { method: 'DELETE' }),
  newSession: (worktreeID: string) => post(`/api/worktree/${worktreeID}/session`),

  addProject: (path: string) => post('/api/project', { path }),
  folders: (path?: string) =>
    json<import('../../shared/types.ts').FolderListing>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  deleteProject: (id: string) => json(`/api/project/${id}`, { method: 'DELETE' }),

  newWorktree: (projectID: string, options: Record<string, unknown> = {}) =>
    post(`/api/project/${projectID}/worktree`, options),
  patchWorktree: (id: string, patch: Record<string, unknown>) =>
    json(`/api/worktree/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  newStack: (projectID: string) => post(`/api/project/${projectID}/stack`) as Promise<{ session: { id: string } }>,
  addLayer: (stackID: string) => post(`/api/stack/${stackID}/layer`) as Promise<{ session: { id: string } }>,
  renameStack: (id: string, name: string) =>
    json(`/api/stack/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  dissolveStack: (id: string) => json(`/api/stack/${id}`, { method: 'DELETE' }),
  removeLayer: (stackID: string, worktreeID: string) => json(`/api/stack/${stackID}/layer/${worktreeID}`, { method: 'DELETE' }),
  updateStack: (id: string) => post(`/api/stack/${id}/update`) as Promise<{ results: import('../../shared/types.ts').LayerResult[] }>,
  openStackPRs: (id: string) => post(`/api/stack/${id}/prs`) as Promise<{ results: import('../../shared/types.ts').LayerResult[] }>,
  landStack: (id: string) => post(`/api/stack/${id}/land`) as Promise<{ results: import('../../shared/types.ts').LayerResult[] }>,
  deleteWorktree: (id: string, keepOnDisk = false) =>
    json(`/api/worktree/${id}${keepOnDisk ? '?keepOnDisk=1' : ''}`, { method: 'DELETE' }),
  addGroup: (projectID: string, name: string) => post(`/api/project/${projectID}/group`, { name }),
  removeGroup: (projectID: string, name: string) =>
    json(`/api/project/${projectID}/group/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  moveWorktree: (id: string, group: string | null) => post(`/api/worktree/${id}/move`, { group }),
  reorderGroups: (projectID: string, order: string[]) =>
    json(`/api/project/${projectID}/groups`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }),
    }),

  worktreeInfo: (id: string) =>
    json<{ liveBranch: string | null; changedFiles: number; branchesInUse: string[] }>(
      `/api/worktree/${id}/info`),

  diffFile: (path: string, scope: string, base: string | null | undefined, file: string, sha?: string) =>
    json<{ before: string | null; after: string | null }>(
      `/api/diff/file?path=${encodeURIComponent(path)}&scope=${scope}&file=${encodeURIComponent(file)}` +
      (base ? `&base=${encodeURIComponent(base)}` : '') + (sha ? `&sha=${sha}` : '')),
  diff: (path: string, scope: string, base?: string | null, context = 3, sha?: string, fresh?: boolean) =>
    json<{ files: any[]; base?: string | null; turn?: { sessionID: string; endedAt: number } | null }>(
      `/api/diff?path=${encodeURIComponent(path)}&scope=${scope}&context=${context}` +
      (base ? `&base=${encodeURIComponent(base)}` : '') + (sha ? `&sha=${sha}` : '') + (fresh ? '&fresh=1' : '')),
  commits: (path: string, base?: string | null) =>
    json<{ commits: any[] }>(
      `/api/commits?path=${encodeURIComponent(path)}` + (base ? `&base=${encodeURIComponent(base)}` : '')),
  branches: (path: string) =>
    json<{ branches: string[]; defaultBranch: string }>(
      `/api/branches?path=${encodeURIComponent(path)}`),
  file: (path: string) => json<{ text: string }>(`/api/file?path=${encodeURIComponent(path)}`),

  skills: () => json<{ skills: any[] }>('/api/skills'),
  infra: (category: string) => json<{ items: any[] }>(`/api/infra?category=${category}`),
  infraFile: (path: string) =>
    json<{ text: string; modified: number }>(`/api/infra/file?path=${encodeURIComponent(path)}`),
  saveInfraFile: (path: string, text: string, modified?: number) =>
    json<{ modified: number }>('/api/infra/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, text, modified }),
    }),

  usage: (engine: EngineKind) => json<UsageReport>(`/api/usage?engine=${engine}`),
  planUsage: (engine: EngineKind) => json<PlanUsageResponse>(`/api/plan-usage?engine=${engine}`),
  prs: (projectID: string, refresh = false) =>
    json<PRResult>(`/api/prs?project=${projectID}${refresh ? '&refresh=1' : ''}`),
  prDetails: (projectID: string) => json<PRResult>(`/api/prs/details?project=${projectID}`),
  prComments: (projectID: string) => json<any>(`/api/github/comments?project=${projectID}`),
  retry: (sessionID: string) => post(`/api/session/${sessionID}/retry`, {}),
  switchBranch: (worktreeID: string, body: { rename?: string; branch?: string; base?: string }) =>
    post(`/api/worktree/${worktreeID}/branch`, body),
  renameGroup: (projectID: string, name: string, next: string) =>
    json(`/api/project/${projectID}/group/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: next }),
    }),
  prWorktree: (projectID: string, prNumber: number, branch: string) =>
    post('/api/pr/worktree', { projectID, prNumber, branch }),
  reviewPR: (projectID: string, prNumber: number, title: string) =>
    post('/api/pr/review', { projectID, prNumber, title }),
  autofixPR: (projectID: string, prNumber: number, title: string) =>
    post('/api/pr/autofix', { projectID, prNumber, title }),

  lspStatus: (path: string) =>
    json<{ supported: boolean; installed: boolean; command: string | null }>(
      `/api/lsp/status?path=${encodeURIComponent(path)}`),
  /** Every file in a worktree with the diff numbers of the changed ones. */
  activity: (id: string) => json<import('../../shared/types.ts').SessionActivity>(`/api/session/${id}/activity`),
  answerPermission: (id: string, decision: { behavior: 'allow' | 'deny'; answers?: Record<string, string | string[]>; message?: string }) =>
    json<{ ok: boolean }>(`/api/permission/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision),
    }),
  conversations: (path: string, branch: string) =>
    json<import('../../shared/types.ts').PRConversationResult>(
      `/api/pr/conversations?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`),
  postLineComment: (payload: { path: string; prNumber: number; commitSHA: string; file: string; line: number; body: string }) =>
    json<{ ok: boolean; url?: string; message?: string }>('/api/pr/comment', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }),
  tree: (path: string, scope: string, base?: string | null, sha?: string) =>
    json<{ files: Array<{ path: string; status: string | null; added: number; removed: number }> }>(
      `/api/tree?path=${encodeURIComponent(path)}&scope=${scope}` +
      (base ? `&base=${encodeURIComponent(base)}` : '') + (sha ? `&sha=${sha}` : '')),
  /** A URL the browser can put in an <img>: the file's bytes as they are. */
  rawFileURL: (path: string) => `/api/file/raw?path=${encodeURIComponent(path)}`,
  references: (workspace: string, path: string, line: number, character: number) =>
    json<{ locations: Array<{ path: string; line: number; character: number }>; error: string | null }>(
      '/api/lsp/references', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, path, line, character }) }),
  definition: (workspace: string, path: string, line: number, character: number) =>
    post('/api/lsp/definition', { workspace, path, line, character }) as
      Promise<{ locations: Array<{ path: string; line: number; character: number }>; error: string | null }>,
  hover: (workspace: string, path: string, line: number, character: number) =>
    post('/api/lsp/hover', { workspace, path, line, character }) as
      Promise<{ text: string | null; error: string | null }>,

  settings: () => json<any>('/api/settings'),
  models: () => json<import('../../shared/models.ts').ModelCatalog>('/api/models'),
  saveSettings: (patch: Record<string, unknown>) =>
    json<any>('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    }),

  tasks: () => json<TasksResponse>('/api/tasks'),
  killProcess: (pid: number) => json(`/api/tasks/process/${pid}`, { method: 'DELETE' }),
  terminals: (worktreeID: string) => json<{ terminals: TerminalInfo[] }>(`/api/worktree/${worktreeID}/terminals`),
  openTerminal: (worktreeID: string, options: { ifNone?: boolean; login?: 'claude' | 'codex' } = {}) =>
    post(`/api/worktree/${worktreeID}/terminals`, options) as Promise<TerminalInfo>,
  closeTerminal: (id: string) => json(`/api/terminal/${id}`, { method: 'DELETE' }),
  attention: (sessionID: string | null, focused: boolean) =>
    post('/api/attention', { sessionID, focused }),
  draft: (sessionID: string) => json<{ text: string }>(`/api/session/${sessionID}/draft`),
  saveDraft: (sessionID: string, text: string) =>
    json(`/api/session/${sessionID}/draft`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    }),

  voiceStatus: () => json<{ available: boolean; hint: string | null }>('/api/voice/status'),
  transcribe: async (blob: Blob) => {
    const response = await fetch('/api/voice/transcribe', {
      method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? 'Transcription failed')
    return body.text as string
  },
}
