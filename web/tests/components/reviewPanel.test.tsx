// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hunk = { id: 1, header: '@@', lines: [
  { id: 1, kind: 'hunkHeader', text: '@@', oldLine: null, newLine: null },
  { id: 2, kind: 'context', text: 'a', oldLine: 10, newLine: 10 },
  { id: 3, kind: 'deletion', text: 'b', oldLine: 11, newLine: null },
  { id: 4, kind: 'addition', text: 'c', oldLine: null, newLine: 11 },
] }
const diff = { files: [
  { path: 'src/deep/a.py', status: 'M', added: 1, removed: 1, isBinary: false, hunks: [hunk] },
  { path: 'src/b.py', status: 'A', added: 5, removed: 0, isBinary: false, hunks: [] },
  { path: 'tests/test_a.py', status: 'A', added: 3, removed: 0, isBinary: false, hunks: [] },
] }
const everything = { files: [
  { path: 'README.md', status: null, added: 0, removed: 0 },
  { path: 'src/deep/a.py', status: 'M', added: 1, removed: 1 },
  { path: 'src/b.py', status: 'A', added: 5, removed: 0 },
  { path: 'src/untouched.py', status: null, added: 0, removed: 0 },
  { path: 'tests/test_a.py', status: 'A', added: 3, removed: 0 },
] }

let mounted: any = null
let fileMounted: any = null
let diffOptions: any = null
const sideEditors = { original: { updateOptions: vi.fn() }, modified: { updateOptions: vi.fn() } }
const providers: Record<string, any> = {}
const wiring = { registerDefinitionProvider: vi.fn((_l: string, p: any) => { providers.definition = p }),
  registerReferenceProvider: vi.fn((_l: string, p: any) => { providers.references = p }),
  registerHoverProvider: vi.fn((_l: string, p: any) => { providers.hover = p }),
  registerDocumentHighlightProvider: vi.fn((_l: string, p: any) => { providers.highlights = p }) }

