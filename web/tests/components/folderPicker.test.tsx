// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tree: Record<string, any> = {
  '/home': { path: '/home', parent: '/', isGit: false, more: 0, folders: [{ name: 'Projects', path: '/home/Projects', isGit: false }, { name: 'thing', path: '/home/thing', isGit: true }] },
  '/home/Projects': { path: '/home/Projects', parent: '/home', isGit: false, more: 12, folders: [] },
  '/home/thing': { path: '/home/thing', parent: '/home', isGit: true, more: 0, folders: [] },
  '/': { path: '/', parent: null, isGit: false, more: 0, folders: [{ name: 'home', path: '/home', isGit: false }] },
}
let folders: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  folders = vi.fn(async (path?: string) => { const hit = tree[path ?? '/home']; if (!hit) throw new Error('That folder cannot be read'); return hit })
  vi.doMock('../../src/lib/api.ts', () => ({ api: { folders } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const mount = async () => {
  const { FolderPicker } = await import('../../src/components/FolderPicker.tsx')
  const onPick = vi.fn(); const onCancel = vi.fn()
  render(<FolderPicker title="Add project" onPick={onPick} onCancel={onCancel} />)
  await waitFor(() => expect((screen.getByLabelText('Folder path') as HTMLInputElement).value).toBe('/home'))
  return { onPick, onCancel }
}
const options = () => screen.queryAllByRole('option').map((option) => option.textContent)

describe('FolderPicker', () => {
  it('starts at home, enters a folder on a click, goes up, and marks git repositories', async () => {
    const { onPick } = await mount()
    expect(folders).toHaveBeenCalledWith(undefined)
    expect(options()).toEqual(['▸Projects', '▸thinggit'])
    expect(screen.getByText(/Not a git repository: adding it creates one/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add and create a repository' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /thing/ }))
    await waitFor(() => expect(screen.getByText('A git repository.')).toBeTruthy())
    expect(screen.getByText('No folders inside.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add this folder' }))
    expect(onPick).toHaveBeenCalledWith('/home/thing')
    fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
    await waitFor(() => expect(options()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
    await waitFor(() => expect(options()).toEqual(['▸home']))
    expect((screen.getByRole('button', { name: 'Parent folder' }) as HTMLButtonElement).disabled).toBe(true)   // nothing above the root
  })

  it('takes a typed path: Enter goes there, a bad one is reported, and it can be added as typed', async () => {
    const { onPick, onCancel } = await mount()
    const input = screen.getByLabelText('Folder path')
    fireEvent.change(input, { target: { value: ' /home/Projects ' } })
    expect(screen.getByRole('button', { name: 'Add this folder' })).toBeTruthy()   // not yet known to be a repository or not
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(folders).toHaveBeenLastCalledWith('/home/Projects'))
    await waitFor(() => expect(screen.getByText('12 more not shown: type the path above to go straight there.')).toBeTruthy())
    fireEvent.change(input, { target: { value: '/nowhere' } })
    fireEvent.keyDown(input, { key: 'a' })   // only Enter navigates
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('That folder cannot be read')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add this folder' }))
    expect(onPick).toHaveBeenCalledWith('/nowhere')   // the server says what is wrong with it
    fireEvent.change(input, { target: { value: '  ' } })
    expect((screen.getByRole('button', { name: 'Add this folder' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog'))   // the backdrop cancels too
    expect(onCancel).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByText('Add project'))   // inside the box: nothing
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('never lets a listing replace a path typed while it was on its way, and drops answers that arrive late', async () => {
    const answers: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = []
    folders.mockImplementation(() => new Promise((resolve, reject) => { answers.push({ resolve, reject }) }))
    const { FolderPicker } = await import('../../src/components/FolderPicker.tsx')
    const onPick = vi.fn()
    render(<FolderPicker title="Add project" onPick={onPick} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('Folder path') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/typed/first' } })   // typed before home answered
    await act(async () => { answers[0].resolve(tree['/home']) })
    expect(input.value).toBe('/typed/first')
    fireEvent.click(screen.getByRole('button', { name: 'Add this folder' }))
    expect(onPick).toHaveBeenCalledWith('/typed/first')
    // Two navigations: the first one's answer and failure both arrive after the second was asked for.
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { answers[1].reject(new Error('stale failure')) })
    expect(screen.queryByText('stale failure')).toBeNull()
    await act(async () => { answers[2].resolve(tree['/home/thing']) })
    expect(input.value).toBe('/home/thing')
  })
})
