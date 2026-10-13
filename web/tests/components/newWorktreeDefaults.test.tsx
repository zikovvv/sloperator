// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types.ts'

const project: Project = { id: 'p', name: 'acme', path: '/acme', isGit: true, isExpanded: true, worktreeGroups: [] }
beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('suggestBranchName', () => {
  it('avoids names already taken and falls back when every combination is', async () => {
    const { suggestBranchName } = await import('../../src/lib/branchName.ts')
    expect(suggestBranchName()).toMatch(/^orch\/[a-z]+-[a-z]+$/)
    // Every adjective-noun pair taken: the only honest answer left is the timestamped one.
    const seen = new Set<string>()
    while (seen.size < 400) seen.add(suggestBranchName())
    expect(suggestBranchName([...seen])).toMatch(/^orch\/work-[a-z0-9]+$/)
    expect(suggestBranchName(['orch/nothing-here'])).not.toBe('orch/nothing-here')
  })
})

describe('the + button opens a dialog that is ready to submit', () => {
  it('defaults to a new branch with a generated name, forked from the default branch', async () => {
    const sent: any[] = []
    const api = {
      branches: async () => ({ branches: ['main', 'feature/one'], defaultBranch: 'main' }),
      newWorktree: async (...args: any[]) => { sent.push(args); return { session: { id: 's1' } } },
    }
    vi.doMock('../../src/lib/api.ts', () => ({ api }))
    const { NewWorktreeDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
    const onCreated = vi.fn(); const onClose = vi.fn()
    render(<NewWorktreeDialog project={project} inUse={[]} onClose={onClose} onCreated={onCreated} />)

    const branch = screen.getByPlaceholderText('orch/my-work') as HTMLInputElement
    expect(branch.value).toMatch(/^orch\/[a-z]+-[a-z]+$/)
    expect(screen.getByRole('button', { name: 'New branch' }).className).toContain('bg-accent')
    await waitFor(() => expect(screen.getByRole('button', { name: /main/ })).toBeTruthy())

    const create = screen.getByRole('button', { name: 'Create and open chat' }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('s1'))
    expect(sent[0][1]).toMatchObject({ base: 'main', branch: branch.value, group: 'main' })
    expect(sent[0][1].name).toBe(branch.value.replace('orch/', ''))
  })

  it('regenerates the suggestion when that branch already exists', async () => {
    const taken = ['main']
    vi.doMock('../../src/lib/branchName.ts', () => ({
      suggestBranchName: (used: string[] = []) => (used.length ? 'orch/second-try' : 'main'),
    }))
    vi.doMock('../../src/lib/api.ts', () => ({
      api: { branches: async () => ({ branches: taken, defaultBranch: 'main' }) },
    }))
    const { NewWorktreeDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
    render(<NewWorktreeDialog project={project} inUse={[]} onClose={() => {}} onCreated={() => {}} />)
    await waitFor(() =>
      expect((screen.getByPlaceholderText('orch/my-work') as HTMLInputElement).value).toBe('orch/second-try'))
  })
})