beforeEach(() => {
  vi.resetModules(); localStorage.clear(); mounted = null; fileMounted = null; diffOptions = null
  sideEditors.original.updateOptions.mockClear(); sideEditors.modified.updateOptions.mockClear()
  vi.doMock('@monaco-editor/react', () => ({
    DiffEditor: ({ onMount, beforeMount, options }: any) => {
      beforeMount?.({ languages: wiring }); diffOptions = options
      // Tests hand in the modified editor they need; both sides also take the gutter options.
      mounted = (stub: any) => onMount({ ...stub,
        getOriginalEditor: () => Object.assign(stub.getOriginalEditor?.() ?? {}, { updateOptions: sideEditors.original.updateOptions }),
        getModifiedEditor: () => Object.assign(stub.getModifiedEditor(), { updateOptions: sideEditors.modified.updateOptions }) })
      return <div data-testid="diff" />
    },
    default: ({ onMount, beforeMount, value }: any) => { beforeMount?.({ languages: wiring }); fileMounted = onMount; return <pre data-testid="file">{value}</pre> },
  }))
  vi.doMock('../../src/lib/monaco.ts', () => ({}))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = async (impl: Record<string, any> = {}, props: Record<string, any> = {}) => {
  const api = {
    diff: vi.fn(async () => diff), commits: vi.fn(async () => ({ commits: [{ sha: 'abc123', shortSHA: 'abc', subject: 'first' }] })),
    tree: vi.fn(async () => everything), file: vi.fn(async ({}: any) => ({ text: 'def x(): pass' })),
    definition: vi.fn(async () => ({ locations: [], error: null })), references: vi.fn(async () => ({ locations: [], error: null })),
    hover: vi.fn(async () => ({ text: null, error: null })),
    conversations: vi.fn(async () => ({ ok: false, message: 'no gh' })), ...impl,
  }
  api.file = impl.file ?? vi.fn(async () => ({ text: 'def x(): pass' }))
  vi.doMock('../../src/lib/api.ts', () => ({ api }))
  const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
  const onAddComment = vi.fn(); const onQuote = vi.fn(); const onCollapse = vi.fn()
  const view = render(<ReviewPanel worktreeID="w1" worktreePath="/w" branch="orch/x" baseBranch="main" isMain={false} generation={1}
                                   onAddComment={onAddComment} onQuote={onQuote} onCollapse={onCollapse} {...props} />)
  await waitFor(() => expect(api.diff).toHaveBeenCalled())
  return { api, onAddComment, onQuote, onCollapse, ...view }
}
const openSidebar = () => fireEvent.click(screen.getByRole('button', { name: 'Files and settings' }))
const files = () => screen.getAllByTestId('tree-file').map((el) => el.textContent)
const dirs = () => screen.getAllByTestId('tree-dir').map((el) => el.textContent)

describe('the review panel', () => {
  it('reviews a branch against its base by default, shows only code until the sidebar is asked for, and remembers', async () => {
    const { api } = await mount()
    expect(api.diff.mock.calls[0][1]).toBe('branch')
    expect(screen.queryByTestId('review-sidebar')).toBeNull()
    expect(screen.getByText('src/deep/a.py')).toBeTruthy()   // the first changed file is open
    openSidebar()
    expect(screen.getByTestId('review-sidebar')).toBeTruthy()
    expect(dirs()).toEqual(['▾src+6−1', '▾deep+1−1'])   // a folder carries what changed beneath it
    expect(files()).toEqual(['Ma.py+1−1', 'Ab.py+5'])
    expect(screen.getByText(/Tests \(1 files\)/)).toBeTruthy()   // set apart and folded
    fireEvent.click(screen.getByText(/Tests \(1 files\)/))
    expect(dirs()).toEqual(['▾src+6−1', '▾deep+1−1', '▾tests+3'])
    expect(files()).toEqual(['Ma.py+1−1', 'Ab.py+5', 'Atest_a.py+3'])
    fireEvent.click(screen.getByText('deep'))   // fold a folder
    expect(files()).toEqual(['Ab.py+5', 'Atest_a.py+3'])
    fireEvent.click(screen.getByText('b.py'))
    expect(screen.getAllByTestId('tree-file').find((el) => el.textContent?.includes('b.py'))!.getAttribute('aria-current')).toBe('true')
    const stored = JSON.parse(localStorage.getItem('orchestrator.review.w1')!)
    expect(stored).toMatchObject({ scope: 'branch', panelOpen: true, selected: 'src/b.py', folds: ['src/deep'] })
  })

  it('a main checkout reviews its uncommitted edits, and the stored state comes back after a remount', async () => {
    localStorage.setItem('orchestrator.review.w2', JSON.stringify({ scope: 'staged', commitSHA: null, context: 10, selected: 'src/b.py', mode: 'diff', treeMode: 'changed', panelOpen: true, viewing: null, history: [], folds: [] }))
    const { api } = await mount({}, { worktreeID: 'w2', isMain: true })
    expect(api.diff.mock.calls[0][1]).toBe('staged')
    expect(api.diff.mock.calls[0][3]).toBe(10)
    expect(screen.getByTestId('review-sidebar')).toBeTruthy()
    expect((screen.getByLabelText('What to compare') as HTMLSelectElement).value).toBe('staged')
    cleanup(); vi.resetModules()
    localStorage.clear()
    const fresh = await mount({}, { worktreeID: 'w3', isMain: true })
    expect(fresh.api.diff.mock.calls[0][1]).toBe('uncommitted')
  })

  it('switches scope, commit and context from the sidebar, and refreshes', async () => {
    const { api } = await mount()
    openSidebar()
    fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: 'sha:abc123' } })
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith('/w', 'commit', 'main', 3, 'abc123', undefined))
    expect(screen.getAllByText('first').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: 'uncommitted' } })
    fireEvent.change(screen.getByLabelText('Context lines'), { target: { value: '200' } })
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith('/w', 'uncommitted', 'main', 200, undefined, undefined))
    const calls = api.diff.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect(api.diff.mock.calls.length).toBe(calls + 1))
    fireEvent.click(screen.getByRole('button', { name: 'Hide review panel' }))
  })

  it('lists the whole project with the changed folders counted, opens any file as a file, and comes back', async () => {
    const { api } = await mount()
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    await waitFor(() => expect(api.tree).toHaveBeenCalledWith('/w', 'branch', 'main', undefined))
    await waitFor(() => expect(files()).toContain('·README.md'))
    expect(dirs()).toEqual(['▾src+6−1', '▾deep+1−1', '▾tests+3'])   // folders carry what changed beneath them
    expect(files()).toEqual(['Ma.py+1−1', 'Ab.py+5', '·untouched.py', 'Atest_a.py+3', '·README.md'])   // folders first
    expect(screen.queryByText(/Tests \(/)).toBeNull()   // tests are not set apart here
    fireEvent.click(screen.getByText('untouched.py'))
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())
    expect(api.file).toHaveBeenCalledWith('/w/src/untouched.py')
    expect(screen.getByText('src/untouched.py')).toBeTruthy()
    expect(screen.getAllByTestId('tree-file').find((el) => el.textContent?.includes('untouched'))!.getAttribute('aria-current')).toBe('true')
    // A changed file picked from the project tree goes back to its diff.
    fireEvent.click(screen.getByText('b.py'))
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
    fireEvent.click(screen.getByText('untouched.py'))
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
    expect(JSON.parse(localStorage.getItem('orchestrator.review.w1')!).treeMode).toBe('changed')
  })

  it('follows a definition into another file, lists usages there, and names servers that are missing', async () => {
    const { api } = await mount({
      definition: vi.fn(async () => ({ locations: [{ path: '/w/src/other.py', line: 7, character: 2 }], error: null })),
      references: vi.fn(async () => ({ locations: [{ path: '/w/src/other.py', line: 7, character: 2 }, { path: '/w/src/third.py', line: 1, character: 0 }], error: 'pyright-langserver is not installed' })),
      hover: vi.fn(async () => ({ text: 'def x()', error: null })),
    })
    await waitFor(() => expect(providers.definition).toBeTruthy())
    const model = { uri: 'file:///w/src/deep/a.py' }
    const inside = await providers.definition.provideDefinition(model, { lineNumber: 1, column: 1 })
    expect(inside).toEqual([])
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())   // navigated out of the diff
    expect(screen.getByText('src/other.py:7')).toBeTruthy()
    expect(api.file).toHaveBeenCalledWith('/w/src/other.py')
    const here = await providers.references.provideReferences(model, { lineNumber: 1, column: 1 })
    expect(here).toHaveLength(1)
    expect(screen.getByText(/2 usages, 1 outside this view/)).toBeTruthy()
    fireEvent.click(screen.getByText('dismiss'))
    expect(await providers.hover.provideHover(model, { lineNumber: 1, column: 1 })).toEqual({ contents: [{ value: 'def x()' }] })
    expect(screen.getByText(/F12 definition/)).toBeTruthy()
  })

  it('asks the language server about the file line behind a diff row, and brings its answer back to the row', async () => {
    const withDeletion = { files: [{ path: 'src/deep/a.py', status: 'M', added: 1, removed: 1, isBinary: false, hunks: [{ id: 1, header: '@@', lines: [
      { id: 1, kind: 'hunkHeader', text: '@@', oldLine: null, newLine: null },
      { id: 2, kind: 'context', text: 'a', oldLine: 40, newLine: 40 },
      { id: 3, kind: 'deletion', text: 'b', oldLine: 41, newLine: null },
      { id: 4, kind: 'addition', text: 'c', oldLine: null, newLine: 41 },
    ] }] }] }
    const { api } = await mount({ diff: vi.fn(async () => withDeletion),
      definition: vi.fn(async () => ({ locations: [{ path: '/w/src/deep/a.py', line: 41, character: 2 }], error: null })) })
    await waitFor(() => expect(providers.definition).toBeTruthy())
    const model = { uri: 'file:///w/src/deep/a.py' }
    // Row 1 is the context line, 40 in the file; the deletion has no row; row 2 is the added line 41.
    const found = await providers.definition.provideDefinition(model, { lineNumber: 1, column: 1 })
    expect(api.definition).toHaveBeenLastCalledWith('/w', '/w/src/deep/a.py', 39, 0)
    expect(found).toEqual([{ uri: model.uri, range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 } }])
    await providers.hover.provideHover(model, { lineNumber: 2, column: 1 })
    expect(api.hover).toHaveBeenLastCalledWith('/w', '/w/src/deep/a.py', 40, 0)
    // A definition on a line the diff does not show opens the file there.
    api.definition.mockResolvedValueOnce({ locations: [{ path: '/w/src/deep/a.py', line: 7, character: 0 }], error: null })
    expect(await providers.definition.provideDefinition(model, { lineNumber: 2, column: 1 })).toEqual([])
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())
    expect(screen.getByText('src/deep/a.py:7')).toBeTruthy()
    // In a file, rows are lines.
    await providers.definition.provideDefinition(model, { lineNumber: 7, column: 1 })
    expect(api.definition).toHaveBeenLastCalledWith('/w', '/w/src/deep/a.py', 6, 0)
  })

  it('opens what the chat asked for: a changed file in the diff, anything else as a file, once per request', async () => {
    const { rerender, api } = await mount()
    const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
    const props = { worktreeID: 'w1', worktreePath: '/w', baseBranch: 'main', isMain: false, generation: 1, onAddComment: vi.fn(), onQuote: vi.fn() }
    rerender(<ReviewPanel {...props} open={{ path: '/w/src/b.py', nonce: 1 }} />)
    await waitFor(() => expect(JSON.parse(localStorage.getItem('orchestrator.review.w1')!).selected).toBe('src/b.py'))
    expect(screen.getByTestId('diff')).toBeTruthy()
    rerender(<ReviewPanel {...props} open={{ path: '/w/docs/notes.md', line: 4, nonce: 2 }} />)
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())
    expect(api.file).toHaveBeenCalledWith('/w/docs/notes.md')
    expect(screen.getByText('docs/notes.md:4')).toBeTruthy()
    rerender(<ReviewPanel {...props} open={{ path: '/w/docs/notes.md', line: 4, nonce: 2 }} />)   // same nonce: nothing new
    expect(api.file).toHaveBeenCalledTimes(1)
  })

  it('quotes a selection and comments from the line numbers, in the diff and in a file', async () => {
    const { onQuote, onAddComment } = await mount()
    await waitFor(() => expect(mounted).toBeTruthy())
    const listeners: Record<string, any> = {}; let command: any = null
    const model = { getValueInRange: () => 'selected text', getLineContent: () => 'line text' }
    const modified = { onDidChangeCursorSelection: (cb: any) => { listeners.sel = cb }, addAction: vi.fn(), addCommand: (_k: number, cb: any) => { command = cb },
      onMouseDown: (cb: any) => { listeners.mouse = cb }, getModel: () => model, getSelection: () => ({ startLineNumber: 2, endLineNumber: 3 }) }
    act(() => { mounted({ getModifiedEditor: () => modified }) })
    act(() => { listeners.sel({ selection: { startLineNumber: 2, endLineNumber: 2 } }) })
    fireEvent.click(screen.getByRole('button', { name: /Quote → chat/ }))
    expect(onQuote).toHaveBeenCalledWith(expect.stringContaining('src/deep/a.py:11'))
    act(() => { command() }); expect(onQuote).toHaveBeenCalledTimes(2)
    model.getValueInRange = () => '  '
    act(() => { listeners.sel({ selection: { startLineNumber: 1, endLineNumber: 1 } }) }); act(() => { command() })
    expect(onQuote).toHaveBeenCalledTimes(2)
    act(() => { listeners.mouse({ target: { type: 1 } }) })
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 2 } } }) })
    const box = screen.getByPlaceholderText('What about this line?')
    fireEvent.keyDown(box, { key: 'Enter' })   // empty: nothing attached
    fireEvent.change(box, { target: { value: 'hmm' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })   // newline, not send
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAddComment).toHaveBeenCalledWith(expect.objectContaining({ file: 'src/deep/a.py', line: 11, body: 'hmm', snippet: 'line text' }))
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 1 } } }) })
    fireEvent.keyDown(screen.getByPlaceholderText('What about this line?'), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('What about this line?')).toBeNull()
    act(() => { listeners.mouse({ target: { type: 3, position: {} } }) })
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 1 } } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 1 } } }) })
    fireEvent.change(screen.getByPlaceholderText('What about this line?'), { target: { value: 'via button' } })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    expect(onAddComment).toHaveBeenCalledTimes(2)
  })

  it('walks back through the files it visited, reveals a line, and reads a file it cannot fetch as empty', async () => {
    const { api, rerender } = await mount({ file: vi.fn(async ({}: any) => ({ text: 'text' })) })
    api.file.mockImplementation(async (path: string) => { if (path.endsWith('bad.py')) throw new Error('unreadable'); return { text: 'text' } })
    const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
    const props = { worktreeID: 'w1', worktreePath: '/w', baseBranch: 'main', isMain: false, generation: 1, onAddComment: vi.fn(), onQuote: vi.fn() }
    rerender(<ReviewPanel {...props} open={{ path: '/w/one.py', line: 3, nonce: 11 }} />)
    await waitFor(() => expect(screen.getByText('one.py:3')).toBeTruthy())
    await waitFor(() => expect(fileMounted).toBeTruthy())
    const reveal = vi.fn(); const setPosition = vi.fn()
    const editor = { onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(), onMouseDown: vi.fn(), getModel: () => null, getSelection: () => null, revealLineInCenter: reveal, setPosition }
    act(() => { fileMounted(editor) })
    expect(reveal).toHaveBeenCalledWith(3)
    rerender(<ReviewPanel {...props} open={{ path: '/w/two.py', nonce: 12 }} />)
    await waitFor(() => expect(screen.getByText('two.py')).toBeTruthy())
    rerender(<ReviewPanel {...props} open={{ path: '/w/bad.py', nonce: 13 }} />)
    await waitFor(() => expect(screen.getByText('unreadable')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))   // to two.py
    await waitFor(() => expect(screen.getByText('two.py')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))   // to one.py
    await waitFor(() => expect(screen.getByText('one.py:3')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))   // to the diff
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
    // A file outside the worktree keeps its absolute path; a quote from a file maps lines one to one.
    rerender(<ReviewPanel {...props} open={{ path: '/usr/lib/py/os.py', line: 2, nonce: 14 }} />)
    await waitFor(() => expect(api.file).toHaveBeenCalledWith('/usr/lib/py/os.py'))
    expect(screen.getByText('/usr/lib/py/os.py:2')).toBeTruthy()
    const listeners: Record<string, any> = {}; let command: any = null
    const reader = { onDidChangeCursorSelection: (cb: any) => { listeners.sel = cb }, addAction: vi.fn(), addCommand: (_k: number, cb: any) => { command = cb }, onMouseDown: vi.fn(),
      getModel: () => ({ getValueInRange: () => 'from the file', getLineContent: () => 'l' }), getSelection: () => ({ startLineNumber: 2, endLineNumber: 3 }), revealLineInCenter: vi.fn(), setPosition: vi.fn() }
    act(() => { fileMounted(reader) })
    act(() => { command() })
    expect(props.onQuote).toHaveBeenCalledWith(expect.stringContaining('/usr/lib/py/os.py:2-3'))
    // The header's own button quotes the selection from a file, lines as they are.
    act(() => { listeners.sel({ selection: { startLineNumber: 4, endLineNumber: 4 } }) })
    fireEvent.click(screen.getByRole('button', { name: /Quote → chat/ }))
    expect(props.onQuote).toHaveBeenLastCalledWith(expect.stringContaining('/usr/lib/py/os.py:4'))
    // Without a model there is nothing to quote or comment on.
    act(() => { listeners.sel({ selection: { startLineNumber: 1, endLineNumber: 1 } }) })
    expect(screen.getByRole('button', { name: /Quote → chat/ })).toBeTruthy()
    // Opened from the diff, so Back returns to the diff (the button reads "‹ Diff" then).
    expect(screen.getByRole('button', { name: 'Back' }).textContent).toContain('Diff')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
  })

  it('treats a diff without files as empty, lists a main checkout without a base, and copes with no model', async () => {
    const { api } = await mount({ diff: vi.fn(async () => ({})) }, { worktreeID: 'w5', isMain: true })
    await waitFor(() => expect(screen.getByText(/No changes in “Uncommitted”/)).toBeTruthy())
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    await waitFor(() => expect(api.tree).toHaveBeenCalledWith('/w', 'uncommitted', null, undefined))
    await waitFor(() => expect(screen.getAllByTestId('tree-file').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(fileMounted).toBeTruthy())
    const listeners: Record<string, any> = {}; let command: any = null
    const blind = { onDidChangeCursorSelection: (cb: any) => { listeners.sel = cb }, addAction: vi.fn(), addCommand: (_k: number, cb: any) => { command = cb }, onMouseDown: (cb: any) => { listeners.mouse = cb },
      getModel: () => null, getSelection: () => ({ startLineNumber: 1, endLineNumber: 1 }), revealLineInCenter: vi.fn(), setPosition: vi.fn() }
    act(() => { fileMounted(blind) })
    act(() => { listeners.sel({ selection: { startLineNumber: 1, endLineNumber: 1 } }) })
    expect(screen.queryByRole('button', { name: /Quote → chat/ })).toBeNull()
    act(() => { command() })
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 1 } } }) })
    expect(screen.getByPlaceholderText('What about this line?')).toBeTruthy()
    // No selection at all when ⌘⏎ is pressed: nothing is sent.
    blind.getSelection = () => null
    act(() => { command() })
    expect(api.diff).toHaveBeenCalled()
    // Back with nothing changed lands on an empty diff.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getAllByText(/No changes in “Uncommitted”/).length).toBeGreaterThan(0))   // editor and sidebar both say so
    expect(screen.queryByTestId('file')).toBeNull()
  })

  it('says so when the diff cannot be read, when a file cannot, and when there is nothing to show', async () => {
    await mount({ diff: vi.fn(async () => { throw new Error('git exploded') }) })
    await waitFor(() => expect(screen.getByText('git exploded')).toBeTruthy())
    cleanup(); vi.resetModules()
    const { api } = await mount({ diff: vi.fn(async () => ({ files: [] })), commits: vi.fn(async () => { throw new Error('no log') }),
      tree: vi.fn(async () => { throw new Error('no tree') }), file: vi.fn(async () => { throw new Error('unreadable') }) })
    await waitFor(() => expect(screen.getByText(/No changes in “Branch vs its base”/)).toBeTruthy())
    openSidebar()
    expect(within(screen.getByTestId('review-sidebar')).getByText(/No changes in/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    await waitFor(() => expect(screen.getByText('no tree')).toBeTruthy())
    expect(api.tree).toHaveBeenCalled()
    fireEvent.click(screen.getByText('dismiss'))
    expect(screen.queryByText('no tree')).toBeNull()
  })

  it('shows a deleted file in red, an added one in green, and answers a commit that is no longer listed', async () => {
    const withStatuses = { files: [
      { path: 'gone.py', status: 'D', added: 0, removed: 4, isBinary: false, hunks: [] },
      { path: 'new.py', status: 'A', added: 2, removed: 0, isBinary: false, hunks: [] },
    ] }
    localStorage.setItem('orchestrator.review.w9', JSON.stringify({ scope: 'commit', commitSHA: 'zzz', context: 3, selected: null, mode: 'diff', treeMode: 'changed', panelOpen: true, viewing: null, history: [], folds: ['§tests'] }))
    await mount({ diff: vi.fn(async () => withStatuses), commits: vi.fn(async () => ({})) }, { worktreeID: 'w9' })
    await waitFor(() => expect(screen.getAllByTestId('tree-file')).toHaveLength(2))
    const [gone, added] = screen.getAllByTestId('tree-file')
    expect(gone.querySelector('span')!.className).toContain('text-bad')
    expect(added.querySelector('span')!.className).toContain('text-ok')
    expect(screen.getByText('Commit')).toBeTruthy()   // the sha is not among the commits any more
  })
})

