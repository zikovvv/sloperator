import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { binary } from './engines.ts'

const run = promisify(execFile)

export interface PlanLimit {
  kind: string
  group: 'session' | 'weekly' | string
  label: string
  percent: number
  resetsAt: string | null
  isActive: boolean
}

export interface ExtraUsage {
  enabled: boolean
  usedUSD: number
  limitUSD: number
  percent: number
  disabledReason: string | null
}

export interface PlanUsage {
  plan: string
  limits: PlanLimit[]
  extra: ExtraUsage | null
  fetchedAt: number
}

/** "default_claude_max_20x" -> "Max (20x)", the way the Claude app labels it. */
export function planLabel(tier: string | undefined, subscription: string | undefined): string {
  const multiplier = /(\d+)x/i.exec(tier ?? '')?.[1]
  const name = (subscription ?? /claude_(\w+?)(?:_\d+x)?$/.exec(tier ?? '')?.[1] ?? 'Plan')
  const pretty = name.charAt(0).toUpperCase() + name.slice(1)
  return multiplier ? `${pretty} (${multiplier}x)` : pretty
}

export function labelFor(limit: { kind: string; scope?: { model?: { display_name?: string | null } | null } | null }): string {
  if (limit.kind === 'session') return 'Current session'
  if (limit.kind === 'weekly_all') return 'All models'
  return limit.scope?.model?.display_name ?? limit.kind
}

/** The token lives in the keychain and only ever passes through memory here. */
async function accessToken(): Promise<{ token: string; tier?: string; subscription?: string } | null> {
  try {
    const { stdout } = await run(binary('security', '/usr/bin/security'),
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
    const oauth = JSON.parse(stdout.trim()).claudeAiOauth ?? {}
    return oauth.accessToken
      ? { token: oauth.accessToken, tier: oauth.rateLimitTier, subscription: oauth.subscriptionType }
      : null
  } catch {
    return null
  }
}

let cache: { value: PlanUsage; at: number } | null = null
export function resetPlanUsageCache() { cache = null }
const CACHE_MS = 60_000

/** The same numbers the Claude app shows: the plan's own limits, straight from the API. */
export async function planUsage(): Promise<PlanUsage | { error: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const credentials = await accessToken()
  if (!credentials) return { error: 'Not signed in to Claude. Run `claude` once to log in.' }

  const response = await fetch(process.env.ORCHESTRATOR_USAGE_URL ?? 'https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code',
    },
  })
  if (response.status === 401) return { error: 'Claude login has expired. Run `claude` to sign in again.' }
  if (!response.ok) return { error: `Usage request failed (${response.status}).` }

  const body = await response.json() as { limits?: any[]; extra_usage?: any }
  const extra = body.extra_usage
  const scale = 10 ** Number(extra?.decimal_places ?? 2)
  const value: PlanUsage = {
    plan: planLabel(credentials.tier, credentials.subscription),
    extra: extra ? {
      enabled: !!extra.is_enabled,
      usedUSD: Number(extra.used_credits ?? 0) / scale,
      limitUSD: Number(extra.monthly_limit ?? 0) / scale,
      percent: Number(extra.utilization ?? 0),
      disabledReason: extra.disabled_reason ?? null,
    } : null,
    limits: (body.limits ?? []).map((limit) => ({
      kind: String(limit.kind), group: String(limit.group), label: labelFor(limit),
      percent: Number(limit.percent ?? 0), resetsAt: limit.resets_at ?? null,
      isActive: !!limit.is_active,
    })),
    fetchedAt: Date.now(),
  }
  cache = { value, at: Date.now() }
  return value
}
