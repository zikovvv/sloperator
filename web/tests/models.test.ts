import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_CATALOG, strongestOf } from '../shared/models.ts'
import { codexHome, modelCatalog } from '../server/models.ts'
import { startHarness } from './helpers/server.ts'

const catalogFile = (fetchedAt: number, models: unknown[]) => JSON.stringify({ version: 2, fetchedAt, catalog: { config: { models } } })
const env = { claude: process.env.ORCHESTRATOR_CLAUDE_HOME, codex: process.env.ORCHESTRATOR_CODEX_HOME }
afterEach(() => { process.env.ORCHESTRATOR_CLAUDE_HOME = env.claude; process.env.ORCHESTRATOR_CODEX_HOME = env.codex })

describe('the models each engine offers', () => {
  it('reads Claude Code\'s newest cached catalog: main models featured, overflow ones not, names as given', () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-claude-home-'))
    mkdirSync(join(home, 'cache', 'model-catalog'), { recursive: true })
    writeFileSync(join(home, 'cache', 'model-catalog', 'old.json'), catalogFile(1, [{ id: 'claude-old-1', name: 'Old 1', section: 'main' }]))
    writeFileSync(join(home, 'cache', 'model-catalog', 'new.json'), catalogFile(2, [
      { id: 'claude-opus-9', name: 'Opus 9', section: 'main' }, { id: 'claude-fable-9', name: 'Fable 9', section: 'main' },
      { id: 'claude-opus-8', name: 'Opus 8', section: 'overflow' }, { id: 7, name: 'not a model' }, { id: 'claude-bare' },
    ]))
    writeFileSync(join(home, 'cache', 'model-catalog', 'broken.json'), '{not json')
    writeFileSync(join(home, 'cache', 'model-catalog', 'other-shape.json'), JSON.stringify({ fetchedAt: 99, catalog: {} }))
    writeFileSync(join(home, 'cache', 'model-catalog', 'notes.txt'), 'ignored')
    process.env.ORCHESTRATOR_CLAUDE_HOME = home
    expect(modelCatalog().claude).toEqual({ strongest: 'claude-fable-9', models: [
      { id: 'claude-opus-9', label: 'Opus 9', featured: true }, { id: 'claude-fable-9', label: 'Fable 9', featured: true },
      { id: 'claude-opus-8', label: 'Opus 8', featured: false }, { id: 'claude-bare', label: 'claude-bare', featured: false },
    ] })
  })

  it('reads Codex\'s models cache: listed ones by priority, the first three featured, hidden ones left out', () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-codex-home-'))
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-7', display_name: 'GPT-7', priority: 4, visibility: 'list' },
      { slug: 'gpt-9', display_name: 'GPT-9', priority: 1, visibility: 'list' },
      { slug: 'gpt-secret', display_name: 'Secret', priority: 2, visibility: 'hide' },
      { slug: 'gpt-8', priority: 3, visibility: 'list' },
      { slug: 'gpt-6', display_name: 'GPT-6', priority: 0, visibility: 'list' },
      { display_name: 'nameless', visibility: 'list' },
    ] }))
    process.env.ORCHESTRATOR_CODEX_HOME = home
    expect(codexHome()).toBe(home)
    expect(modelCatalog().codex).toEqual({ strongest: 'gpt-6', models: [
      { id: 'gpt-6', label: 'GPT-6', featured: true }, { id: 'gpt-9', label: 'GPT-9', featured: true },
      { id: 'gpt-8', label: 'gpt-8', featured: true }, { id: 'gpt-7', label: 'GPT-7', featured: false },
    ] })
  })

  it('falls back to the built-in list when a cache is missing, empty or of another shape', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orch-empty-home-'))
    process.env.ORCHESTRATOR_CLAUDE_HOME = empty; process.env.ORCHESTRATOR_CODEX_HOME = empty
    expect(modelCatalog()).toEqual(FALLBACK_CATALOG)
    mkdirSync(join(empty, 'cache', 'model-catalog'), { recursive: true })
    writeFileSync(join(empty, 'cache', 'model-catalog', 'a.json'), catalogFile(1, []))
    writeFileSync(join(empty, 'models_cache.json'), JSON.stringify({ models: 'nope' }))
    expect(modelCatalog()).toEqual(FALLBACK_CATALOG)
    delete process.env.ORCHESTRATOR_CLAUDE_HOME; delete process.env.ORCHESTRATOR_CODEX_HOME
    expect(codexHome()).toMatch(/\/\.codex$/)
  })

  it('starts a session on the newest Fable when one is featured, else the first featured, else the first, else the fallback', () => {
    expect(strongestOf([{ id: 'a', label: 'Opus 9', featured: true }, { id: 'b', label: 'Fable 9', featured: true }], 'x')).toBe('b')
    expect(strongestOf([{ id: 'a', label: 'Opus 9', featured: true }, { id: 'b', label: 'Fable 8', featured: false }], 'x')).toBe('a')
    expect(strongestOf([{ id: 'c', label: 'Sonnet 9', featured: false }], 'x')).toBe('c')
    expect(strongestOf([], 'x')).toBe('x')
  })

  it('is served to the UI', async () => {
    const h = await startHarness()
    try {
      const catalog = await (await h.get('/api/models')).json()
      expect(catalog.claude.models.filter((model: any) => model.featured).map((model: any) => model.label)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5'])
      expect(catalog.codex.strongest).toBe('gpt-5.5')
    } finally { await h.stop() }
  })
})
