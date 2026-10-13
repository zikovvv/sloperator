// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main'] }
const worktree: Worktree = {
  id: 'w', projectID: 'p', name: 'swift-otter', path: '/w', branch: 'orch/swift-otter', baseBranch: 'origin/main',
  isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main',
}
beforeEach(() => { vi.resetModules(); vi.doMock('../../src/lib/toast.ts', () => ({ toast: vi.fn(), reportError: vi.fn() })) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (impl: Record<string, any> = {}) => {
  const api = {
    branches: async () => ({ branches: ['main'], defaultBranch: 'main' }),
    worktreeInfo: async () => ({ liveBranch: 'orch/swift-otter', changedFiles: 0, branchesInUse: [] }),
    patchWorktree: vi.fn(async () => ({ ok: true })), deleteWorktree: vi.fn(async () => ({ ok: true })),
    switchBranch: vi.fn(async () => ({ ok: true })), moveWorktree: vi.fn(async () => ({ ok: true })), ...impl,
  }
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
  const onChanged = vi.fn()
  render(<WorktreeSetup worktree={worktree} project={project} inUse={[]} sessionCount={3} onChanged={onChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
  return { api, onChanged }
}

describe('what the worktree page used to do, at the top of the session', () => {
  it('renames the worktree on Enter or blur, ignores an unchanged or empty name, opens the terminal', async () => {
    const { api } = await mount()
    const name = screen.getByLabelText('Worktree name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Release prep' } }); fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(api.patchWorktree).toHaveBeenCalledWith('w', { name: 'Release prep' }))
    fireEvent.change(name, { target: { value: '   ' } }); fireEvent.blur(name)
    expect(name.value).toBe('swift-otter')
    fireEvent.change(name, { target: { value: 'swift-otter' } }); fireEvent.keyDown(name, { key: 'a' }); fireEvent.blur(name)
    expect(api.patchWorktree).toHaveBeenCalledTimes(1)
    expect(screen.getByText('/w')).toBeTruthy()
  })

  it('warns without a branch name when git has not said which branch it is on', async () => {
    const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
    vi.doMock('../../src/lib/api.ts', () => ({ api: { branches: async () => ({ branches: [], defaultBranch: 'main' }), worktreeInfo: async () => ({ changedFiles: 0 }) } }))
    render(<WorktreeSetup worktree={{ ...worktree, branch: null }} project={project} inUse={[]} sessionCount={0} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('The branch  is NOT deleted')
  })

  it('never offers to rename the branch, move, archive or delete the project’s own checkout', async () => {
    vi.doMock('../../src/lib/api.ts', () => ({ api: { branches: async () => ({ branches: [], defaultBranch: 'main' }), worktreeInfo: async () => ({ changedFiles: 1 }) } }))
    const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
    render(<WorktreeSetup worktree={{ ...worktree, isMain: true, name: 'acme' }} project={project} inUse={[]} sessionCount={1} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    expect(screen.getByLabelText('Worktree name')).toBeTruthy()
    for (const name of ['Delete worktree', 'Archive', 'Remove from sidebar']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByLabelText('Branch name')).toBeNull()
    expect(screen.queryByLabelText('Folder')).toBeNull()
    expect(screen.getByText(/project's own checkout/)).toBeTruthy()
  })

  it('archives, removes from the sidebar, and deletes only after the red confirm', async () => {
    const { api, onChanged } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(api.patchWorktree).toHaveBeenCalledWith('w', { isArchived: true }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from sidebar' }))
    await waitFor(() => expect(api.deleteWorktree).toHaveBeenCalledWith('w', true))
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('3 session(s)')
    expect(screen.getByRole('alertdialog').textContent).toContain('orch/swift-otter is NOT deleted')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.deleteWorktree).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteWorktree).toHaveBeenCalledWith('w'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3))
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('the panel stays shut until asked', () => {
  it('never opens itself, whatever the session looks like, and closes again', async () => {
    vi.doMock('../../src/lib/api.ts', () => ({ api: { branches: async () => ({ branches: [], defaultBranch: 'main' }), worktreeInfo: async () => ({ changedFiles: 0 }) } }))
    const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
    // An empty chat used to force it open; switching sessions then kept unfolding it.
    render(<WorktreeSetup worktree={worktree} project={project} inUse={[]} sessionCount={0} onChanged={() => {}} />)
    expect(screen.queryByLabelText('Worktree name')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Worktree…' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByLabelText('Worktree name')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByLabelText('Worktree name')).toBeNull()
  })
})