describe('walking the file trail', () => {
  const stored = () => JSON.parse(localStorage.getItem('orchestrator.review.w1')!)
  const side = (button: number, type: 'mousedown' | 'mouseup') => {
    const event = new MouseEvent(type, { button, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('goes back and forward over the files read, by button and by the mouse side buttons', async () => {
    await mount()
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    await waitFor(() => expect(screen.getAllByTestId('tree-file').length).toBeGreaterThan(2))
    fireEvent.click(screen.getByText('untouched.py'))
    await waitFor(() => expect(stored().viewing.path).toBe('src/untouched.py'))
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => expect(stored().viewing.path).toBe('README.md'))
    expect(stored().future).toEqual([])                      // a new file drops the forward trail

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(stored().viewing.path).toBe('src/untouched.py'))
    expect(stored().future.map((entry: any) => entry.path)).toEqual(['README.md'])

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(stored().viewing.path).toBe('README.md'))
    expect(stored().future).toEqual([])

    // Mouse 4 is Back, mouse 5 is Forward, and neither reaches the browser's own history.
    expect(side(3, 'mousedown').defaultPrevented).toBe(true)
    side(3, 'mouseup')
    await waitFor(() => expect(stored().viewing.path).toBe('src/untouched.py'))
    expect(side(4, 'mousedown').defaultPrevented).toBe(true)
    side(4, 'mouseup')
    await waitFor(() => expect(stored().viewing.path).toBe('README.md'))
    // Any other button is left alone.
    expect(side(0, 'mousedown').defaultPrevented).toBe(false)
  })

  it('switches the tree between changed files and the whole project from the top bar', async () => {
    await mount()
    expect(stored().treeMode).toBe('changed')
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole project' }))
    await waitFor(() => expect(stored().treeMode).toBe('all'))
    fireEvent.click(screen.getByRole('button', { name: 'Show only changed files' }))
    await waitFor(() => expect(stored().treeMode).toBe('changed'))
  })

  it('survives a stored state saved before Forward existed', async () => {
    localStorage.setItem('orchestrator.review.w1', JSON.stringify({
      scope: 'branch', commitSHA: null, context: 3, selected: null, mode: 'diff', treeMode: 'changed',
      panelOpen: false, viewing: null, history: [], folds: ['§tests'],   // no `future` key at all
    }))
    await mount()
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole project' }))
    await waitFor(() => expect(stored().treeMode).toBe('all'))
  })
})

