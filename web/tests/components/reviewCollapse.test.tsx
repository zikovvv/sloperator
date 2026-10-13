// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('review panel collapse button', () => {
  it('shows only when the panel can be tucked away, and calls back when pressed', async () => {
    vi.doMock('../../src/lib/api.ts', () => ({ api: { diff: async () => ({ files: [] }), commits: async () => ({ commits: [] }) } }))
    vi.doMock('@monaco-editor/react', () => ({ DiffEditor: () => <div /> }))
    vi.doMock('../../src/lib/monaco.ts', () => ({}))
    const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
    const onCollapse = vi.fn()
    const props = { worktreePath: '/w', baseBranch: null, isMain: true, generation: 1, onAddComment: () => {}, onOpenSource: () => {}, onQuote: () => {} }
    const { rerender } = render(<ReviewPanel {...props} />)
    await waitFor(() => expect(screen.getByText(/No changes in/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Hide review panel' })).toBeNull()
    rerender(<ReviewPanel {...props} onCollapse={onCollapse} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide review panel' }))
    expect(onCollapse).toHaveBeenCalled()
  })
})
