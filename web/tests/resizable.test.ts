// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDrag, useStoredFlag, useStoredNumber } from '../src/lib/resizable.ts'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('stored panel sizes', () => {
  it('starts at the default, clamps, remembers, and survives a storage that throws', () => {
    const { result } = renderHook(() => useStoredNumber('w', 240, 160, 520))
    expect(result.current[0]).toBe(240)
    act(() => result.current[1](9000)); expect(result.current[0]).toBe(520)
    act(() => result.current[1](10)); expect(result.current[0]).toBe(160)
    act(() => result.current[1](300))
    expect(localStorage.getItem('w')).toBe('300')
    const again = renderHook(() => useStoredNumber('w', 240, 160, 520))
    expect(again.result.current[0]).toBe(300)
    localStorage.setItem('w', 'garbage')
    expect(renderHook(() => useStoredNumber('w', 240, 160, 520)).result.current[0]).toBe(240)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const blocked = renderHook(() => useStoredNumber('w', 240, 160, 520))
    expect(blocked.result.current[0]).toBe(240)
    act(() => blocked.result.current[1](333)); expect(blocked.result.current[0]).toBe(333)
  })

  it('remembers a flag as 1/0', () => {
    const { result } = renderHook(() => useStoredFlag('c', false))
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(localStorage.getItem('c')).toBe('1')
    expect(renderHook(() => useStoredFlag('c', false)).result.current[0]).toBe(true)
    localStorage.setItem('c', '0')
    const back = renderHook(() => useStoredFlag('c', true))
    expect(back.result.current[0]).toBe(false)
    // Sets like React's own setter, so a toggle needs no stale copy of the value.
    act(() => back.result.current[1]((current) => !current))
    expect(back.result.current[0]).toBe(true)
    expect(localStorage.getItem('c')).toBe('1')
  })
})

describe('startDrag', () => {
  it('applies the width for each pointer move, in the panel’s own direction, and cleans up on release', () => {
    const apply = vi.fn()
    const event = { clientX: 100, preventDefault: vi.fn() }
    startDrag(event, 240, 1, apply)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('col-resize')
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 }))
    expect(apply).toHaveBeenLastCalledWith(270)
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(document.body.style.cursor).toBe('')
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }))
    expect(apply).toHaveBeenCalledTimes(1)
    // A right-hand panel grows as the pointer moves left.
    startDrag({ clientX: 500, preventDefault: vi.fn() }, 560, -1, apply)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 450 }))
    expect(apply).toHaveBeenLastCalledWith(610)
    window.dispatchEvent(new MouseEvent('mouseup'))
  })
})
