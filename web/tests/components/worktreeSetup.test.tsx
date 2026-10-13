// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main', 'review'] }
const worktree: Worktree = {
  id: 'w', projectID: 'p', name: 'swift-otter', path: '/w', branch: 'orch/swift-otter', baseBranch: 'origin/main',
  isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main',
}

beforeEach(() => {
  vi.resetModules()
  vi.doMock('../../src/lib/toast.ts', () => ({ toast: vi.fn(), reportError: vi.fn() }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (impl: Record<string, any> = {}, over: Partial<Worktree> = {}, openPanel = true) => {
  const api = {
    branches: async () => ({ branches: ['main', 'feature/one', 'orch/swift-otter', 'held'], defaultBranch: 'main' }),
    switchBranch: vi.fn(async () => ({ ok: true })),
    moveWorktree: vi.fn(async () => ({ ok: true })),
    worktreeInfo: async () => ({ liveBranch: 'orch/swift-otter', changedFiles: 2, branchesInUse: [] }),
    patchWorktree: vi.fn(async () => ({ ok: true })),
    deleteWorktree: vi.fn(async () => ({ ok: true })),
    ...impl,
  }
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
  const onChanged = vi.fn()
  render(<WorktreeSetup worktree={{ ...worktree, ...over }} project={project} inUse={['held']} sessionCount={2}
                        onChanged={onChanged} />)
  if (openPanel) fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
  return { api, onChanged }
}

describe('the worktree panel at the top of a session', () => {
  it('shows branch, base and folder; opens fully while the chat is empty; collapses to a bar afterwards', async () => {
    await mount({}, {}, true)
    expect(screen.getByTestId('worktree-setup').textContent).toContain('orch/swift-otter')
    expect(screen.getByTestId('worktree-setup').textContent).toContain('from')
    expect(screen.getByTestId('worktree-setup').textContent).toContain('origin/main')
    expect(screen.getByLabelText('Branch name')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByLabelText('Branch name')).toBeNull()
    cleanup(); vi.resetModules()
    await mount({}, { branch: null, baseBranch: null, group: null }, false)
    expect(screen.queryByLabelText('Branch name')).toBeNull()
    expect(screen.getByTestId('worktree-setup').textContent).toMatch(/—.*from.*HEAD.*folder.*main/)
    fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    expect(screen.getByLabelText('Branch name')).toBeTruthy()
  })

  it('renames on Enter or blur, ignores an unchanged or empty name, and keeps up with the store', async () => {
    const { api, onChanged } = await mount()
    const name = screen.getByLabelText('Branch name') as HTMLInputElement
    expect(name.value).toBe('orch/swift-otter')
    fireEvent.change(name, { target: { value: 'orch/real-work' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(api.switchBranch).toHaveBeenCalledWith('w', { rename: 'orch/real-work' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    fireEvent.change(name, { target: { value: '   ' } }); fireEvent.blur(name)
    expect(name.value).toBe('orch/swift-otter')
    fireEvent.change(name, { target: { value: 'orch/swift-otter' } }); fireEvent.blur(name)
    expect(api.switchBranch).toHaveBeenCalledTimes(1)
  })

  it('re-forks from a chosen base, checks out an existing branch that nobody holds, and moves folders', async () => {
    const { api } = await mount()
    const option = (branch: string) =>
      screen.queryAllByText(branch).map((el) => el.closest('button.row')).find(Boolean) as HTMLElement | undefined
    // Fork from: the trigger shows the current base; pick another.
    fireEvent.click(screen.getByText('origin/main', { selector: 'button span' }))
    await waitFor(() => expect(option('feature/one')).toBeTruthy())
    fireEvent.click(option('feature/one')!)
    await waitFor(() => expect(api.switchBranch).toHaveBeenCalledWith('w', { base: 'feature/one' }))
    // Check out existing: held branches and the current one are not offered.
    fireEvent.click(screen.getByText(/Choose a branch/, { selector: 'button span' }))
    await waitFor(() => expect(option('main')).toBeTruthy())
    expect(option('held')).toBeUndefined()
    expect(option('orch/swift-otter')).toBeUndefined()
    fireEvent.click(option('main')!)
    await waitFor(() => expect(api.switchBranch).toHaveBeenCalledWith('w', { branch: 'main' }))
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'review' } })
    await waitFor(() => expect(api.moveWorktree).toHaveBeenCalledWith('w', 'review'))
  })

  it('shrugs off a branch list it cannot fetch, a project with no folders, and other keys in the name box', async () => {
    await mount({ branches: async () => { throw new Error('git is away') } }, {}, true)
    expect(screen.getByLabelText('Branch name')).toBeTruthy()
    fireEvent.keyDown(screen.getByLabelText('Branch name'), { key: 'a' })
    cleanup(); vi.resetModules()
    const bare = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }
    const api = { branches: async () => ({ branches: [], defaultBranch: 'main' }), switchBranch: vi.fn(), moveWorktree: vi.fn(), worktreeInfo: async () => { throw new Error('gone') } }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { WorktreeSetup } = await import('../../src/components/WorktreeSetup.tsx')
    render(<WorktreeSetup worktree={worktree} project={bare as any} inUse={[]} sessionCount={0} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worktree…' }))
    expect((screen.getByLabelText('Folder') as HTMLSelectElement).options).toHaveLength(1)
  })

  it('reports a refused change as a toast and shows a busy dot while waiting', async () => {
    let reject!: (error: Error) => void
    const { api } = await mount({ switchBranch: vi.fn(() => new Promise((_r, rej) => { reject = rej })) })
    const name = screen.getByLabelText('Branch name')
    fireEvent.change(name, { target: { value: 'main' } }); fireEvent.keyDown(name, { key: 'Enter' })
    expect(api.switchBranch).toHaveBeenCalled()
    expect(screen.getByTestId('worktree-setup').querySelector('.dot-running')).toBeTruthy()
    reject(new Error('branch exists'))
    const { reportError } = await import('../../src/lib/toast.ts')
    await waitFor(() => expect(reportError).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('worktree-setup').querySelector('.dot-running')).toBeNull())
  })
})
