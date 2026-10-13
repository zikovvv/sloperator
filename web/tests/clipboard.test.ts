// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/lib/clipboard.ts'

afterEach(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) })

describe('copyText', () => {
  it('says whether the text went to the clipboard', async () => {
    expect(await copyText('a')).toBe(false)   // no clipboard on this page
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    expect(await copyText('b')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('b')
    writeText.mockRejectedValueOnce(new Error('denied'))
    expect(await copyText('c')).toBe(false)
  })
})
