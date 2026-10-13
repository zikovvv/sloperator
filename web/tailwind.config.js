export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // One palette, used everywhere — the native app's ad-hoc greys are why it looked cheap.
        // Channels, not hex: the palette is swapped at runtime from settings, and Tailwind needs
        // rgb(var(--x) / <alpha-value>) for the /80-style opacities used throughout.
        ink: Object.fromEntries([950, 900, 850, 800, 700, 600, 500, 400, 300, 200, 100]
          .map((shade) => [shade, `rgb(var(--ink-${shade}) / <alpha-value>)`])),
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          soft: 'rgb(var(--accent) / 0.13)',
          strong: 'rgb(var(--accent) / 0.85)',
        },
        ok: '#3fb950', warn: '#d29922', bad: '#f85149',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
