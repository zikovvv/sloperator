// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Worktree } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main', 'review'] }
const wt = (id: string, name: string, branch: string | null, group: string | null): Worktree => ({
  id, projectID: 'p', name, path: `/w/${id}`, branch, baseBranch: 'main', isMain: id === 'main',
  isExpanded: true, isPinned: false, isArchived: false, group,
})
const session = (id: string, worktreeID: string, title: string): Session => ({
  id, worktreeID, title, engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null,
  claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false,
  totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
})
const worktrees = [wt('main', 'root', null, null), wt('login', 'login-fix', 'fix/login', 'main'), wt('pr12', 'PR #12', 'orch/pr-12', 'review')]
const sessions = [session('s1', 'main', 'Investigate cache'), session('s2', 'login', 'Fix the login form'), session('s3', 'pr12', 'Review widgets')]

beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (impl: Record<string, any> = {}, selectedSession: string | null = null, sessionList: Session[] = sessions,
                     busy: Set<string> = new Set(), waiting: Set<string> = new Set()) => {
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? (() => Promise.resolve({ ok: true })) })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { Sidebar } = await import('../../src/components/Sidebar.tsx')
  const onChanged = vi.fn()
  render(<Sidebar projects={[project]} worktrees={worktrees} sessions={sessionList} running={busy} attention={waiting}
                  onQuickWorktree={vi.fn()} onNewWorktree={() => {}} selectedSession={selectedSession} selectedWorktree={null}
                  onSelectSession={() => {}} onSelectWorktree={() => {}} onChanged={onChanged} />)
  return { onChanged }
}
// A worktree is titled by its first session, so the same words name both; the session row is the small one.
const sessionRow = (title: string) => screen.queryAllByText(title).find((node) => node.className.includes('text-[11px]')) ?? null
const worktreeRow = (title: string) => screen.getAllByTestId('worktree-title').find((node) => node.textContent === title)!.closest('.row') as HTMLElement
const visible = () => ({
  worktrees: screen.queryAllByTestId('worktree-title').map((node) => node.textContent),
  sessions: ['Investigate cache', 'Fix the login form', 'Review widgets'].filter((title) => sessionRow(title)),
})

describe('sidebar filter', () => {
  it('narrows by worktree name, branch or session title; hides empty folders; ignores folds while filtering', async () => {
    await mount()
    const box = screen.getByLabelText('Filter sidebar')
    fireEvent.change(box, { target: { value: 'login' } })
    expect(visible()).toEqual({ worktrees: ['Fix the login form'], sessions: ['Fix the login form'] })
    expect(screen.queryByRole('button', { name: /review.*\(/ })).toBeNull()   // folder with nothing matching is gone
    fireEvent.change(box, { target: { value: 'orch/pr' } })   // by branch
    expect(visible()).toEqual({ worktrees: ['Review widgets'], sessions: ['Review widgets'] })
    fireEvent.change(box, { target: { value: 'cache' } })   // by session title: its worktree stays, other sessions go
    expect(visible()).toEqual({ worktrees: ['root'], sessions: ['Investigate cache'] })
    fireEvent.change(box, { target: { value: 'ZZZ' } })
    expect(visible()).toEqual({ worktrees: [], sessions: [] })
    fireEvent.change(box, { target: { value: '' } })
    expect(visible().worktrees).toHaveLength(3)
    // Fold "review", then filter: the fold is ignored so the match is visible.
    fireEvent.click(screen.getByRole('button', { name: /review.*\(1\)/ }))
    expect(visible().worktrees).not.toContain('Review widgets')
    fireEvent.change(box, { target: { value: 'widgets' } })
    expect(visible().worktrees).toContain('Review widgets')
  })

  it('renames a folder through the prompt, never the main one', async () => {
    const renameGroup = vi.fn(async () => ({ ok: true }))
    const { onChanged } = await mount({ renameGroup })
    expect(screen.getAllByRole('button', { name: 'Rename folder' })).toHaveLength(1)   // review only, not main
    fireEvent.click(screen.getByRole('button', { name: 'Rename folder' }))
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(input.value).toBe('review')
    fireEvent.change(input, { target: { value: 'reviews' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith('p', 'review', 'reviews'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})

describe('a worktree named by hand', () => {
  it('keeps its own name over its first session\'s', async () => {
    worktrees[1].nameIsManual = true
    try {
      await mount()
      expect(visible().worktrees).toContain('login-fix')
      expect(visible().worktrees).not.toContain('Fix the login form')
    } finally { delete worktrees[1].nameIsManual }
  })
})

describe('worktree folding', () => {
  it('starts folded with a session count, opens and closes from its chevron, and remembers', async () => {
    await mount()
    expect(sessionRow('Fix the login form')).toBeNull()
    expect(screen.getAllByText(/1 session/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand worktree' })[1])   // login-fix
    expect(sessionRow('Fix the login form')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('orchestrator.worktreeFolds')!)).toEqual({ login: true })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse worktree' }))
    expect(sessionRow('Fix the login form')).toBeNull()
    expect(JSON.parse(localStorage.getItem('orchestrator.worktreeFolds')!)).toEqual({ login: false })
  })

  it('a worktree with a single session stays folded when you land in it: that row is the chat already open', async () => {
    await mount({}, 's2')   // the only session in login-fix is open
    expect(sessionRow('Fix the login form')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Expand worktree' })).toHaveLength(3)
    // The chevron still opens it by hand, and that choice is remembered.
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand worktree' })[1])
    expect(sessionRow('Fix the login form')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('orchestrator.worktreeFolds')!)).toEqual({ login: true })
  })

  it('a worktree with several sessions does unfold when you land in it, and can still be folded by hand', async () => {
    const many = [...sessions, session('s4', 'login', 'Second login task')]
    await mount({}, 's2', many)
    expect(sessionRow('Fix the login form')).toBeTruthy()
    expect(screen.getByText('Second login task')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse worktree' }))
    expect(sessionRow('Fix the login form')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Expand worktree' })).toHaveLength(3)
  })
})

describe('hierarchy indentation', () => {
  it('shifts folders, worktrees and sessions further right than their parent', async () => {
    await mount()
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand worktree' })[2])   // PR #12
    const folder = screen.getByRole('button', { name: /review.*\(1\)/ }).parentElement!
    const worktree = worktreeRow('Review widgets')
    const session = sessionRow('Review widgets')!.closest('.row')!
    expect(folder.className).toContain('pl-3')
    expect(worktree.className).toContain('pl-5')
    expect(session.className).toContain('pl-9')
  })
})

describe('a folded worktree still reports what its sessions are doing', () => {
  it('shows working while one runs, and prefers the one waiting on you', async () => {
    const row = () => worktreeRow('Fix the login form')
    await mount({}, null, sessions, new Set(['s2']))
    expect(sessionRow('Fix the login form')).toBeNull()   // folded: the row is all there is
    expect(within(row()).getByTitle('Working')).toBeTruthy()
    cleanup()
    // Waiting on you outranks working, even when both are true in the same worktree.
    const many = [...sessions, session('s4', 'login', 'Second login task')]
    await mount({}, null, many, new Set(['s2']), new Set(['s4']))
    expect(within(row()).getByTitle('Finished while you were away')).toBeTruthy()
    expect(within(row()).queryByTitle('Working')).toBeNull()
    cleanup()
    await mount()
    expect(within(row()).queryByTitle('Working')).toBeNull()
    expect(within(row()).queryByTitle('Finished while you were away')).toBeNull()
  })
})
