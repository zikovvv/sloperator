import type { Project, Session, Stack, Worktree } from '../shared/types.ts'

/**
 * What an agent may do to the app itself: the things the sidebar does, by name instead of by
 * click. Every operation resolves what was named and then calls the route the sidebar calls, so
 * nothing here can do what a click could not. No worktree, session, branch or file is deleted, and
 * no pull request is opened or landed.
 */
export interface Workspace {
  projects: Project[]
  worktrees: Worktree[]
  sessions: Session[]
  stacks: Stack[]
  running: string[]
}

export interface ControlContext {
  workspace: () => Workspace
  /** The app's own HTTP API; rejects with the route's error text. */
  call: (method: string, path: string, body?: unknown) => Promise<any>
  /** The session asking, when it is one of the app's own. */
  sessionID: string | null
}

type Arguments = Record<string, unknown>

export interface ControlOperation {
  name: string
  /** Only looks: free in every access mode. Everything else is asked about first unless the session has full access. */
  readOnly?: true
  description: string
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] }
  run: (args: Arguments, context: ControlContext) => Promise<unknown>
}

const MAIN_FOLDER = 'main'
const text = (description: string) => ({ type: 'string', description })
const flag = (description: string) => ({ type: 'boolean', description })
/** What was given for a text argument, or null for nothing. A number counts as its digits: it is never quietly dropped or taken to mean "mine". */
const given = (value: unknown): string | null => (value === undefined || value === null ? null : String(value).trim() || null)

/** Finds what was named: an id, the start of one, or a name nothing else shares. */
export function pick<T extends { id: string }>(
  kind: string, reference: unknown, items: T[], names: (item: T) => Array<string | null | undefined>, current?: T,
): T {
  const wanted = given(reference)?.toLowerCase()
  if (!wanted) {
    if (current) return current
    throw new Error(`Say which ${kind}: nothing is current outside one of the app's own sessions.`)
  }
  const matches = items.filter((item) => item.id === wanted
    || (wanted.length >= 4 && item.id.startsWith(wanted))
    || names(item).some((name) => name?.toLowerCase() === wanted))
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new Error(`No ${kind} matches "${reference}". list_workspace shows what there is.`)
  const listed = matches.map((item) => `${names(item)[0]} (${item.id.slice(0, 8)})`).join(', ')
  throw new Error(`"${reference}" matches ${matches.length} ${kind}s: ${listed}. Use the id.`)
}

/** Everything a reference can be resolved against, with what is current for the caller. */
function scope(context: ControlContext) {
  const workspace = context.workspace()
  const session = workspace.sessions.find((candidate) => candidate.id === context.sessionID)
  const worktree = workspace.worktrees.find((candidate) => candidate.id === session?.worktreeID)
  const project = workspace.projects.find((candidate) => candidate.id === worktree?.projectID)
    ?? (workspace.projects.length === 1 ? workspace.projects[0] : undefined)
  return {
    workspace,
    session: (reference: unknown) => pick('session', reference, workspace.sessions, (item) => [item.title], session),
    worktree: (reference: unknown) =>
      pick('worktree', reference, workspace.worktrees, (item) => [item.name, item.branch, item.path], worktree),
    project: (reference: unknown) => pick('project', reference, workspace.projects, (item) => [item.name, item.path], project),
    stack: (reference: unknown) => pick('stack', reference, workspace.stacks, (item) => [item.name],
      workspace.stacks.find((candidate) => worktree && candidate.layers.includes(worktree.id))),
  }
}

function describeWorktree(workspace: Workspace, worktree: Worktree) {
  return {
    id: worktree.id, name: worktree.name, branch: worktree.branch, base: worktree.baseBranch, path: worktree.path,
    folder: worktree.group ?? MAIN_FOLDER, main: worktree.isMain, pinned: !!worktree.isPinned, archived: !!worktree.isArchived,
    sessions: workspace.sessions.filter((session) => session.worktreeID === worktree.id).map((session) => ({
      id: session.id, title: session.title, engine: session.engine,
      pinned: session.isPinned, archived: session.isArchived, running: workspace.running.includes(session.id),
    })),
  }
}

