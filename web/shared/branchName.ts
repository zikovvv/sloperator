const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'crisp', 'dusty', 'eager', 'fleet', 'gentle', 'jolly',
  'lucid', 'mellow', 'nimble', 'plucky', 'quiet', 'rapid', 'sly', 'steady', 'sunny', 'swift',
]
const NOUNS = [
  'anchor', 'beacon', 'canyon', 'cedar', 'comet', 'delta', 'ember', 'falcon', 'harbor', 'lantern',
  'meadow', 'otter', 'pebble', 'quartz', 'ridge', 'sparrow', 'thicket', 'tundra', 'willow', 'zephyr',
]

const pick = (words: string[]) => words[Math.floor(Math.random() * words.length)]

/** A throwaway branch name so the + button is one click; the agent renames it once it knows the work. */
export function suggestBranchName(taken: string[] = []): string {
  const used = new Set(taken)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const name = `orch/${pick(ADJECTIVES)}-${pick(NOUNS)}`
    if (!used.has(name)) return name
  }
  return `orch/work-${Date.now().toString(36)}`
}
