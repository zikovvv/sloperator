// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../../src/components/ConfirmDialog.tsx'
import { TextPrompt } from '../../src/components/TextPrompt.tsx'
import { Toasts } from '../../src/components/Toasts.tsx'
import { Markdown, CodeBlock, expandWikiLinks, parseBlocks } from '../../src/components/Markdown.tsx'
import { CommandPalette, fuzzyScore, rank } from '../../src/components/CommandPalette.tsx'
import { toast } from '../../src/lib/toast.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ConfirmDialog', () => {
  it('confirms, cancels on backdrop and Escape, defaults the label', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn()
    render(<ConfirmDialog title="Sure?" body="really" onCancel={onCancel} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'OK' })); expect(onConfirm).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('alertdialog')); expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' }); expect(onCancel).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(onCancel).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    render(<ConfirmDialog title="Danger" confirmLabel="Delete" danger onCancel={onCancel} onConfirm={onConfirm} />)
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('danger')
  })
})

describe('TextPrompt', () => {
  it('submits trimmed text on Enter and via OK, ignores empty, cancels on Escape and backdrop', () => {
    const onSubmit = vi.fn(); const onCancel = vi.fn()
    render(<TextPrompt title="Name" label="Name" initial="x" placeholder="p" confirmLabel="Go" onCancel={onCancel} onSubmit={onSubmit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '  hello  ' } })
    fireEvent.keyDown(input, { key: 'Enter' }); expect(onSubmit).toHaveBeenCalledWith('hello')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' }); expect(onSubmit).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' })); expect(onSubmit).toHaveBeenCalledWith('again')
    fireEvent.keyDown(input, { key: 'Escape' }); expect(onCancel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog')); expect(onCancel).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })
})

describe('Toasts', () => {
  it('shows a toast, dismisses by button and by timer, styles by tone', () => {
    vi.useFakeTimers()
    render(<Toasts />)
    act(() => { toast('bad thing'); toast('fyi', 'info') })
    expect(screen.getByRole('status').textContent).toContain('bad thing')
    expect(screen.getByRole('status').textContent).toContain('fyi')
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(screen.getByRole('status').textContent).not.toContain('bad thing')
    act(() => { vi.advanceTimersByTime(9000) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('Markdown', () => {
  it('parses quotes, numbered lists, tables, rules and mixed inline; renders links that open files or externally', () => {
    const text = [
      '# Title', '> quoted', '> more', '1. first', '2) second', '| a | b |', '|---|---|', '| 1 | [in](x.md) |', '---',
      'Text with `code`, **bold**, *em*, [[wiki]], [ext](https://example.com) and [rel](docs/a.md).', '```', 'raw', '```', 'para',
    ].join('\n')
    const blocks = parseBlocks(text)
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'numbers', 'table', 'rule', 'paragraph', 'code', 'paragraph'])
    const onOpenFile = vi.fn()
    render(<Markdown text={text} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByText('rel')); expect(onOpenFile).toHaveBeenCalledWith('docs/a.md')
    fireEvent.click(screen.getByText('wiki')); expect(onOpenFile).toHaveBeenCalledWith('wiki.md')
    expect(screen.getByText('ext').getAttribute('target')).toBe('_blank')
    fireEvent.click(screen.getByText('in'))
    expect(screen.getByText('quoted more')).toBeTruthy()
    expect(expandWikiLinks('a [[b c]] d')).toMatch(/\[b c\]\(b[ -]c\.md\)/)
  })
  it('code block copies to the clipboard and tolerates a missing clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CodeBlock text="echo hi" language="sh" />)
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
    expect(writeText).toHaveBeenCalledWith('echo hi')
    await act(async () => {})
    cleanup()
    Object.assign(navigator, { clipboard: undefined })
    render(<CodeBlock text="x" language={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
  })
  it('renders without an onOpenFile handler', () => {
    render(<Markdown text="see [rel](a.md) and [[w]]" />)
    fireEvent.click(screen.getByText('rel'))
  })
})

describe('CommandPalette', () => {
  it('ranks, navigates with arrows, runs on Enter and click, closes on Escape and backdrop', () => {
    const run = vi.fn(); const onClose = vi.fn()
    const commands = [
      { id: 'a', group: 'Go', label: 'Usage', run }, { id: 'b', group: 'Go', label: 'Sessions', run },
      { id: 'c', group: 'New', label: 'New worktree', run, hint: 'branch' },
    ]
    render(<CommandPalette commands={commands} onClose={onClose} />)
    const input = screen.getByPlaceholderText(/Jump to a session/)
    fireEvent.change(input, { target: { value: 'sess' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' }); expect(run).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByText('New worktree')); expect(run).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: 'zzzz' } })
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' }); expect(onClose).toHaveBeenCalledTimes(3)
    expect(rank(['abc'], 'zz', (x) => x)).toEqual([])
    expect(fuzzyScore('abc', '')).toBe(0)
  })
})
