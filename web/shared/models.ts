import type { EngineKind } from './types.ts'

/** The strongest model each engine offers: what a session starts on until something else is chosen. */
export const STRONGEST_MODEL: Record<EngineKind, string> = { claude: 'claude-fable-5', codex: 'gpt-5.5' }
