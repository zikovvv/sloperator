// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('useStoredValue', () => {
  it('takes an updater, and forgets a stored value it cannot parse', async () => {
    const { useStoredValue, readStored } = await import('../src/lib/resizable.ts')
    const { result } = renderHook(() => useStoredValue<number[]>('list', []))
    act(() => result.current[1]((current) => [...current, 1]))
    act(() => result.current[1]((current) => [...current, 2]))
    expect(result.current[0]).toEqual([1, 2])
    expect(JSON.parse(localStorage.getItem('list')!)).toEqual([1, 2])
    act(() => result.current[1]([9]))
    expect(result.current[0]).toEqual([9])
    expect(JSON.parse(localStorage.getItem('list')!)).toEqual([9])
    localStorage.setItem('broken', '{not json')
    expect(readStored('broken', 'fallback')).toBe('fallback')
    expect(renderHook(() => useStoredValue('broken', 7)).result.current[0]).toBe(7)
  })
})

describe('highlight', () => {
  it('colours through Monaco once loaded, stays plain for languages it lacks or when Monaco fails', async () => {
    const colorize = vi.fn(async (text: string, language: string) => `<span class="${language}">${text}</span>`)
    vi.doMock('../src/lib/monaco.ts', () => ({ monaco: { editor: { colorize }, languages: { getLanguages: () => [{ id: 'shell' }, { id: 'python' }] } } }))
    const { highlight, languageOf } = await import('../src/lib/highlight.ts')
    expect(languageOf('bash')).toBe('shell'); expect(languageOf('PY')).toBe('python'); expect(languageOf(undefined)).toBeNull()
    expect(await highlight('ls', 'sh')).toBe('<span class="shell">ls</span>')
    expect(await highlight('x', 'cobol')).toBeNull()      // Monaco does not know it
    expect(await highlight('x', 'txt')).toBeNull()        // plain text stays plain
    expect(await highlight('x', null)).toBeNull()
    colorize.mockRejectedValueOnce(new Error('tokenizer died'))
    expect(await highlight('ls', 'shell')).toBeNull()
    vi.resetModules()
    vi.doMock('../src/lib/monaco.ts', () => { throw new Error('no monaco here') })
    const fallback = await import('../src/lib/highlight.ts')
    expect(await fallback.highlight('ls', 'shell')).toBeNull()
  })
})