describe('the review panel folds from the same control as every other panel', () => {
  it('puts it first, at the top-left, wearing the shared class', async () => {
    const { onCollapse } = await mount()
    const toggle = screen.getByRole('button', { name: 'Hide review panel' })
    expect(toggle.className).toContain('panel-toggle')
    expect(toggle.parentElement!.firstElementChild).toBe(toggle)   // ahead of ☰ and the rest
    fireEvent.click(toggle)
    expect(onCollapse).toHaveBeenCalled()
  })
})

describe('the pull request conversations, under the tree', () => {
  const stored = () => JSON.parse(localStorage.getItem('orchestrator.review.w1')!)
  const threads = {
    ok: true, number: 42, title: 'Harden it', url: 'u', headSHA: 'abc123',
    threads: [
      { id: 't1', path: 'src/deep/a.py', line: 11, originalLine: 11, outdated: false, resolved: false,
        snippet: null, comments: [{ id: 'c1', author: 'alice', avatarURL: null, body: 'rename this', createdAt: '', url: '' }] },
      { id: 't2', path: 'src/gone.py', line: null, originalLine: 7, outdated: true, resolved: false,
        snippet: '@@ -7 +7 @@\n-old line', comments: [{ id: 'c2', author: 'bob', avatarURL: null, body: 'was wrong', createdAt: '', url: '' }] },
      { id: 't3', path: null, line: null, originalLine: null, outdated: false, resolved: true,
        snippet: null, comments: [{ id: 'c3', author: 'carol', avatarURL: null, body: 'ship it', createdAt: '', url: '' }] },
    ],
  }

  it('folds shut by default, remembers being opened, and shows each conversation', async () => {
    const conversations = vi.fn(async () => threads)
    await mount({ conversations }, { branch: 'orch/x' })
    openSidebar()
    expect(screen.queryByTestId('conversations')).toBeNull()   // folded until asked for
    expect(conversations).not.toHaveBeenCalled()               // and not fetched either
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getByTestId('conversations')).toBeTruthy())
    expect(conversations).toHaveBeenCalledWith('/w', 'orch/x')
    await waitFor(() => expect(screen.getAllByTestId('pr-thread')).toHaveLength(3))
    expect(stored().conversationsOpen).toBe(true)
    expect(screen.getByText('rename this')).toBeTruthy()
    // The outdated one keeps the diff it was written against, and says so.
    expect(screen.getByText('outdated')).toBeTruthy()
    expect(screen.getByText(/-old line/)).toBeTruthy()
    expect(screen.getByText('resolved')).toBeTruthy()
    expect(screen.getByText('on the pull request')).toBeTruthy()
  })

  it('opens the file a conversation is about, and says when there is no line left to open', async () => {
    const { api } = await mount({ conversations: vi.fn(async () => threads) }, { branch: 'orch/x' })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getAllByTestId('pr-thread')).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: /a\.py:11/ }))
    await waitFor(() => expect(api.file).toHaveBeenCalledWith('/w/src/deep/a.py'))
    expect(stored().viewing).toMatchObject({ path: 'src/deep/a.py', line: 11 })
    fireEvent.click(screen.getByRole('button', { name: /gone\.py/ }))
    await waitFor(() => expect(screen.getByText(/outdated: the line it was written against is gone/i)).toBeTruthy())
  })

  it('says what is wrong instead of an empty list', async () => {
    await mount({ conversations: vi.fn(async () => ({ ok: false, message: 'gh is not signed in' })) }, { branch: 'orch/x' })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getByText('gh is not signed in')).toBeTruthy())
  })

  it('has nothing to show for a worktree that is not on a branch', async () => {
    await mount({}, { branch: null })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    expect(screen.getByText(/not on a branch/)).toBeTruthy()
  })
})

