// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const apiMock = () => {
  const impl: Record<string, any> = {}
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ id: 'new' }) }) })
  return { api, impl, calls }
}
const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main', 'review'] }
const worktrees: Worktree[] = [
  { id: 'w-main', projectID: 'p', name: 'acme', path: '/acme', branch: 'main', baseBranch: null, isMain: true, isExpanded: true, isPinned: false, isArchived: false, group: 'main' },
  { id: 'w-2', projectID: 'p', name: 'feature', path: '/wt/feature', branch: 'feature', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: true, isArchived: false, group: null },
  { id: 'w-3', projectID: 'p', name: 'old', path: '/wt/old', branch: 'old', baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: true, group: 'main' },
]
const sessions: Session[] = [
  { id: 's1', worktreeID: 'w-main', title: 'Fix bug', engine: 'claude', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: true, isArchived: false, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  { id: 's2', worktreeID: 'w-main', title: 'Archived one', engine: 'codex', accessMode: 'edits', steeringMode: 'steer', model: null, effort: null, claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: true, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
]

describe('Sidebar', () => {
  it('renders folders, worktrees, sessions and every menu action; folds; drags; dialogs; errors toast', async () => {
    const { api, impl, calls } = apiMock()
    impl.moveWorktree = vi.fn(async () => { throw new Error('cannot move') })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const toasts: string[] = []
    window.addEventListener('orchestrator:toast', (event) => toasts.push((event as CustomEvent).detail.text))
    const { Sidebar } = await import('../../src/components/Sidebar.tsx')
    const onSelectSession = vi.fn(); const onSelectWorktree = vi.fn(); const onChanged = vi.fn(); const onNewWorktree = vi.fn()
    render(<Sidebar projects={[project]} worktrees={worktrees} sessions={sessions} running={new Set(['s1'])} attention={new Set()} onQuickWorktree={vi.fn()} onNewWorktree={onNewWorktree}
      selectedSession="s1" selectedWorktree={null} onSelectSession={onSelectSession} onSelectWorktree={onSelectWorktree} onChanged={onChanged} />)
    // Its one unarchived session leaves the worktree folded; the chevron is how you reach the row.
    expect(screen.queryByText('Fix bug')).toBeNull()
    const mainRow = screen.getAllByText('acme')
      .map((node) => node.closest('.row'))
      .find((row) => row && within(row as HTMLElement).queryByRole('button', { name: 'Expand worktree' })) as HTMLElement
    fireEvent.click(within(mainRow).getByRole('button', { name: 'Expand worktree' }))
    expect(screen.getByText('Fix bug')).toBeTruthy(); expect(screen.getByText(/Archived sessions \(1\)/)).toBeTruthy(); expect(screen.getByText(/Archived worktrees \(1\)/)).toBeTruthy()
    fireEvent.click(screen.getByText('Fix bug')); expect(onSelectSession).toHaveBeenCalledWith('s1')
    fireEvent.keyDown(screen.getByText('Fix bug').closest('[role="button"]')!, { key: 'Enter' })
    fireEvent.click(screen.getAllByText('feature')[0]); expect(onSelectWorktree).toHaveBeenCalledWith('w-2')
    fireEvent.keyDown(screen.getAllByText('feature')[0].closest('[role="button"]')!, { key: 'Enter' })
    // Fold main, unfold, persisted.
    const folderButton = (name: string) => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded') && b.textContent?.includes(name))!
    const fold = folderButton('main')
    fireEvent.click(fold); expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(localStorage.getItem('orchestrator.foldedFolders')!)).toContain('p/main')
    fireEvent.click(fold)
    // Project menu.
    const menus = () => screen.getAllByRole('button', { name: 'Row actions' })
    const menuOf = (text: string, index = 0) => {
      const label = screen.getAllByText(text)[index]
      let node: HTMLElement | null = label
      while (node && !node.querySelector('button[aria-label="Row actions"]')) node = node.parentElement
      return node!.querySelector('button[aria-label="Row actions"]') as HTMLElement
    }
    fireEvent.click(menus()[0]); fireEvent.click(screen.getByRole('menuitem', { name: 'New worktree…' })); expect(onNewWorktree).toHaveBeenCalled()
    fireEvent.click(menus()[0]); fireEvent.click(screen.getByRole('menuitem', { name: /Quick worktree/ }))
    fireEvent.click(menus()[0]); fireEvent.click(screen.getByRole('menuitem', { name: 'Add group directory…' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'work' } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(calls.some(([name]) => name === 'addGroup')).toBe(true))
    fireEvent.click(menus()[0]); fireEvent.click(screen.getByRole('menuitem', { name: 'Remove project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'deleteProject')).toBe(true))
    // Worktree menu: new session, rename, pin, move (fails -> toast), archive, delete.
    const worktreeMenu = () => menuOf('acme', 1)
    fireEvent.click(worktreeMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'New session' }))
    fireEvent.click(worktreeMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'renamed' } }); fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    fireEvent.click(worktreeMenu()); fireEvent.click(screen.getByRole('menuitem', { name: /Pin to top|Unpin/ }))
    fireEvent.click(menuOf('feature')); fireEvent.click(screen.getByRole('menuitem', { name: /Move to review/ }))
    await waitFor(() => expect(toasts).toContain('cannot move'))
    fireEvent.click(menuOf('feature')); fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    fireEvent.click(menuOf('feature')); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete worktree…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'deleteWorktree')).toBe(true))
    // Session menu: rename, pin, archive, delete (cancel then confirm).
    const sessionMenu = () => menuOf('Fix bug')
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Rename with Claude' }))
    await waitFor(() => expect(calls.some(([name, args]) => name === 'nameSession' && args[0] === 's1')).toBe(true))
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: /Unpin|Pin to top/ }))
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(sessionMenu()); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'deleteSession')).toBe(true))
    // Restore archived session and worktree; remove empty group; new session +; add project.
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Remove empty group' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'New session' })[0])
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/somewhere' } }); fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(calls.some(([name]) => name === 'addProject')).toBe(true))
    // Drag a worktree onto a folder; drag a folder onto another.
    const grip = screen.getAllByTitle(/Drag onto a folder/)[0]
    const folderHeader = folderButton('review').parentElement!.parentElement!
    fireEvent.dragStart(grip); fireEvent.dragOver(folderHeader); fireEvent.dragLeave(folderHeader); fireEvent.dragOver(folderHeader); fireEvent.drop(folderHeader); fireEvent.dragEnd(grip)
    const folderGrip = screen.getAllByTitle('Drag to reorder folders')[1]
    const mainHeader = folderButton('main').parentElement!.parentElement!
    fireEvent.dragStart(folderGrip); fireEvent.dragOver(mainHeader); fireEvent.drop(mainHeader)
    await waitFor(() => expect(calls.some(([name]) => name === 'reorderGroups')).toBe(true))
    fireEvent.dragStart(folderGrip); fireEvent.drop(mainHeader.parentElement!)   // a drop with nothing dragging is ignored
    // Collapse the project.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle project' }))
    expect(screen.queryByText('Fix bug')).toBeNull()
  })

  it('shows a toast when a menu action fails and a plain project without groups', async () => {
    const { api, impl } = apiMock()
    impl.newSession = vi.fn(async () => { throw new Error('no session for you') })
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const toasts: string[] = []
    window.addEventListener('orchestrator:toast', (event) => toasts.push((event as CustomEvent).detail.text))
    localStorage.setItem('orchestrator.foldedFolders', 'not json')
    const { Sidebar } = await import('../../src/components/Sidebar.tsx')
    render(<Sidebar projects={[{ ...project, worktreeGroups: [] }]} worktrees={[worktrees[0]]} sessions={[]} running={new Set()} attention={new Set(['x'])} onQuickWorktree={vi.fn()} onNewWorktree={() => {}}
      selectedSession={null} selectedWorktree="w-main" onSelectSession={() => {}} onSelectWorktree={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(toasts).toContain('no session for you'))
  })
})