export function describeWorkspace(workspace: Workspace, sessionID: string | null) {
  const current = workspace.sessions.find((session) => session.id === sessionID)
  return {
    current: current ? { session: current.id, worktree: current.worktreeID } : null,
    projects: workspace.projects.map((project) => ({
      id: project.id, name: project.name, path: project.path, folders: project.worktreeGroups,
      stacks: workspace.stacks.filter((stack) => stack.projectID === project.id)
        .map((stack) => ({ id: stack.id, name: stack.name, base: stack.base, layers: stack.layers })),
      worktrees: workspace.worktrees.filter((worktree) => worktree.projectID === project.id)
        .map((worktree) => describeWorktree(workspace, worktree)),
    })),
  }
}

/** The folder a worktree is about to go into, made first if it is new; its name is whatever the app registered it as. */
async function folderNamed(context: ControlContext, project: Project, wanted: string): Promise<string> {
  if (wanted === MAIN_FOLDER || project.worktreeGroups.includes(wanted)) return wanted
  return (await context.call('POST', `/api/project/${project.id}/group`, { name: wanted })).name
}

const SESSION = text('Session id, start of an id, or its exact title. Omit for the session you are in.')
const WORKTREE = text('Worktree id, start of an id, or its exact name, branch or path. Omit for the worktree you are in.')
const PROJECT = text('Project id, name or path. Omit for the project you are in, or when there is only one.')
const STACK = text('Stack id or name. Omit for the stack your worktree is a layer of.')

