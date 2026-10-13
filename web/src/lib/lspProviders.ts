import type { Monaco } from '@monaco-editor/react'
import { api } from './api.ts'

export interface Location { path: string; line: number; character: number }

interface Wiring {
  /** The file the editor shows right now; providers outlive components, so they read through this. */
  current: () => { workspace: string; path: string }
  /** A diff shows only the hunks, renumbered from 1: these map its rows to real lines and back. */
  toFileLine: (row: number) => number
  toRow: (line: number) => number | null
  /** Somewhere outside the open model: the caller shows that file instead. */
  navigate: (path: string, line: number) => void
  /** Many usages, or a server that could not answer: one line for the user. */
  notice: (text: string) => void
}

const registered = new Set<string>()
let wiring: Wiring | null = null

/** Every editor shares one set of providers per language; the wiring says which file is open. */
export function wireLanguageServers(next: Wiring) { wiring = next }

const inModel = (location: Location, path: string) => location.path === path

/**
 * Definition (F12, ⌘-click), references (⇧F12) and hover, answered by the project's own language
 * server. Monaco can only jump inside the open model, so a target elsewhere is navigated to.
 */
export function ensureProviders(monaco: Monaco, language: string) {
  if (registered.has(language)) return
  registered.add(language)
  const position = (line: number, character: number) => ({
    startLineNumber: line, startColumn: character + 1, endLineNumber: line, endColumn: character + 1,
  })

  monaco.languages.registerDefinitionProvider(language, {
    provideDefinition: async (model, at) => {
      if (!wiring) return []
      const { workspace, path } = wiring.current()
      const result = await api.definition(workspace, path, wiring.toFileLine(at.lineNumber) - 1, at.column - 1)
      if (result.error) wiring.notice(result.error)
      const target = result.locations[0]
      if (!target) return []
      const row = inModel(target, path) ? wiring.toRow(target.line) : null
      // Outside this file, or in a line the diff does not show: open the file at that line instead.
      if (row === null) { wiring.navigate(target.path, target.line); return [] }
      return [{ uri: model.uri, range: position(row, target.character) }]
    },
  })
  monaco.languages.registerReferenceProvider(language, {
    provideReferences: async (model, at) => {
      if (!wiring) return []
      const { workspace, path } = wiring.current()
      const result = await api.references(workspace, path, wiring.toFileLine(at.lineNumber) - 1, at.column - 1)
      if (result.error) wiring.notice(result.error)
      const shown = result.locations.filter((location) => inModel(location, path) && wiring!.toRow(location.line) !== null)
      const elsewhere = result.locations.filter((location) => !shown.includes(location))
      if (elsewhere.length) {
        // Only when nothing here can be shown does the first of the others open.
        wiring.notice(`${result.locations.length} usages, ${elsewhere.length} outside this view${shown.length ? '' : ' — opening the first'}`)
        if (!shown.length) wiring.navigate(elsewhere[0].path, elsewhere[0].line)
      }
      return shown.map((location) => ({ uri: model.uri, range: position(wiring!.toRow(location.line)!, location.character) }))
    },
  })
  // What Monaco paints down the scrollbar and inline: every other place this symbol is used.
  monaco.languages.registerDocumentHighlightProvider(language, {
    provideDocumentHighlights: async (model, at) => {
      if (!wiring) return []
      const { workspace, path } = wiring.current()
      const result = await api.references(workspace, path, wiring.toFileLine(at.lineNumber) - 1, at.column - 1)
      const here: Array<{ range: ReturnType<typeof position> }> = []
      for (const location of result.locations) {
        if (!inModel(location, path)) continue
        const row = wiring.toRow(location.line)
        if (row === null) continue
        const word = model.getWordAtPosition({ lineNumber: row, column: location.character + 1 })
        here.push({ range: word
          ? { startLineNumber: row, startColumn: word.startColumn, endLineNumber: row, endColumn: word.endColumn }
          : position(row, location.character) })
      }
      return here
    },
  })
  monaco.languages.registerHoverProvider(language, {
    provideHover: async (_model, at) => {
      if (!wiring) return null
      const { workspace, path } = wiring.current()
      const result = await api.hover(workspace, path, wiring.toFileLine(at.lineNumber) - 1, at.column - 1)
      return result.text ? { contents: [{ value: result.text }] } : null
    },
  })
}

export function languageFor(path: string): string {
  const extension = path.split('.').pop()!.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python',
    swift: 'swift', go: 'go', rs: 'rust', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', css: 'css', html: 'html', sql: 'sql', toml: 'ini', rb: 'ruby',
  }
  return map[extension] ?? 'plaintext'
}

/** What the editors accept, spelled out once: the same three moves an IDE user already knows. */
export const NAVIGATION_HINT = 'F12 definition · ⇧F12 usages · ⌘-click · right-click for more'
