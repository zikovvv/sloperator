import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isWatching, notify, setAttention } from '../server/notify.ts'

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).orchestratorNotify
  setAttention(null, false)
})

describe('isWatching', () => {
  it('is true only for the focused window on that very session', () => {
    setAttention('a', true)
    expect(isWatching('a')).toBe(true)
    expect(isWatching('b')).toBe(false)
    setAttention('a', false)
    expect(isWatching('a')).toBe(false)
  })
})

describe('notify', () => {
  it('goes to the shell and to the page', () => {
    const shell = vi.fn()
    ;(globalThis as Record<string, unknown>).orchestratorNotify = shell
    const broadcast = vi.fn()
    notify({ title: 'done', body: 'a turn finished', sound: 'Glass' }, broadcast)
    expect(shell).toHaveBeenCalledWith(expect.objectContaining({ title: 'done', sound: 'Glass' }))
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('still reaches the page when no shell is installed (dev browser)', () => {
    const broadcast = vi.fn()
    notify({ title: 'done', body: 'x' }, broadcast)
    expect(broadcast).toHaveBeenCalledOnce()
  })
})
