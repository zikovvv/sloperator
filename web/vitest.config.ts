import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Points every seam at throwaway dirs before any test module loads; see tests/setup/isolate.ts.
    setupFiles: ['tests/setup/isolate.ts'],
    // Two workers at most: a full pool once made the user's laptop unusable.
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      // Istanbul, like the Playwright run, so both reports merge into one 100% check.
      provider: 'istanbul',
      include: ['server/**/*.ts', 'shared/testPaths.ts', 'shared/branchName.ts', 'src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['server/index.ts', 'src/lib/monaco.ts', 'src/lib/branchName.ts', 'src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text-summary', 'json', 'html'],
      reportsDirectory: 'coverage/unit',
      // Every file: server, shared, lib, components and the app shell (components under jsdom).
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
})
