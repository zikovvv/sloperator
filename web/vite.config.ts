import { realpathSync } from 'node:fs'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import istanbul from 'vite-plugin-istanbul'
import react from '@vitejs/plugin-react'

// The UI talks to the local agent server over /api and /ws; Vite proxies both in dev so
// there is one origin and hot reload keeps working.
export default defineConfig({
  plugins: [
    react(),
    // Instrumented only for the UI test run; nyc enforces component coverage from it.
    ...(process.env.VITE_COVERAGE ? [istanbul({ include: 'src/**/*', extension: ['.ts', '.tsx'], forceBuildInstrument: true })] : []),
  ],
  server: {
    port: 5273,
    // A worktree may link node_modules from elsewhere; Monaco's icon font is served from there.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync('node_modules')] },
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? 8787}`,
      '/terminal': { target: `ws://127.0.0.1:${process.env.API_PORT ?? 8787}`, ws: true },
      '/ws': { target: `ws://127.0.0.1:${process.env.API_PORT ?? 8787}`, ws: true },
    },
  },
})
