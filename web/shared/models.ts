import type { EngineKind } from './types.ts'

/** One model an engine can run, as its own catalog names it. Featured ones are offered first. */
export interface ModelOption { id: string; label: string; featured: boolean }
export interface EngineModels { models: ModelOption[]; strongest: string }
export type ModelCatalog = Record<EngineKind, EngineModels>

/** What is offered when an engine's own catalog cannot be read: the models known when this shipped. */
export const FALLBACK_CATALOG: ModelCatalog = {
  claude: { strongest: 'claude-fable-5-1', models: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1', featured: true },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', featured: true },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', featured: true },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', featured: true },
    { id: 'claude-opus-5', label: 'Opus 5', featured: false },
    { id: 'claude-fable-5', label: 'Fable 5', featured: false },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', featured: false },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', featured: false },
  ] },
  codex: { strongest: 'gpt-5.5', models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', featured: true },
    { id: 'gpt-5.5-codex', label: 'GPT-5.5-Codex', featured: true },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', featured: false },
    { id: 'gpt-5.2', label: 'GPT-5.2', featured: false },
  ] },
}

/** The model a session starts on: the newest Fable when Claude offers one, else the first featured. */
export function strongestOf(models: ModelOption[], fallback: string): string {
  const featured = models.filter((model) => model.featured)
  return featured.find((model) => /fable/i.test(model.label))?.id ?? featured[0]?.id ?? models[0]?.id ?? fallback
}