describe('commenting on a line of the pull request', () => {
  const pr = {
    ok: true, number: 7, title: 'Add widgets', url: 'u', headSHA: 'deadbee',
    threads: [{ id: 't1', path: 'src/deep/a.py', line: 11, originalLine: 11, outdated: false, resolved: false,
                snippet: null, comments: [{ id: 'c1', author: 'alice', avatarURL: null, body: 'hm', createdAt: '', url: '' }] }],
  }
  const openBox = async (api: any) => {
    await waitFor(() => expect(mounted).toBeTruthy())
    const listeners: Record<string, any> = {}
    const modified = { onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(),
      onMouseDown: (cb: any) => { listeners.mouse = cb },
      getModel: () => ({ getValueInRange: () => '', getLineContent: () => 'line text' }), getSelection: () => null }
    act(() => { mounted({ getModifiedEditor: () => modified }) })
    // The conversations must be loaded before the panel knows which commit a comment would land on.
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(api.conversations).toHaveBeenCalled())
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 2 } } }) })
    return screen.getByPlaceholderText('What about this line?')
  }

  it('posts the comment against the head commit and shows where it landed', async () => {
    const postLineComment = vi.fn(async () => ({ ok: true, url: 'https://example.com/c' }))
    const { api } = await mount({ conversations: vi.fn(async () => pr), postLineComment })
    const box = await openBox(api)
    fireEvent.change(box, { target: { value: 'this is wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on PR' }))
    await waitFor(() => expect(postLineComment).toHaveBeenCalledWith(expect.objectContaining({
      path: '/w', prNumber: 7, commitSHA: 'deadbee', file: 'src/deep/a.py', line: 11, body: 'this is wrong',
    })))
    await waitFor(() => expect(screen.getByText(/Posted on src\/deep\/a\.py:11/)).toBeTruthy())
    expect(screen.queryByPlaceholderText('What about this line?')).toBeNull()
    expect(api.conversations).toHaveBeenCalledTimes(2)   // refreshed, so the new comment shows
  })

  it('says why GitHub refused instead of pretending the comment landed', async () => {
    const postLineComment = vi.fn(async () => ({ ok: false, message: 'line is not part of the diff' }))
    const { api } = await mount({ conversations: vi.fn(async () => pr), postLineComment })
    const box = await openBox(api)
    fireEvent.change(box, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on PR' }))
    await waitFor(() => expect(screen.getByText('line is not part of the diff')).toBeTruthy())
    expect(screen.getByPlaceholderText('What about this line?')).toBeTruthy()   // still there to retry
  })

  it('offers only the chat when there is no pull request to comment on', async () => {
    const { api } = await mount({ conversations: vi.fn(async () => ({ ok: false, message: 'no gh' })) })
    await openBox(api)
    expect(screen.queryByRole('button', { name: 'Comment on PR' })).toBeNull()
    expect(screen.getByText(/Attaches to the chat/)).toBeTruthy()
  })
})

