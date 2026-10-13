const ALIASES: Record<string, string> = {
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellscript: 'shell',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', yml: 'yaml', md: 'markdown', kt: 'kotlin', cs: 'csharp',
  'c++': 'cpp', h: 'c', hpp: 'cpp', ps1: 'powershell', dockerfile: 'dockerfile', txt: 'plaintext',
}

/** The Monaco language id a fence tag or extension maps to; unknown tags stay as they are. */
export function languageOf(tag: string | null | undefined): string | null {
  if (!tag) return null
  return ALIASES[tag.toLowerCase()] ?? tag.toLowerCase()
}

type Colorizer = { colorize: (text: string, language: string) => Promise<string>; knows: (language: string) => boolean }
let loader: Promise<Colorizer | null> | null = null

/** Monaco is heavy and already bundled for the review panel; it is only loaded once a block needs it. */
function colorizer(): Promise<Colorizer | null> {
  loader ??= import('./monaco.ts')
    .then(({ monaco }) => ({
      colorize: (text: string, language: string) => monaco.editor.colorize(text, language, { tabSize: 2 }),
      knows: (language: string) => monaco.languages.getLanguages().some((entry) => entry.id === language),
    }))
    .catch(() => null)
  return loader
}

/** Tokenised HTML for a code block, or null when nothing can colour it: the text then stands as is. */
export async function highlight(text: string, tag: string | null | undefined): Promise<string | null> {
  const language = languageOf(tag)
  if (!language || language === 'plaintext') return null
  const engine = await colorizer()
  if (!engine || !engine.knows(language)) return null
  try { return await engine.colorize(text, language) } catch { return null }
}
