import { describe, expect, it } from 'vitest'
import { isTestPath, splitTotals } from '../shared/testPaths.ts'

describe('isTestPath', () => {
  it.each([
    'tests/unit/test_agent.py', 'backend/test_models.py', 'src/foo.test.ts', 'src/foo.spec.tsx',
    'pkg/x_test.go', 'Tests/OrchestratorTests/DiffTests.swift', 'conftest.py',
    'src/__tests__/a.js', 'e2e/login.ts', 'fixtures/data.json', '__snapshots__/a.snap',
  ])('%s is a test', (path) => expect(isTestPath(path)).toBe(true))

  it.each([
    'backend/agent.py', 'src/App.tsx', 'server/index.ts', 'docs/testing.md',
    'attestation.py', 'contest/rules.py', 'latest/foo.ts',
  ])('%s is source', (path) => expect(isTestPath(path)).toBe(false))
})

describe('splitTotals', () => {
  it('buckets by path and sums separately', () => {
    const totals = splitTotals([
      { path: 'a.py', added: 5, removed: 2 },
      { path: 'tests/test_a.py', added: 30, removed: 1 },
      { path: 'b.py', added: 1, removed: 0 },
    ])
    expect(totals.source).toEqual({ files: 2, added: 6, removed: 2 })
    expect(totals.tests).toEqual({ files: 1, added: 30, removed: 1 })
  })
})