describe('the sidebar split', () => {
  it('drags the line between the tree and the conversations, and double-click puts it back', async () => {
    await mount({ conversations: vi.fn(async () => ({ ok: false, message: 'no gh' })) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    const handle = await screen.findByRole('separator', { name: 'Resize conversations' })
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 400 })
    fireEvent(window, new MouseEvent('mousemove', { clientY: 460 }))
    fireEvent(window, new MouseEvent('mouseup'))
    const stored = () => JSON.parse(localStorage.getItem('orchestrator.review.w1')!)
    await waitFor(() => expect(stored().treeHeight).toBe(320))
    fireEvent.doubleClick(handle)
    await waitFor(() => expect(stored().treeHeight).toBe(260))
    // It never collapses past a usable height.
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 400 })
    fireEvent(window, new MouseEvent('mousemove', { clientY: 0 }))
    fireEvent(window, new MouseEvent('mouseup'))
    await waitFor(() => expect(stored().treeHeight).toBe(80))
  })
})

describe('conversations that come back empty or broken', () => {
  it('says there are none yet, and reports a request that threw', async () => {
    await mount({ conversations: vi.fn(async () => ({ ok: true, number: 5, title: 't', url: 'u', headSHA: 'a', threads: [] })) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getByText(/No comments on #5 yet/)).toBeTruthy())
  })

  it('shows the reason when the request itself fails', async () => {
    await mount({ conversations: vi.fn(async () => { throw new Error('network is down') }) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getByText('network is down')).toBeTruthy())
  })

  it('falls back to its own wording when GitHub refuses without saying why', async () => {
    const pr = { ok: true, number: 7, title: 't', url: 'u', headSHA: 'abc', threads: [] }
    const { api } = await mount({ conversations: vi.fn(async () => pr), postLineComment: vi.fn(async () => ({ ok: false })) })
    await waitFor(() => expect(mounted).toBeTruthy())
    const listeners: Record<string, any> = {}
    act(() => { mounted({ getModifiedEditor: () => ({ onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(),
      onMouseDown: (cb: any) => { listeners.mouse = cb },
      getModel: () => ({ getValueInRange: () => '', getLineContent: () => 'x' }), getSelection: () => null }) }) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(api.conversations).toHaveBeenCalled())
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 2 } } }) })
    fireEvent.change(screen.getByPlaceholderText('What about this line?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on PR' }))
    await waitFor(() => expect(screen.getByText('GitHub refused the comment.')).toBeTruthy())
  })

  it('reports a post that threw outright', async () => {
    const pr = { ok: true, number: 7, title: 't', url: 'u', headSHA: 'abc', threads: [] }
    const { api } = await mount({ conversations: vi.fn(async () => pr),
      postLineComment: vi.fn(async () => { throw new Error('socket hang up') }) })
    await waitFor(() => expect(mounted).toBeTruthy())
    const listeners: Record<string, any> = {}
    act(() => { mounted({ getModifiedEditor: () => ({ onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(),
      onMouseDown: (cb: any) => { listeners.mouse = cb },
      getModel: () => ({ getValueInRange: () => '', getLineContent: () => 'x' }), getSelection: () => null }) }) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(api.conversations).toHaveBeenCalled())
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 2 } } }) })
    fireEvent.change(screen.getByPlaceholderText('What about this line?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on PR' }))
    await waitFor(() => expect(screen.getByText('socket hang up')).toBeTruthy())
  })
})

describe('leaving the panel before the conversations arrive', () => {
  it('drops both the answer and the failure once the panel is gone', async () => {
    let land: (value: any) => void = () => {}
    const pending = new Promise((resolve) => { land = resolve })
    const { unmount } = await mount({ conversations: () => pending })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    unmount()
    land({ ok: true, number: 1, title: 't', url: 'u', headSHA: 'a', threads: [] })
    await pending
  })

  it('does the same when the request fails after the panel is gone', async () => {
    let fail: (error: Error) => void = () => {}
    const pending = new Promise((_resolve, reject) => { fail = reject })
    const { unmount } = await mount({ conversations: () => pending })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    unmount()
    fail(new Error('too late'))
    await pending.catch(() => {})
  })

  it('still says the comment landed when re-reading the conversations fails', async () => {
    const pr = { ok: true, number: 7, title: 't', url: 'u', headSHA: 'abc', threads: [] }
    const conversations = vi.fn()
      .mockResolvedValueOnce(pr)
      .mockRejectedValueOnce(new Error('refresh failed'))
    const { api } = await mount({ conversations, postLineComment: vi.fn(async () => ({ ok: true, url: 'u' })) })
    await waitFor(() => expect(mounted).toBeTruthy())
    const listeners: Record<string, any> = {}
    act(() => { mounted({ getModifiedEditor: () => ({ onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(),
      onMouseDown: (cb: any) => { listeners.mouse = cb },
      getModel: () => ({ getValueInRange: () => '', getLineContent: () => 'x' }), getSelection: () => null }) }) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(api.conversations).toHaveBeenCalled())
    act(() => { listeners.mouse({ target: { type: 3, position: { lineNumber: 2 } } }) })
    fireEvent.change(screen.getByPlaceholderText('What about this line?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on PR' }))
    await waitFor(() => expect(screen.getByText(/Posted on/)).toBeTruthy())
  })
})

