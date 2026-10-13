import type { TranscriptItem } from '../../shared/types.ts'

/**
 * Merges the fetched history with what the socket streamed. Live appends arrive for every
 * session from page load, and the fetched history already contains them, so the overlap has to
 * be removed by id or the transcript renders those items twice.
 */
export function mergeTranscript(history: TranscriptItem[], live: TranscriptItem[]): TranscriptItem[] {
  const byID = new Map<string, TranscriptItem>()
  for (const item of [...history, ...live]) byID.set(item.id, item)
  return [...byID.values()]
}
