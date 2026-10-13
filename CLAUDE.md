# Orchestrator — project rules

## Tests are part of every change. No exceptions.

Every feature, every button, every route, every flag — however small — lands with:

1. **Unit tests** in `web/tests/*.test.ts` (vitest). Server routes are tested in-process through
   `startServer({ port: 0, background: false, signals: false })` against a temp
   `ORCHESTRATOR_STATE_DIR`, never against the user's real state. Pure modules are tested directly.
2. **UI tests** in `web/e2e/*.spec.ts` (Playwright, headless Chromium) that click the actual
   control in the actual page and assert the visible result *and* the request it made.
3. **Coverage stays at 100%** on every file — server, shared, lib, components and the app shell —
   enforced by the vitest run (components are rendered under jsdom with the API mocked). The
   Playwright run is the "every button clicked in a real browser" layer: it reports coverage but
   the gate is the vitest one, because two instrumenters cannot be merged honestly. A change that
   lowers coverage does not merge; add the test, do not lower the number.

Run `cd web && npm run test:all` before every commit. A commit's `Verified-by:` block quotes the
counts it printed. `python3 scripts/uncovered.py [file]` lists what the unit run left uncovered,
with the source line for each entry — that is the list to work from, not the percentage.

Why: a delete button shipped that silently did nothing, twice, because nothing clicked it.

## Other hard rules

- Never drive the user's screen; test only in the headless browser or in-process.
- Never restart the user's running app unless they say it is wrong.
- Worktrees are never deleted automatically; deletion is one red confirm and keeps the branch.
- No native dialogs (`alert`, `confirm`, `prompt`) anywhere in the UI.
- Codex reads CLAUDE.md natively; never write an AGENTS.md.

## The user's instance is not the test environment

- **Theirs:** `npm run dev` → UI http://localhost:5273, API 127.0.0.1:8787, state in
  `~/Library/Application Support/ClaudeOrchestrator`, worktrees under `~/.orchestrator/worktrees`,
  and the packaged `/Applications/Orchestrator.app`. Tests never touch any of these.
- **Tests:** vitest loads `tests/setup/isolate.ts` first, which points every seam
  (`ORCHESTRATOR_STATE_DIR`, `_WORKTREE_ROOT`, `_CLAUDE_HOME`, `_CLAUDE_PROJECTS`, `_BIN_DIR`,
  `_ENGINES_DIR`, `_USAGE_URL`, `_WHISPER_MODEL`, `PORT=0`) at throwaway directories and fake
  binaries, and `server/state.ts` refuses to load under vitest without `ORCHESTRATOR_STATE_DIR`.
  Playwright spawns its own server on 8797 and Vite on 5299 with the same seams. Never point a
  test at 8787/5273 or at a real home directory.
- **Updating their app happens only when they ask:** `cd web && npm run ship` rebuilds, smoke-tests
  the build against a throwaway state dir, quits any running copy, replaces
  `/Applications/Orchestrator.app` and ad-hoc signs it. It does **not** launch it: the user runs the
  browser app on 5273, and a second copy would be a second writer on the same `state.json`. The dev
  instance on 5273 always runs the working tree (Vite HMR + `tsx watch`) and needs nothing.
