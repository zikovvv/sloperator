// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); localStorage.clear(); document.documentElement.removeAttribute('style') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const open = async () => {
  vi.doMock('../../src/lib/api.ts', () => ({ api: {
    settings: async () => ({ worktreeRoot: null, linearWorkspace: null, codexPricing: { input: 1, cached: 0.1, output: 2 }, claudePricing: {} }),
    saveSettings: vi.fn(async () => ({ ok: true })),
  } }))
  const { SettingsDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
  render(<SettingsDialog onClose={() => {}} />)
  await waitFor(() => expect(screen.getByRole('group', { name: 'Colour scheme' })).toBeTruthy())
}
const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name)

describe('appearance settings', () => {
  it('paints the chosen scheme onto the page at once and remembers it', async () => {
    const { THEMES } = await import('../../src/lib/theme.ts')
    await open()
    await waitFor(() => expect(cssVar('--ink-950')).toBe(THEMES.warm.ink['950']))   // warm by default
    fireEvent.click(screen.getByRole('button', { name: 'Cold dark' }))
    await waitFor(() => expect(cssVar('--ink-950')).toBe(THEMES.cold.ink['950']))
    expect(cssVar('--accent')).toBe(THEMES.cold.accent)
    fireEvent.click(screen.getByRole('button', { name: 'Neutral grey' }))
    await waitFor(() => expect(cssVar('--accent')).toBe(THEMES.neutral.accent))
    expect(JSON.parse(localStorage.getItem('orchestrator.appearance')!).theme).toBe('neutral')
  })

  it('takes a custom accent, border and background, and gives them back on Reset', async () => {
    const { THEMES } = await import('../../src/lib/theme.ts')
    await open()
    fireEvent.change(screen.getByLabelText('Accent'), { target: { value: '#ffffff' } })
    await waitFor(() => expect(cssVar('--accent')).toBe('255 255 255'))
    fireEvent.change(screen.getByLabelText('Borders'), { target: { value: '#010203' } })
    await waitFor(() => expect(cssVar('--ink-800')).toBe('1 2 3'))
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#ff0000' } })
    await waitFor(() => expect(cssVar('--ink-950')).toBe('255 0 0'))
    // Each override offers its own reset; clearing one puts the theme's value back.
    const resets = screen.getAllByRole('button', { name: 'Reset' })
    expect(resets).toHaveLength(3)
    fireEvent.click(resets[0])
    await waitFor(() => expect(cssVar('--accent')).toBe(THEMES.warm.accent))
  })

  it('changes the font and the text size', async () => {
    const { FONTS } = await import('../../src/lib/theme.ts')
    await open()
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'mono' } })
    await waitFor(() => expect(cssVar('--ui-font')).toBe(FONTS.mono.stack))
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '16' } })
    await waitFor(() => expect(cssVar('--ui-font-size')).toBe('16px'))
    expect(screen.getByText(/16px/)).toBeTruthy()
  })
})

describe('an appearance stored by an older build', () => {
  it('falls back to the warm theme when the stored name means nothing', async () => {
    const { THEMES } = await import('../../src/lib/theme.ts')
    localStorage.setItem('orchestrator.appearance', JSON.stringify({ theme: 'midnight', accent: '', border: '', background: '', font: 'system', fontSize: 13 }))
    await open()
    await waitFor(() => expect(cssVar('--ink-950')).toBe(THEMES.warm.ink['950']))
    // The pickers show the fallback theme's colours rather than blanks.
    expect((screen.getByLabelText('Accent') as HTMLInputElement).value).toBe('#d98c4a')
  })
})

describe('the rest of the settings', () => {
  it('writes a changed setting after a pause, and copes with a settings file that has no pricing yet', async () => {
    const saveSettings = vi.fn(async () => ({ ok: true }))
    vi.doMock('../../src/lib/api.ts', () => ({ api: {
      settings: async () => ({ worktreeRoot: null, linearWorkspace: null, codexPricing: { input: 1, cached: 0.1, output: 2 } }),
      saveSettings,
    } }))
    const { SettingsDialog } = await import('../../src/components/NewWorktreeDialog.tsx')
    render(<SettingsDialog onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Linear workspace')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Linear workspace'), { target: { value: 'acme-co' } })
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ linearWorkspace: 'acme-co' })), { timeout: 3000 })
  })
})