describe('right-click → Quote in chat', () => {
  const composed = () => {
    const seen: string[] = []
    window.addEventListener('orchestrator:compose', (event) => seen.push((event as CustomEvent).detail.text))
    return seen
  }
  const editorWith = (selection: any, actions: Record<string, any>, lines: (line: number) => string | null) => ({
    onDidChangeCursorSelection: vi.fn(), addCommand: vi.fn(), onMouseDown: vi.fn(),
    addAction: (action: any) => { actions[action.id] = action },
    getSelection: () => selection, getModel: () => (lines(1) === null ? null : { getLineContent: lines }),
  })

  it('quotes the selected lines of the diff as the hunk around them', async () => {
    await mount()
    await waitFor(() => expect(mounted).toBeTruthy())
    const seen = composed()
    const actions: Record<string, any> = {}
    const modified = editorWith({ startLineNumber: 2, endLineNumber: 3, endColumn: 5 }, actions, (line) => `m${line}`)
    act(() => { mounted({ getModifiedEditor: () => modified,
      getLineChanges: () => [{ originalStartLineNumber: 5, originalEndLineNumber: 5, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }],
      getOriginalEditor: () => ({ getModel: () => ({ getLineContent: (line: number) => `o${line}` }) }) }) })
    expect(actions['orchestrator.quote']).toMatchObject({ label: 'Quote in chat', contextMenuGroupId: '9_cutcopypaste' })
    actions['orchestrator.quote'].run()
    expect(seen).toHaveLength(1)
    const [header, ...body] = seen[0].split('\n')
    expect(header).toMatch(/^> \[src\/deep\/a\.py:\d+-\d+, from the diff\]$/)
    expect(body).toEqual(['>   m2', '> - o5', '> + m3'])
    // A selection that ends at the start of the next line does not take that line; no changes known → plain lines.
    const shorter = editorWith({ startLineNumber: 2, endLineNumber: 3, endColumn: 1 }, actions, (line) => `m${line}`)
    act(() => { mounted({ getModifiedEditor: () => shorter, getLineChanges: () => null, getOriginalEditor: () => ({ getModel: () => null }) }) })
    actions['orchestrator.quote'].run()
    expect(seen[1].split('\n')).toEqual([expect.stringMatching(/^> \[src\/deep\/a\.py:\d+, from the diff\]$/), '>   m2'])
    // Old lines whose model is gone quote as empty rather than throwing.
    const orphan = editorWith({ startLineNumber: 1, endLineNumber: 1, endColumn: 3 }, actions, (line) => `m${line}`)
    act(() => { mounted({ getModifiedEditor: () => orphan,
      getLineChanges: () => [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 }],
      getOriginalEditor: () => ({ getModel: () => null }) }) })
    actions['orchestrator.quote'].run()
    expect(seen[2].split('\n').slice(1)).toEqual(['>   m1', '> -'])
    // Nothing selected, or no model yet: nothing to quote.
    const empty = editorWith(null, actions, () => null)
    act(() => { mounted({ getModifiedEditor: () => empty, getLineChanges: () => [], getOriginalEditor: () => ({ getModel: () => null }) }) })
    actions['orchestrator.quote'].run()
    expect(seen).toHaveLength(3)
  })

  it('quotes lines of a whole file by their real numbers', async () => {
    const { rerender } = await mount()
    const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
    const props = { worktreeID: 'w1', worktreePath: '/w', baseBranch: 'main', isMain: false, generation: 1, onAddComment: vi.fn(), onQuote: vi.fn() }
    rerender(<ReviewPanel {...props} open={{ path: '/w/one.py', line: 3, nonce: 11 }} />)
    await waitFor(() => expect(fileMounted).toBeTruthy())
    const seen = composed()
    const actions: Record<string, any> = {}
    const editor = { ...editorWith({ startLineNumber: 2, endLineNumber: 4, endColumn: 9 }, actions, (line) => `line ${line}`), revealLineInCenter: vi.fn(), setPosition: vi.fn() }
    act(() => { fileMounted(editor) })
    actions['orchestrator.quote'].run()
    expect(seen).toEqual(['> [one.py:2-4]\n> line 2\n> line 3\n> line 4'])
  })

  it('quotes a pull-request comment with who wrote it and where', async () => {
    const threads = [
      { id: 't1', path: 'src/deep/a.py', line: 11, originalLine: 11, outdated: false, resolved: false, snippet: null, comments: [{ id: 'c1', author: 'alice', body: 'why this?' }] },
      { id: 't2', path: null, line: null, originalLine: null, outdated: false, resolved: false, snippet: null, comments: [{ id: 'c2', author: 'bob', body: 'overall fine' }] },
      { id: 't3', path: 'src/b.py', line: null, originalLine: 4, outdated: true, resolved: true, snippet: 'old', comments: [{ id: 'c3', author: 'carol', body: 'gone now' }] },
    ] as any
    await mount({ conversations: vi.fn(async () => ({ ok: true, number: 5, title: 't', url: 'u', headSHA: 'a', threads })) })
    openSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
    await waitFor(() => expect(screen.getByText('why this?')).toBeTruthy())
    const seen = composed()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.contextMenu(screen.getByText('why this?'), { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('why this?')
    fireEvent.contextMenu(screen.getByText('why this?'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote in chat' }))
    fireEvent.contextMenu(screen.getByText('overall fine'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote in chat' }))
    fireEvent.contextMenu(screen.getByText('gone now'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote in chat' }))
    expect(seen).toEqual([
      '> [alice on #5, a.py:11]\n> why this?',
      '> [bob on #5]\n> overall fine',
      '> [carol on #5, b.py]\n> gone now',
    ])
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('the trail behind the mouse buttons', () => {
  it('goes back to the diff from the first file and forward to it again, and does nothing past either end', async () => {
    const { rerender } = await mount()
    const { ReviewPanel } = await import('../../src/components/ReviewPanel.tsx')
    const props = { worktreeID: 'w1', worktreePath: '/w', baseBranch: 'main', isMain: false, generation: 1, onAddComment: vi.fn(), onQuote: vi.fn() }
    fireEvent.mouseUp(window, { button: 4 })   // nothing ahead
    fireEvent.mouseUp(window, { button: 3 })   // nothing behind and nothing open: the diff it already shows
    expect(screen.getByTestId('diff')).toBeTruthy()
    rerender(<ReviewPanel {...props} open={{ path: '/w/one.py', line: 3, nonce: 11 }} />)
    await waitFor(() => expect(screen.getByText('one.py:3')).toBeTruthy())
    fireEvent.mouseUp(window, { button: 3 })   // back from the first file: the diff, with the file ahead
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
    fireEvent.mouseUp(window, { button: 4 })   // and forward to it again
    await waitFor(() => expect(screen.getByText('one.py:3')).toBeTruthy())
  })
})

describe('a review state saved before there was a trail', () => {
  const old = (viewing: { path: string; line?: number } | null) => JSON.stringify({
    scope: 'branch', commitSHA: null, context: 3, selected: viewing?.path ?? null, mode: viewing ? 'file' : 'diff',
    treeMode: 'changed', panelOpen: false, viewing, history: [], folds: [],
  })
  it('walks back and forward without one', async () => {
    localStorage.setItem('orchestrator.review.w1', old({ path: '/w/one.py', line: 1 }))
    await mount()
    fireEvent.mouseUp(window, { button: 4 })   // nothing ahead, and no list to say so
    fireEvent.mouseUp(window, { button: 3 })   // back from the file: the diff, with the file ahead
    await waitFor(() => expect(screen.getByTestId('diff')).toBeTruthy())
    fireEvent.mouseUp(window, { button: 4 })   // and forward to it again
    await waitFor(() => expect(screen.getByTestId('file')).toBeTruthy())
    cleanup(); localStorage.clear(); vi.resetModules()
    localStorage.setItem('orchestrator.review.w1', old(null))
    await mount()
    fireEvent.mouseUp(window, { button: 3 })   // nothing open and nothing behind: the diff stays
    expect(screen.getByTestId('diff')).toBeTruthy()
  })
})

describe('the last turn', () => {
  it('is a scope of its own, and says when no turn has finished yet', async () => {
    const { api } = await mount({ diff: vi.fn(async (_path: string, scope: string) => (scope === 'turn' ? { files: [], turn: null } : diff)) })
    openSidebar()
    fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: 'turn' } })
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith('/w', 'turn', 'main', 3, undefined, undefined))
    await waitFor(() => expect(screen.getAllByText('No turn has finished in this worktree yet.').length).toBeGreaterThan(0))
    api.diff.mockImplementation(async (_path: string, scope: string) => (scope === 'turn' ? { files: [], turn: { sessionID: 's', endedAt: 1 } } : diff))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect(screen.getAllByText('No changes in “Last turn”.').length).toBeGreaterThan(0))
  })
})

describe('changing scope while a diff is still loading', () => {
  const pick = (scope: string) => { openSidebar(); fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: scope } }) }
  it('shows the scope chosen now, not the one whose slower answer arrives last', async () => {
    const settle: Record<string, (value: any) => void> = {}
    await mount({ diff: vi.fn((_path: string, scope: string) => new Promise((resolve) => { settle[scope] = resolve })) })
    pick('staged')
    settle.staged({ files: [diff.files[1]] })
    await waitFor(() => expect(screen.getByTestId('diff-files').textContent).toBe('1 file'))
    settle.branch(diff)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByTestId('diff-files').textContent).toBe('1 file')
  })
  it('does not report a failure that belongs to the scope it left', async () => {
    const fail: Record<string, (error: Error) => void> = {}
    await mount({ diff: vi.fn((_path: string, scope: string) => new Promise((_resolve, reject) => { fail[scope] = reject })) })
    pick('staged')
    fail.branch(new Error('slow git exploded'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('slow git exploded')).toBeNull()
    fail.staged(new Error('this one counts'))
    await waitFor(() => expect(screen.getByText('this one counts')).toBeTruthy())
  })
})

describe('what a branch is measured against', () => {
  it('offers its base and main as two scopes, and says which branch the server compared with', async () => {
    const { api } = await mount({ diff: vi.fn(async (_path: string, scope: string) => ({ ...diff, base: scope === 'main' ? 'main' : scope === 'branch' ? 'feature/one' : null })) })
    openSidebar()
    await waitFor(() => expect(screen.getByTestId('diff-base').textContent).toBe('vs feature/one'))
    fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: 'main' } })
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith('/w', 'main', 'main', 3, undefined, undefined))
    await waitFor(() => expect(screen.getByTestId('diff-base').textContent).toBe('vs main'))
    fireEvent.change(screen.getByLabelText('What to compare'), { target: { value: 'uncommitted' } })
    await waitFor(() => expect(screen.queryByTestId('diff-base')).toBeNull())
    // The headline counts every file, the way GitHub does; tests are named as a part of it.
    expect(screen.getByTitle(/Lines added/).textContent).toBe('+9')
    expect(screen.getByTitle(/Lines removed/).textContent).toBe('−1')
    expect(screen.getByTestId('diff-files').textContent).toBe('3 files')
    expect(screen.getByText(/of which tests/).textContent).toBe('of which tests +3 −0')
    // Arriving at a worktree fetched origin first; a scope change did not; the button does again.
    expect(api.diff.mock.calls[0][5]).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diff' }))
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith('/w', 'uncommitted', 'main', 3, undefined, true))
    const { describeScope } = await import('../../src/components/ReviewPanel.tsx')
    expect(describeScope('branch', null)).toBe('Branch vs its base')
    expect(describeScope('main', null)).toBe('Branch vs main')
    expect(describeScope('main', 'develop')).toBe('Branch vs develop')
    expect(describeScope('staged', null)).toBe('Staged')
    cleanup(); vi.resetModules()
    await mount({ diff: vi.fn(async () => ({ files: [diff.files[1]] })) })
    expect(screen.getByTestId('diff-files').textContent).toBe('1 file')
    expect(screen.queryByText(/of which tests/)).toBeNull()
  })
})

