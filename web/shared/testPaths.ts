/**
 * Whether a path is test/fixture code. One rule shared by the server and the UI so a file is
 * never counted as source in one place and as a test in the other.
 */
const TEST_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//i,              // tests/ or test/
  /(^|\/)__tests__\//,
  /(^|\/)spec\//i,
  /(^|\/)e2e\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)__snapshots__\//,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb|ts|tsx|js|jsx)$/,
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /Tests?\.swift$/,
  /(^|\/)conftest\.py$/,
  /\.snap$/,
]

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path))
}

export interface SplitTotals {
  source: { files: number; added: number; removed: number }
  tests: { files: number; added: number; removed: number }
}

export function splitTotals(
  files: Array<{ path: string; added: number; removed: number }>,
): SplitTotals {
  const totals: SplitTotals = {
    source: { files: 0, added: 0, removed: 0 },
    tests: { files: 0, added: 0, removed: 0 },
  }
  for (const file of files) {
    const bucket = isTestPath(file.path) ? totals.tests : totals.source
    bucket.files += 1
    bucket.added += file.added
    bucket.removed += file.removed
  }
  return totals
}