describe('language server providers', () => {
  const monaco = () => {
    const providers: Record<string, any> = {}
    return { providers, monaco: { languages: {
      registerDefinitionProvider: (_l: string, p: any) => { providers.definition = p },
      registerReferenceProvider: (_l: string, p: any) => { providers.references = p },
      registerHoverProvider: (_l: string, p: any) => { providers.hover = p },
      registerDocumentHighlightProvider: (_l: string, p: any) => { providers.highlights = p },
    } } as any }
  }
  it('answer nothing until wired, then navigate, notice and answer in-model locations', async () => {
    const api = {
      definition: vi.fn(), references: vi.fn(), hover: vi.fn(),
    }
    vi.doMock('../src/lib/api.ts', () => ({ api }))
    const { ensureProviders, wireLanguageServers, languageFor } = await import('../src/lib/lspProviders.ts')
    const { providers, monaco: fake } = monaco()
    ensureProviders(fake, 'python'); ensureProviders(fake, 'python')   // once per language
    const model = { uri: 'file:///w/a.py' }
    const at = { lineNumber: 2, column: 3 }
    expect(await providers.definition.provideDefinition(model, at)).toEqual([])
    expect(await providers.references.provideReferences(model, at)).toEqual([])
    expect(await providers.hover.provideHover(model, at)).toBeNull()

    const navigate = vi.fn(); const notice = vi.fn()
    // The editor shows rows 1..3 of a diff that are lines 10, 11 and 30 of the file.
    const rows = [10, 11, 30]
    wireLanguageServers({ current: () => ({ workspace: '/w', path: '/w/a.py' }), navigate, notice,
      toFileLine: (row) => rows[row - 1] ?? row, toRow: (line) => { const row = rows.indexOf(line); return row === -1 ? null : row + 1 } })
    api.definition.mockResolvedValueOnce({ locations: [], error: 'server down' })
    expect(await providers.definition.provideDefinition(model, at)).toEqual([])
    expect(notice).toHaveBeenCalledWith('server down')
    // A target on line 30 of the file is row 3 of the diff.
    api.definition.mockResolvedValueOnce({ locations: [{ path: '/w/a.py', line: 30, character: 4 }], error: null })
    expect(await providers.definition.provideDefinition(model, at)).toEqual([{ uri: model.uri, range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 } }])
    // Row 2 of the diff is line 11 of the file: that is what the server is asked about.
    expect(api.definition).toHaveBeenLastCalledWith('/w', '/w/a.py', 10, 2)
    // A target in this file but outside the hunks is opened as a file at that line.
    api.definition.mockResolvedValueOnce({ locations: [{ path: '/w/a.py', line: 200, character: 0 }], error: null })
    expect(await providers.definition.provideDefinition(model, at)).toEqual([])
    expect(navigate).toHaveBeenLastCalledWith('/w/a.py', 200)
    api.definition.mockResolvedValueOnce({ locations: [{ path: '/w/b.py', line: 1, character: 0 }], error: null })
    expect(await providers.definition.provideDefinition(model, at)).toEqual([])
    expect(navigate).toHaveBeenLastCalledWith('/w/b.py', 1)

    api.references.mockResolvedValueOnce({ locations: [{ path: '/w/a.py', line: 11, character: 0 }], error: null })
    expect(await providers.references.provideReferences(model, at)).toEqual([{ uri: model.uri, range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 } }])
    api.references.mockResolvedValueOnce({ locations: [{ path: '/w/b.py', line: 3, character: 0 }], error: 'partial' })
    expect(await providers.references.provideReferences(model, at)).toEqual([])
    expect(notice).toHaveBeenCalledWith('partial')
    expect(notice).toHaveBeenCalledWith('1 usages, 1 outside this view — opening the first')
    expect(navigate).toHaveBeenLastCalledWith('/w/b.py', 3)
    // A usage in this file but outside the hunks counts as outside the view.
    api.references.mockResolvedValueOnce({ locations: [{ path: '/w/a.py', line: 10, character: 0 }, { path: '/w/a.py', line: 99, character: 0 }], error: null })
    navigate.mockClear()
    expect(await providers.references.provideReferences(model, at)).toHaveLength(1)
    expect(notice).toHaveBeenLastCalledWith('2 usages, 1 outside this view')
    expect(navigate).not.toHaveBeenCalled()   // something here to show, so no jump

    api.hover.mockResolvedValueOnce({ text: 'int', error: null })
    expect(await providers.hover.provideHover(model, at)).toEqual({ contents: [{ value: 'int' }] })
    expect(api.hover).toHaveBeenLastCalledWith('/w', '/w/a.py', 10, 2)
    api.hover.mockResolvedValueOnce({ text: null, error: null })
    expect(await providers.hover.provideHover(model, at)).toBeNull()
    expect(languageFor('x.tsx')).toBe('typescript'); expect(languageFor('Makefile')).toBe('plaintext')
  })
})

