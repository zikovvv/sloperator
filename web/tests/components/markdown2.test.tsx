// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('markdown the agents actually write', () => {
  it('task lists, nested bullets, strikethrough, bare links, and images inline or alone', async () => {
    vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null }))
    const { Markdown, parseBlocks } = await import('../../src/components/Markdown.tsx')
    const blocks = parseBlocks('- [x] done\n- [ ] later\n  - deeper\n- plain\n\n![alone](shots/a.png)\n\n| not a table')
    expect(blocks[0]).toEqual({ kind: 'bullets', items: [
      { text: 'done', depth: 0, task: true }, { text: 'later', depth: 0, task: false }, { text: 'deeper', depth: 1, task: null }, { text: 'plain', depth: 0, task: null },
    ] })
    expect(blocks[1]).toEqual({ kind: 'image', alt: 'alone', src: 'shots/a.png' })
    const resolve = (src: string) => `/raw?p=${src}`
    render(<Markdown text={'~~old~~ see https://example.com/x now ![pic](shots/b.png) and ![web](https://img.example.com/c.png)\n\n![alone](shots/a.png)\n\n![lost](nowhere.png)'} resolveImage={resolve} />)
    expect(screen.getByText('old').tagName).toBe('DEL')
    expect((screen.getByText('https://example.com/x') as HTMLAnchorElement).href).toBe('https://example.com/x')
    expect((screen.getByAltText('pic') as HTMLImageElement).src).toContain('/raw?p=shots/b.png')
    // A picture on the web is not fetched by merely rendering the message: it waits for a click.
    expect(screen.queryByAltText('web')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /web · load from img\.example\.com/ }))
    expect((screen.getByAltText('web') as HTMLImageElement).src).toBe('https://img.example.com/c.png')
    expect((screen.getByAltText('alone') as HTMLImageElement).src).toContain('/raw?p=shots/a.png')
    cleanup()
    render(<Markdown text={'![noresolver](x.png) and ![](y.png)\n\n![](z.png)'} />)   // nothing can load these: named instead
    expect(screen.getByText(/🖼 noresolver/)).toBeTruthy()
    expect(screen.getByText(/🖼 y\.png/)).toBeTruthy()
    expect(screen.getByText(/🖼 z\.png/)).toBeTruthy()
    cleanup()
    render(<Markdown text={'# one\n## two\n### three\n- top\n  - nested\n\n![web alone](https://img.example.com/d.png)'} />)
    expect(screen.getByText('one').className).toContain('text-[16px]')
    expect(screen.getByText('two').className).toContain('text-[14px]')
    expect(screen.getByText('three').className).toContain('text-[13px]')
    expect(screen.getByText('◦')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /web alone · load from/ }))
    expect((screen.getByAltText('web alone') as HTMLImageElement).src).toBe('https://img.example.com/d.png')
    cleanup()
    render(<Markdown text={'- [x] finished\n- [ ] open'} />)
    expect((screen.getByLabelText('done') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('to do') as HTMLInputElement).checked).toBe(false)
  })

  it('code blocks come back coloured once the tokenizer answers, and copy says so for a moment', async () => {
    vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async (text: string, tag: string | null) => (tag === 'sh' ? `<span class="tok">${text}</span>` : null) }))
    const write = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    const { Markdown } = await import('../../src/components/Markdown.tsx')
    render(<Markdown text={'```sh\nls -la\n```\n\n```\nplain\n```'} />)
    await waitFor(() => expect(document.querySelector('code[data-highlighted] .tok')?.textContent).toBe('ls -la'))
    expect(screen.getByText('plain').closest('code')?.hasAttribute('data-highlighted')).toBe(false)
    vi.useFakeTimers()
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[0])
    await act(async () => { await Promise.resolve() })
    expect(write).toHaveBeenCalledWith('ls -la')
    expect(screen.getAllByRole('button', { name: 'Copy code' })[0].textContent).toBe('✓')
    act(() => { vi.advanceTimersByTime(1300) })
    expect(screen.getAllByRole('button', { name: 'Copy code' })[0].textContent).toBe('⧉')
    write.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[0])
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByRole('button', { name: 'Copy code' })[0].textContent).toBe('⧉')   // refused: nothing to say
  })
})

describe('a picture whose URL does not parse', () => {
  it('is named, not loaded, and never takes the page down', async () => {
    vi.doMock('../../src/lib/highlight.ts', () => ({ highlight: async () => null }))
    const { Markdown } = await import('../../src/components/Markdown.tsx')
    render(<Markdown text={'![diagram](https://)\n\nsee ![shot](http://) here'} resolveImage={(src) => `/raw?p=${src}`} />)
    expect(screen.getByText(/🖼 diagram/)).toBeTruthy()
    expect(screen.getByText(/🖼 shot/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /load from/ })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    cleanup()
    render(<Markdown text={'![](https://img.example.com/e.png)'} resolveImage={(src) => `/raw?p=${src}`} />)
    expect(screen.getByRole('button', { name: /image · load from img\.example\.com/ })).toBeTruthy()   // no alt: it is called "image"
  })
})
