import type { TranscriptItem } from '../shared/types.ts'

export interface ReviewComment {
  file: string
  line: number
  snippet?: string
  body: string
}

/**
 * Folds review comments into the message actually sent. Without this the chips the composer
 * shows are dropped at the server boundary and the agent never learns which lines they concern.
 */
export function composePrompt(text: string, comments: ReviewComment[]): string {
  if (!comments.length) return text
  const lines = comments.map((comment) => {
    const snippet = comment.snippet?.trim()
    return `- ${comment.file}:${comment.line}`
      + (snippet ? `\n  \`${snippet}\`` : '')
      + `\n  ${comment.body.trim()}`
  })
  return `${text}\n\nReview comments on the current diff:\n${lines.join('\n')}`
}

export function parseComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const file = String((entry as ReviewComment)?.file ?? '').trim()
    const body = String((entry as ReviewComment)?.body ?? '').trim()
    const line = Number((entry as ReviewComment)?.line)
    if (!file || !body || !Number.isFinite(line)) return []
    return [{ file, line, body, snippet: String((entry as ReviewComment)?.snippet ?? '') }]
  })
}

/**
 * What the other engine has not seen. Switching engine mid-conversation otherwise starts a fresh
 * backend thread whose only input is the new prompt, so the agent answers with no idea what was
 * already discussed.
 */
export function bridgePrompt(items: TranscriptItem[], fromIndex: number, budget = 24000): string | null {
  const unseen = items.slice(fromIndex).filter(
    (item) => (item.role === 'user' || item.role === 'assistant') && item.text?.trim())
  if (!unseen.length) return null

  const rendered: string[] = []
  let used = 0
  for (const item of [...unseen].reverse()) {
    const line = `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text!.trim()}`
    if (used + line.length > budget) { rendered.unshift('… earlier turns omitted …'); break }
    rendered.unshift(line)
    used += line.length
  }
  return `Context from this conversation so far, which you did not see because it ran on the other engine:\n\n${rendered.join('\n\n')}\n\n---\n`
}
