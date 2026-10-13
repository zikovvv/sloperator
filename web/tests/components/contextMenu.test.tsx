// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from '../../src/components/ContextMenu.tsx'

afterEach(cleanup)

describe('ContextMenu', () => {
  it('runs a pick and closes; closes on Escape or a click elsewhere, not on a click inside', () => {
    const run = vi.fn(); const onClose = vi.fn()
    render(<ContextMenu x={10} y={20} items={[{ label: 'Copy', run }, { label: 'Quote', run: vi.fn() }]} onClose={onClose} />)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('10px'); expect(menu.style.top).toBe('20px')
    fireEvent.mouseDown(menu)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(run).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'a' }); expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' }); expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(document.body); expect(onClose).toHaveBeenCalledTimes(3)
  })
  it('stays on screen near the edges', () => {
    render(<ContextMenu x={5000} y={5000} items={[{ label: 'One', run: vi.fn() }]} onClose={vi.fn()} />)
    const menu = screen.getByRole('menu')
    expect(parseInt(menu.style.left, 10)).toBeLessThanOrEqual(window.innerWidth - 200)
    expect(parseInt(menu.style.top, 10)).toBeLessThanOrEqual(window.innerHeight - 46)
  })
})
