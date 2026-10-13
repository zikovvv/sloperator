# Sloperator

Native macOS app for orchestrating local `claude` (Claude Code) and `codex` CLI agents —
Conductor/Codex-app style, in one place, local-only.

## Hierarchy

```
Project  (git repo; git init happens automatically when you add a non-git folder)
└── Worktree            ← the unit of work. NEVER recycled automatically.
    ├── branch          (loosely linked — the header shows the live branch)
    └── Sessions        (multiple Claude/Codex chats, all contained in that worktree)
```

## Features

- **Sidebar**: Projects → collapsible worktrees → sessions. Parallel sessions run fine.
- **Chat** with streaming tool calls, thinking blocks, markdown, cost per turn.
- **Header chips** (like the Codex app): Local · project · worktree · live branch, then on the
  right: steer/queue toggle · $cost · engine · **model** · **reasoning effort** · access mode ·
  review toggle. Model and effort are per session and apply from the next message
  (`claude --model/--effort`, `codex -m/-c model_reasoning_effort`); "Default" leaves the CLI's
  own configured value alone.
- **Engines**: `claude -p --output-format stream-json` and `codex exec --json`. Switch engine
  mid-conversation — the new engine gets a context bridge with everything it missed.
- **CLAUDE.md native everywhere**: codex runs with
  `-c project_doc_fallback_filenames=["CLAUDE.md"]` (verified working) plus a preamble pointing
  at `~/.claude/CLAUDE.md`. No AGENTS.md conversion, ever.
- **Steer vs Queue** (one-click toggle chip on the right of the header, never above the composer):
  messages sent while the agent is busy either interrupt-and-inject (steer) or get delivered
  automatically when the turn ends (queue). The chip shows a badge with the queued count.
- **No agent outlives the app**: every spawned CLI/LSP process is registered with a janitor that
  kills them on quit, and reaps orphans at the next launch if the app was force-killed. Reaping
  matches on pid **and** process start time, so a recycled pid can never hit an innocent process.
- **Worktrees**: created under `~/.orchestrator/worktrees/<project>/` (configurable in Settings),
  with a branch picker (new branch + fork point, or check out an existing/remote branch) and a
  "move current uncommitted work into it" option. Nothing recycles them: closing sessions,
  removing from the sidebar and archiving all leave the folder untouched. The only way one is
  destroyed is the red **Delete Worktree** button on its page, which confirms first and never
  deletes the branch.
- **Review panel** (right side): changed files vs the worktree's base branch, unified diff, and a
  Source tab with **pyright/tsserver LSP navigation** — ⌘-click go-to-definition, hover for types.
- **Claude Infra tab**: browse/edit global + project CLAUDE.md, memories, hooks, skills, agents,
  commands without digging through dotfiles.
- **Usage tab**: live 5-hour Claude usage block (when it resets), block history, and
  API-equivalent per-session costs (Claude cost from the CLI, Codex priced via Settings rates).
- **Pull Requests tab**: `gh pr list` per project, CI status, one-click "review in new worktree".
- **Slash-skill autocomplete** in the composer + quick-start skill/agent buttons on empty chats.

## Build & run

```bash
./scripts/build_app.sh --open     # builds dist/Orchestrator.app and launches it
```

Dev loop: `swift run` (runs unbundled, still shows the full UI).

## Requirements

- `claude` and `codex` CLIs on PATH (also searched: `~/.local/bin`, `/opt/homebrew/bin`,
  `~/miniconda3/bin`).
- `pyright-langserver` for Python navigation, `typescript-language-server` for TS/JS (optional).
- `gh` for the Pull Requests tab (optional).

## State

`~/Library/Application Support/ClaudeOrchestrator/` — `state.json` (projects, worktrees, sessions,
settings) + `transcripts/<session>.json`. Delete a file there to reset that piece.
