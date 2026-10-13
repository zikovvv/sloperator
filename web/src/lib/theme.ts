/**
 * The palette lives in CSS variables so it can change without a rebuild. Every value is
 * space-separated RGB channels, because Tailwind needs `rgb(var(--x) / <alpha-value>)` for the
 * `/80`-style opacities used all over the styles.
 */
export type ThemeName = 'warm' | 'cold' | 'neutral'
export type FontName = 'system' | 'mono' | 'serif'

export interface Appearance {
  theme: ThemeName
  /** Overrides on top of the theme; empty means "whatever the theme says". */
  accent: string
  border: string
  background: string
  font: FontName
  fontSize: number
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'warm', accent: '', border: '', background: '', font: 'system', fontSize: 13,
}

type Shades = Record<string, string>

/** 950 is the page, 100 is the brightest text; the steps between are backgrounds and borders. */
export const THEMES: Record<ThemeName, { label: string; ink: Shades; accent: string }> = {
  warm: {
    label: 'Warm dark',
    ink: {
      950: '20 17 14', 900: '27 23 20', 850: '34 29 25', 800: '42 36 31', 700: '54 46 40',
      600: '69 59 51', 500: '93 81 71', 400: '133 120 104', 300: '176 164 149',
      200: '216 206 194', 100: '240 234 225',
    },
    accent: '217 140 74',
  },
  cold: {
    label: 'Cold dark',
    ink: {
      950: '11 13 18', 900: '17 20 27', 850: '22 26 35', 800: '28 32 41', 700: '37 42 53',
      600: '51 57 71', 500: '74 81 99', 400: '107 114 134', 300: '154 161 179',
      200: '196 201 214', 100: '230 233 240',
    },
    accent: '91 140 255',
  },
  neutral: {
    label: 'Neutral grey',
    ink: {
      950: '14 14 15', 900: '21 21 23', 850: '26 26 29', 800: '33 33 36', 700: '43 43 47',
      600: '58 58 63', 500: '82 82 90', 400: '116 116 126', 300: '161 161 170',
      200: '202 202 210', 100: '237 237 240',
    },
    accent: '155 140 255',
  },
}

export const FONTS: Record<FontName, { label: string; stack: string }> = {
  system: { label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" },
  mono: { label: 'Monospace', stack: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace" },
  serif: { label: 'Serif', stack: "'New York', 'Iowan Old Style', Georgia, serif" },
}

/** "#d98c4a" -> "217 140 74"; anything unparseable is ignored so a half-typed value cannot blank the UI. */
export function channelsOf(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`
}

/** Writes the palette onto the document. Called whenever the appearance changes. */
export function applyAppearance(appearance: Appearance, root: HTMLElement) {
  const theme = THEMES[appearance.theme] ?? THEMES.warm
  for (const [shade, channels] of Object.entries(theme.ink)) {
    root.style.setProperty(`--ink-${shade}`, channels)
  }
  root.style.setProperty('--accent', channelsOf(appearance.accent) ?? theme.accent)
  // Borders are ink-800 everywhere; the background is the page beneath everything.
  const border = channelsOf(appearance.border)
  if (border) root.style.setProperty('--ink-800', border)
  const background = channelsOf(appearance.background)
  if (background) root.style.setProperty('--ink-950', background)
  root.style.setProperty('--ui-font', (FONTS[appearance.font] ?? FONTS.system).stack)
  root.style.setProperty('--ui-font-size', `${Math.min(20, Math.max(10, appearance.fontSize))}px`)
}
