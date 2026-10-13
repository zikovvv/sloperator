// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, StackView, Worktree } from '../../shared/types.ts'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: ['main'] }
const wt = (id: string, branch: string, extra: Partial<Worktree> = {}): Worktree => ({
  id, projectID: 'p', name: id, path: `/wt/${id}`, branch, baseBranch: 'main', isMain: false, isExpanded: true, isPinned: false, isArchived: false, group: 'main', ...extra })
const worktrees = [wt('main', 'main', { isMain: true, name: 'acme' }), wt('l1', 'orch/one'), wt('l2', 'orch/two'), wt('solo', 'orch/solo')]
const session = (id: string, worktreeID: string, title: string): Session => ({
  id, worktreeID, title, engine: 'claude', accessMode: 'edits', steeringMode: 'queue', model: null, effort: null,
  claudeSessionID: null, codexThreadID: null, isPinned: false, isArchived: false, totalCostUSD: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
const sessions = [session('s1', 'l1', 'Parse the config'), session('s2', 'l2', 'Use the config'), session('s3', 'solo', 'Something else')]
const stack: StackView = { id: 'k', projectID: 'p', name: 'Stack 1', base: 'main', layers: ['l1', 'l2'],
  prs: [{ number: 40, url: 'https://example.com/pr/40', state: 'draft' }, null] }

const mount = async (impl: Record<string, any> = {}, stacks: StackView[] = [stack]) => {
  const calls: Array<[string, any[]]> = []
  const api = new Proxy({}, { get: (_t, key: string) => impl[key] ?? ((...args: any[]) => { calls.push([key, args]); return Promise.resolve({ session: { id: 'made' }, results: [] }) }) })
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const toasts: Array<{ text: string; tone: string }> = []
  window.addEventListener('orchestrator:toast', (event) => toasts.push((event as CustomEvent).detail))
  const { Sidebar } = await import('../../src/components/Sidebar.tsx')
  const onSelectSession = vi.fn(); const onChanged = vi.fn(); const onSelectWorktree = vi.fn()
  render(<Sidebar projects={[project]} worktrees={worktrees} sessions={sessions} stacks={stacks} running={new Set()} attention={new Set()}
                  onQuickWorktree={vi.fn()} onNewWorktree={vi.fn()} selectedSession={null} selectedWorktree={null}
                  onSelectSession={onSelectSession} onSelectWorktree={onSelectWorktree} onChanged={onChanged} />)
  return { calls, toasts, onSelectSession, onChanged, onSelectWorktree }
}
const stackBox = () => screen.getByTestId('stack')
const stackMenu = (item: string) => {
  fireEvent.click(within(stackBox()).getAllByRole('button', { name: 'Row actions' })[0])
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

describe('stacks in the sidebar', () => {
  it('lists the layers in order, numbered, with their pull requests, and keeps them out of the folders', async () => {
    const { onSelectWorktree: selectWorktree } = await mount()
    const box = stackBox()
    expect(box.textContent).toContain('Stack 1')
    expect(within(box).getAllByTestId('worktree-title').map((node) => node.textContent)).toEqual(['Parse the config', 'Use the config'])
    expect(within(box).getByTitle('Layer 1: builds on main').textContent).toBe('1')
    expect(within(box).getByTitle('Layer 2: builds on the layer below').textContent).toBe('2')
    const pr = within(box).getByText('#40') as HTMLAnchorElement
    expect(pr.href).toBe('https://example.com/pr/40'); expect(pr.title).toBe('Pull request draft')
    fireEvent.click(pr)   // opens GitHub without also selecting the worktree under it
    expect(selectWorktree).not.toHaveBeenCalled()
    // The folder holds only what is not stacked.
    const folderTitles = screen.getAllByTestId('worktree-title').map((node) => node.textContent)
    expect(folderTitles.filter((title) => title === 'Parse the config')).toHaveLength(1)
    expect(folderTitles).toContain('Something else')
    // Folding the stack hides its layers.
    fireEvent.click(within(box).getByRole('button', { expanded: true }))
    expect(within(stackBox()).queryAllByTestId('worktree-title')).toHaveLength(0)
  })

  it('starts a stack, adds a layer, and opens the session each one comes with', async () => {
    const { calls, onSelectSession, onChanged } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'New stack' }))
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('made'))
    expect(calls).toContainEqual(['newStack', ['p']])
    fireEvent.click(within(stackBox()).getByRole('button', { name: 'Add layer' }))
    await waitFor(() => expect(calls).toContainEqual(['addLayer', ['k']]))
    expect(onChanged).toHaveBeenCalled()
    // The project menu offers it too.
    fireEvent.click(screen.getAllByRole('button', { name: 'Row actions' })[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'New stack' }))
    await waitFor(() => expect(calls.filter(([name]) => name === 'newStack')).toHaveLength(2))
  })

  it('updates, opens PRs and lands from the stack menu, saying what happened to each layer', async () => {
    const results = [{ worktreeID: 'l2', branch: 'orch/two', status: 'merged', message: 'merged orch/one' }]
    const { toasts, calls } = await mount({
      updateStack: vi.fn(async () => ({ results })),
      openStackPRs: vi.fn(async () => ({ results: [{ ...results[0], status: 'conflict', message: 'orch/one conflicts in a.py; left as it was' }] })),
      landStack: vi.fn(async () => ({ results: [] })),
    })
    stackMenu('Update stack')
    await waitFor(() => expect(toasts.at(-1)).toEqual(expect.objectContaining({ text: 'Updated Stack 1:\norch/two: merged orch/one', tone: 'info' })))
    stackMenu('Open PRs for stack')
    await waitFor(() => expect(toasts.at(-1)).toEqual(expect.objectContaining({ tone: 'error', text: expect.stringContaining('conflicts in a.py') })))
    stackMenu('Land bottom layer…')
    expect(screen.getByText('Land the bottom layer of Stack 1?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Land' }))
    await waitFor(() => expect(toasts.at(-1)?.text).toBe('Landed from Stack 1: nothing to do'))
    void calls
  })

  it('renames, dissolves, and lets a layer leave the stack', async () => {
    const { calls } = await mount()
    stackMenu('Rename stack…')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Payments' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(calls).toContainEqual(['renameStack', ['k', 'Payments']]))
    stackMenu('Dissolve stack')
    await waitFor(() => expect(calls).toContainEqual(['dissolveStack', ['k']]))
    const layerRow = within(stackBox()).getAllByTestId('worktree-title')[1].closest('.row') as HTMLElement
    fireEvent.click(within(layerRow).getByRole('button', { name: 'Row actions' }))
    expect(screen.queryByRole('menuitem', { name: /^Move to/ })).toBeNull()   // a layer's place is its stack
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from stack' }))
    await waitFor(() => expect(calls).toContainEqual(['removeLayer', ['k', 'l2']]))
  })

  it('reports a stack that could not be made, and hides a stack with nothing matching the filter', async () => {
    const toasts: string[] = []
    window.addEventListener('orchestrator:toast', (event) => toasts.push((event as CustomEvent).detail.text))
    await mount({ newStack: vi.fn(async () => { throw new Error('no room for a worktree') }) })
    fireEvent.click(screen.getByRole('button', { name: 'New stack' }))
    await waitFor(() => expect(toasts).toContain('no room for a worktree'))
    fireEvent.change(screen.getByLabelText('Filter sidebar'), { target: { value: 'something else' } })
    expect(screen.queryByTestId('stack')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter sidebar'), { target: { value: 'use the config' } })
    expect(within(stackBox()).getAllByTestId('worktree-title').map((node) => node.textContent)).toEqual(['Use the config'])
  })
})