describe('long lines and the gutter', () => {
  it('wraps on request, remembers it, and binds ⌥Z the way VS Code does', async () => {
    await mount()
    await waitFor(() => expect(diffOptions).toBeTruthy())
    expect(diffOptions).toMatchObject({ wordWrap: 'off', diffWordWrap: 'off', lineDecorationsWidth: 18 })
    const toggle = () => screen.getByRole('button', { name: 'Wrap long lines' })
    fireEvent.click(toggle())
    await waitFor(() => expect(diffOptions).toMatchObject({ wordWrap: 'on', diffWordWrap: 'on' }))
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('orchestrator.review.w1')!).wrap).toBe(true)
    const commands: Array<[number, () => void]> = []
    const modified = { onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), onMouseDown: vi.fn(), getModel: () => null, getSelection: () => null,
      addCommand: (key: number, run: () => void) => { commands.push([key, run]) } }
    act(() => { mounted({ getModifiedEditor: () => modified }) })
    act(() => { commands.find(([key]) => key === (512 | 56))![1]() })
    await waitFor(() => expect(diffOptions).toMatchObject({ wordWrap: 'off', diffWordWrap: 'off' }))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('numbers each side\'s rows by that side\'s file lines, in a gutter as wide as the largest number', async () => {
    await mount()
    await waitFor(() => expect(mounted).toBeTruthy())
    act(() => { mounted({ getModifiedEditor: () => ({ onDidChangeCursorSelection: vi.fn(), addAction: vi.fn(), addCommand: vi.fn(), onMouseDown: vi.fn() }) }) })
    const numbering = (side: { updateOptions: ReturnType<typeof vi.fn> }) => side.updateOptions.mock.calls.at(-1)![0].lineNumbers as (row: number) => string
    // The fixture hunk keeps line 10, deletes old line 11 and adds new line 11.
    expect([1, 2, 3].map(numbering(sideEditors.modified))).toEqual(['10', '11', ''])
    expect([1, 2, 3].map(numbering(sideEditors.original))).toEqual(['10', '11', ''])
    expect(diffOptions.lineNumbers).toBeUndefined()   // Monaco would copy it onto both sides
    expect(diffOptions.lineNumbersMinChars).toBe(3)
  })
})
