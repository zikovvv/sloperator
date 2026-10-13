// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyAppearance, channelsOf, DEFAULT_APPEARANCE, FONTS, THEMES } from '../src/lib/theme.ts'

const varsOf = (root: HTMLElement) => ({
  bg: root.style.getPropertyValue('--ink-950'),
  border: root.style.getPropertyValue('--ink-800'),
  accent: root.style.getPropertyValue('--accent'),
  font: root.style.getPropertyValue('--ui-font'),
  size: root.style.getPropertyValue('--ui-font-size'),
})

describe('channelsOf', () => {
  it('reads a hex colour with or without the hash, and refuses anything half-typed', () => {
    expect(channelsOf('#d98c4a')).toBe('217 140 74')
    expect(channelsOf('D98C4A')).toBe('217 140 74')
    expect(channelsOf('#000000')).toBe('0 0 0')
    for (const bad of ['', '#fff', '#12345', 'rgb(1,2,3)', '#gggggg', '#1234567']) {
      expect(channelsOf(bad)).toBeNull()
    }
  })
})

describe('applyAppearance', () => {
  it('paints the chosen theme onto the document', () => {
    const root = document.createElement('div')
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'cold' }, root)
    expect(varsOf(root).bg).toBe(THEMES.cold.ink['950'])
    expect(varsOf(root).accent).toBe(THEMES.cold.accent)
    expect(varsOf(root).font).toBe(FONTS.system.stack)
  })

  it('lets custom colours win over the theme, and ignores an unparseable one', () => {
    const root = document.createElement('div')
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'warm', accent: '#ffffff', border: '#010203', background: '#ff0000' }, root)
    expect(varsOf(root).accent).toBe('255 255 255')
    expect(varsOf(root).border).toBe('1 2 3')
    expect(varsOf(root).bg).toBe('255 0 0')
    // A colour still being typed leaves the theme's own value in place rather than blanking it.
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'warm', border: '#12' }, root)
    expect(varsOf(root).border).toBe(THEMES.warm.ink['800'])
    expect(varsOf(root).accent).toBe(THEMES.warm.accent)
  })

  it('keeps the text size sane and falls back when the theme or font is unknown', () => {
    const root = document.createElement('div')
    applyAppearance({ ...DEFAULT_APPEARANCE, fontSize: 400 }, root)
    expect(varsOf(root).size).toBe('20px')
    applyAppearance({ ...DEFAULT_APPEARANCE, fontSize: 1 }, root)
    expect(varsOf(root).size).toBe('10px')
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'nope' as any, font: 'nope' as any }, root)
    expect(varsOf(root).bg).toBe(THEMES.warm.ink['950'])
    expect(varsOf(root).font).toBe(FONTS.system.stack)
  })
})