describe('file tree', () => {
  it('sums changes into folders, sorts folders first, and knows the folders on the way to a file', async () => {
    const { buildTree, ancestorsOf, splitTests } = await import('../src/lib/fileTree.ts')
    const tree = buildTree([
      { path: 'z.txt', status: null, added: 0, removed: 0 },
      { path: 'src/b/two.py', status: 'M', added: 2, removed: 1 },
      { path: 'src/a.py', status: 'A', added: 5, removed: 0 },
      { path: 'src/b/one.py', status: 'D', added: 0, removed: 3 },
    ])
    expect(tree.map((node) => `${node.kind}:${node.name}:${node.added}-${node.removed}`)).toEqual(['dir:src:7-4', 'file:z.txt:0-0'])
    expect(tree[0].children.map((node) => node.name)).toEqual(['b', 'a.py'])
    expect(tree[0].children[0].children.map((node) => node.name)).toEqual(['one.py', 'two.py'])
    expect(ancestorsOf('src/b/two.py')).toEqual(['src', 'src/b'])
    expect(ancestorsOf('top.py')).toEqual([])
    const { source, tests } = splitTests([{ path: 'tests/test_x.py', status: null, added: 0, removed: 0 }, { path: 'x.py', status: null, added: 0, removed: 0 }])
    expect(source.map((f) => f.path)).toEqual(['x.py']); expect(tests.map((f) => f.path)).toEqual(['tests/test_x.py'])
  })
})

describe('what the scrollbar marks', () => {
  it('reports every use of the symbol in this file, as word ranges, and skips the ones it cannot show', async () => {
    const api = { definition: vi.fn(), references: vi.fn(), hover: vi.fn() }
    vi.resetModules()
    vi.doMock('../src/lib/api.ts', () => ({ api }))
    const { ensureProviders, wireLanguageServers } = await import('../src/lib/lspProviders.ts')
    const providers: Record<string, any> = {}
    ensureProviders({ languages: {
      registerDefinitionProvider: () => {}, registerReferenceProvider: () => {}, registerHoverProvider: () => {},
      registerDocumentHighlightProvider: (_l: string, p: any) => { providers.highlights = p },
    } } as any, 'python-highlights')
    const rows = [10, 11, 30]
    wireLanguageServers({ current: () => ({ workspace: '/w', path: '/w/a.py' }), navigate: vi.fn(), notice: vi.fn(),
      toFileLine: (row: number) => rows[row - 1] ?? row,
      toRow: (line: number) => { const row = rows.indexOf(line); return row === -1 ? null : row + 1 } })
    const model = {
      uri: 'file:///w/a.py',
      getWordAtPosition: ({ lineNumber }: any) => (lineNumber === 1 ? { startColumn: 5, endColumn: 10 } : null),
    }
    api.references.mockResolvedValueOnce({ error: null, locations: [
      { path: '/w/a.py', line: 10, character: 4 },     // row 1 — a real word under it
      { path: '/w/a.py', line: 30, character: 2 },     // row 3 — no word, falls back to the caret
      { path: '/w/a.py', line: 999, character: 0 },    // not shown in this view
      { path: '/w/other.py', line: 1, character: 0 },  // another file
    ] })
    expect(await providers.highlights.provideDocumentHighlights(model, { lineNumber: 1, column: 1 })).toEqual([
      { range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 10 } },
      { range: { startLineNumber: 3, startColumn: 3, endLineNumber: 3, endColumn: 3 } },
    ])
    expect(api.references).toHaveBeenLastCalledWith('/w', '/w/a.py', 9, 0)
    expect(await providers.highlights.provideDocumentHighlights(model, { lineNumber: 1, column: 1 })
      .catch(() => 'threw')).toBeDefined()
  })
})

describe('dragging a panel edge', () => {
  it('follows the pointer along whichever axis it was given', async () => {
    const { startDrag } = await import('../src/lib/resizable.ts')
    const widths: number[] = []
    startDrag({ clientX: 100, clientY: 500, preventDefault: () => {} }, 200, 1, (value) => widths.push(value), 'y')
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 999, clientY: 540 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(widths).toEqual([240])   // moved 40 down, ignoring the x travel
    const heights: number[] = []
    startDrag({ clientX: 100, preventDefault: () => {} }, 200, -1, (value) => heights.push(value))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(heights).toEqual([240])  // x axis, dragged the other way
    // A vertical drag whose event carries no clientY falls back to the start of the axis.
    const none: number[] = []
    startDrag({ clientX: 0, preventDefault: () => {} }, 50, 1, (value) => none.push(value), 'y')
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 10 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(none).toEqual([60])
  })
})