export const CONTROL_OPERATIONS: ControlOperation[] = [
  {
    name: 'list_workspace',
    readOnly: true,
    description: 'Lists every project, folder, stack, worktree and session in the orchestrator with their ids, and which session and worktree you are in. Call it before changing anything. '
      + 'The other orchestrator tools change things: unless this session has full access, the person is shown each change and it waits for their yes.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, context) => describeWorkspace(context.workspace(), context.sessionID),
  },
  {
    name: 'update_session',
    description: 'Renames, pins, archives or moves a session. worktree moves the session to another worktree: its transcript goes with it, '
      + 'and its agent starts a new thread there on the next turn, handed the recent conversation (not the tool results). '
      + 'A session whose turn is running (your own, when you ask) moves when that turn ends.',
    inputSchema: { type: 'object', properties: {
      session: SESSION, title: text('New title.'), pinned: flag('Pin or unpin.'), archived: flag('Archive or restore.'),
      worktree: text('Worktree to move the session to: id, name, branch or path.'),
    } },
    run: async (args, context) => {
      const within = scope(context)
      const session = within.session(args.session)
      const patch: Arguments = {}
      const title = given(args.title)
      if (title) patch.title = title
      if (typeof args.pinned === 'boolean') patch.isPinned = args.pinned
      if (typeof args.archived === 'boolean') patch.isArchived = args.archived
      const target = given(args.worktree) ? within.worktree(args.worktree) : null
      if (target) patch.worktreeID = target.id
      if (!Object.keys(patch).length) throw new Error('Nothing to change: give title, pinned, archived or worktree.')
      const from = within.workspace.worktrees.find((candidate) => candidate.id === session.worktreeID)
      const updated: Session = await context.call('PATCH', `/api/session/${session.id}`, patch)
      return {
        id: updated.id, title: updated.title, worktree: updated.worktreeID, pinned: updated.isPinned, archived: updated.isArchived,
        // A session with a turn running stays with it until the turn ends.
        ...(target && updated.worktreeID !== target.id
          ? { note: `This session moves to ${target.name} when its turn ends; until then it keeps running in ${from!.path}.` } : {}),
      }
    },
  },
  {
    name: 'update_worktree',
    description: 'Renames, pins or archives a worktree, moves it to another folder, renames its branch, changes the branch it is measured against, or repoints it at another checkout of the same repository.',
    inputSchema: { type: 'object', properties: {
      worktree: WORKTREE, name: text('New display name.'), pinned: flag('Pin or unpin.'), archived: flag('Archive or restore.'),
      folder: text('Sidebar folder to move it into; "main" is the default one. Created if it does not exist. Moves the directory on disk, so only for a worktree with no turn running in it: not the one you are in.'),
      branch: text('New name for its branch.'), base_branch: text('Branch its review is measured against.'),
      path: text('Absolute path of another existing checkout of the same repository to point this worktree at. Nothing on disk moves. Only for a worktree with no turn running in it: not the one you are in.'),
    } },
    run: async (args, context) => {
      const within = scope(context)
      const worktree = within.worktree(args.worktree)
      const patch: Arguments = {}
      for (const [argument, field] of [['name', 'name'], ['base_branch', 'baseBranch'], ['path', 'path']]) {
        const value = given(args[argument])
        if (value) patch[field] = value
      }
      if (typeof args.pinned === 'boolean') patch.isPinned = args.pinned
      if (typeof args.archived === 'boolean') patch.isArchived = args.archived
      const folder = given(args.folder)
      const branch = given(args.branch)
      if (!Object.keys(patch).length && !folder && !branch) {
        throw new Error('Nothing to change: give name, pinned, archived, folder, branch, base_branch or path.')
      }
      if (patch.path && folder) throw new Error('Give path or folder, not both: repointing moves nothing on disk, filing moves the directory.')
      // Refused here, before anything is renamed or a folder made for a move that cannot happen yet.
      const busy = within.workspace.sessions.some((session) => session.worktreeID === worktree.id && within.workspace.running.includes(session.id))
      if (busy && folder) throw new Error('A turn is running in this worktree: its directory can be moved once the turn ends')
      const was = worktree.path   // the record is the app's own and changes under us
      // Refused before anything changes, so a folder is not made for a move that cannot happen.
      if (folder && worktree.isMain) throw new Error("A project's own checkout stays where it is: it cannot be moved to a folder.")
      if (Object.keys(patch).length) await context.call('PATCH', `/api/worktree/${worktree.id}`, patch)
      if (folder) {
        const project = within.workspace.projects.find((candidate) => candidate.id === worktree.projectID)!
        await context.call('POST', `/api/worktree/${worktree.id}/move`, { group: await folderNamed(context, project, folder) })
      }
      if (branch) await context.call('POST', `/api/worktree/${worktree.id}/branch`, { rename: branch })
      const after = context.workspace()
      const described = describeWorktree(after, after.worktrees.find((candidate) => candidate.id === worktree.id)!)
      return patch.path && described.path !== was
        ? { ...described, note: `The checkout at ${was} is still on disk and is no longer in the sidebar.` }
        : described
    },
  },
  {
    name: 'create_session',
    description: 'Adds a new, empty session to a worktree.',
    inputSchema: { type: 'object', properties: { worktree: WORKTREE, title: text('Title for the new session.') } },
    run: async (args, context) => {
      const worktree = scope(context).worktree(args.worktree)
      let session: Session = await context.call('POST', `/api/worktree/${worktree.id}/session`)
      const title = given(args.title)
      if (title) session = await context.call('PATCH', `/api/session/${session.id}`, { title })
      return { id: session.id, title: session.title, worktree: worktree.id }
    },
  },
  {
    name: 'create_worktree',
    description: 'Creates a worktree with a session in it. With no branch a new branch is generated from the base.',
    inputSchema: { type: 'object', properties: {
      project: PROJECT, name: text('Display name.'), branch: text('Branch to create.'),
      base: text('Branch to start from; the project\'s current branch when omitted.'), folder: text('Sidebar folder; "main" when omitted.'),
    } },
    run: async (args, context) => {
      const project = scope(context).project(args.project)
      const folder = await folderNamed(context, project, given(args.folder) ?? MAIN_FOLDER)
      const created = await context.call('POST', `/api/project/${project.id}/worktree`, {
        name: given(args.name) ?? undefined,
        branch: given(args.branch) ?? undefined,
        base: given(args.base) ?? undefined,
        group: folder,
      })
      return { worktree: describeWorktree({ ...context.workspace(), sessions: [created.session] }, created.worktree) }
    },
  },
  {
    name: 'manage_folder',
    description: 'Creates, renames or removes a sidebar folder of a project. Renaming moves its worktrees on disk, so it waits until no turn runs in any of them; only an empty folder can be removed.',
    inputSchema: { type: 'object', required: ['action', 'name'], properties: {
      project: PROJECT, action: { type: 'string', enum: ['create', 'rename', 'remove'] },
      name: text('The folder.'), new_name: text('Its new name, for rename.'),
    } },
    run: async (args, context) => {
      const project = scope(context).project(args.project)
      const name = given(args.name)
      if (!name) throw new Error('Say which folder: give name.')
      if (args.action === 'create') return context.call('POST', `/api/project/${project.id}/group`, { name })
      // Only a folder the project has: the name goes into a path, and must never lead anywhere else in the app.
      if (!project.worktreeGroups.includes(name)) throw new Error(`No folder named "${name}". There is: ${project.worktreeGroups.join(', ')}.`)
      const folder = `/api/project/${project.id}/group/${encodeURIComponent(name)}`
      if (args.action === 'remove') return context.call('DELETE', folder)
      if (args.action !== 'rename') throw new Error('action is one of: create, rename, remove.')
      const renamed = given(args.new_name)
      if (!renamed) throw new Error('Give new_name to rename a folder.')
      return context.call('PATCH', folder, { name: renamed })
    },
  },
  {
    name: 'manage_stack',
    description: 'Works with stacks of worktrees: create (a new stack and its first layer), add_layer (a new worktree on top), rename, update (merge each layer into the one above it, and push the layers that track a remote), remove_layer (a worktree leaves the stack and is kept), dissolve (the stack goes, its worktrees stay).',
    inputSchema: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['create', 'add_layer', 'rename', 'update', 'remove_layer', 'dissolve'] },
      project: PROJECT, stack: STACK, name: text('New name, for rename.'), worktree: text('The layer to take out, for remove_layer.'),
    } },
    run: async (args, context) => {
      const within = scope(context)
      if (args.action === 'create') return context.call('POST', `/api/project/${within.project(args.project).id}/stack`)
      const stack = within.stack(args.stack)
      switch (args.action) {
        case 'add_layer': return context.call('POST', `/api/stack/${stack.id}/layer`)
        case 'update': return context.call('POST', `/api/stack/${stack.id}/update`)
        case 'dissolve': return context.call('DELETE', `/api/stack/${stack.id}`)
        case 'rename': return context.call('PATCH', `/api/stack/${stack.id}`, { name: args.name })
        case 'remove_layer': return context.call('DELETE', `/api/stack/${stack.id}/layer/${within.worktree(args.worktree).id}`)
        default: throw new Error('action is one of: create, add_layer, rename, update, remove_layer, dissolve.')
      }
    },
  },
]

export const CONTROL_TOOLS = CONTROL_OPERATIONS.map((operation) => operation.name)

/** Runs one operation by name; rejects with words meant for whoever asked. */
export async function runControl(name: string, args: unknown, context: ControlContext): Promise<unknown> {
  const operation = CONTROL_OPERATIONS.find((candidate) => candidate.name === name)
  if (!operation) throw new Error(`No such operation: ${name}. There is: ${CONTROL_TOOLS.join(', ')}.`)
  const values = args && typeof args === 'object' && !Array.isArray(args) ? args as Arguments : {}
  return operation.run(values, context)
}
