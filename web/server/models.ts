import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_CATALOG, strongestOf, type EngineModels, type ModelCatalog, type ModelOption } from '../shared/models.ts'
import { claudeHome } from './infra.ts'

export function codexHome(): string {
  return process.env.ORCHESTRATOR_CODEX_HOME ?? join(homedir(), '.codex')
}

/**
 * The models each engine offers right now, read from the engines' own caches so a new release
 * appears without a rebuild: Claude Code keeps the catalog it was served (main = the picker's
 * first choices, overflow = the rest), Codex keeps the list it fetched (hidden ones stay hidden).
 */
export function modelCatalog(): ModelCatalog {
  return { claude: withStrongest(claudeModels(), 'claude'), codex: withStrongest(codexModels(), 'codex') }
}

function withStrongest(models: ModelOption[] | null, engine: keyof ModelCatalog): EngineModels {
  if (!models?.length) return FALLBACK_CATALOG[engine]
  return { models, strongest: strongestOf(models, FALLBACK_CATALOG[engine].strongest) }
}

function readJSON(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function claudeModels(): ModelOption[] | null {
  const directory = join(claudeHome(), 'cache', 'model-catalog')
  if (!existsSync(directory)) return null
  // One file per login; the newest fetch is the one to trust.
  const catalogs = readdirSync(directory).filter((name) => name.endsWith('.json'))
    .map((name) => readJSON(join(directory, name)))
    .filter((data) => Array.isArray(data?.catalog?.config?.models))
    .sort((a, b) => Number(b.fetchedAt) - Number(a.fetchedAt))
  return catalogs[0]?.catalog.config.models
    .filter((model: any) => typeof model.id === 'string')
    .map((model: any) => ({ id: model.id, label: String(model.name ?? model.id), featured: model.section === 'main' }))
}

const CODEX_FEATURED = 3

function codexModels(): ModelOption[] | null {
  const data = readJSON(join(codexHome(), 'models_cache.json'))
  if (!Array.isArray(data?.models)) return null
  return data.models
    .filter((model: any) => typeof model.slug === 'string' && model.visibility === 'list')
    .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
    .map((model: any, index: number) => ({ id: model.slug, label: String(model.display_name ?? model.slug), featured: index < CODEX_FEATURED }))
}
