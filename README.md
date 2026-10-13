# Sloperator

A Mac app for running local `claude` (Claude Code) and `codex` agents side by side: many
sessions across many git worktrees, each with its chat, its live activity and a review panel for
what it changed. Everything runs on your machine with the CLIs you already have signed in; the
app has no account and no server of its own.

It is a personal tool, shared as it is: macOS only, built for one person's way of working, and
it changes often.

## Run it

You need Node 22 or newer, git, and at least one of the `claude` and `codex` CLIs signed in.

```bash
cd web
npm install
npm run dev        # the app in your browser: http://localhost:5273
```

To install it as a Mac app instead (`/Applications/Sloperator.app`, ad-hoc signed):

```bash
cd web
npm run ship
```

Optional, each used only if present: `gh` (pull requests and stacks), `pyright-langserver` and
`typescript-language-server` (go to definition and usages in the review panel), `whisper-cpp`
with a model in `~/.cache/whisper/` (dictation).

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
- **Review panel** (right side): the whole file with its changes inline, against the worktree's
  base, the default branch, a commit, or just the last turn; comments and quotes go straight into
  the chat; **pyright/tsserver navigation** - ⌘-click or F12 for definitions, ⇧F12 for usages.
- **Stacks**: a stack of worktrees where each layer builds on the one below; update them bottom
  to top, open their pull requests chained, land the bottom one.
- **Live activity**: every tool call, process and subagent of a running turn, with kill switches.
  A turn stays open while commands or subagents it started in the background are still running,
  and they are listed while they do.
- **Claude Infra tab**: browse/edit global + project CLAUDE.md, memories, hooks, skills, agents,
  commands without digging through dotfiles.
- **Usage tab**: a Claude | Codex switch; each side shows the plan's limits (session and weekly,
  with when they reset), today / 7 / 30 day spend, by model, by day, by project and per session.
  Claude's limits come from its usage API; Codex's from the reading Codex writes into its own
  session logs on every request, priced via the Settings rate.
- **Agents can drive the sidebar**: every session (Claude and Codex) gets `list_workspace`,
  `update_session`, `update_worktree`, `create_session`, `create_worktree`, `manage_folder` and
  `manage_stack` as tools, so "move this session to the review worktree" or "rename that
  worktree and file it under spikes" works from the chat. From any other shell or agent:
  `node web/bin/sloperator.mjs` lists the same operations and
  `node web/bin/sloperator.mjs update_session session="Fix login" title="Login fix"` runs one
  (it finds the running app by itself; the same thing is `GET`/`POST /api/control`). A session
  without Full access shows each change as a card in its chat and waits for your yes. No
  worktree, session, branch or file is deleted this way, and no pull request is opened or landed.
  A moved session keeps its transcript; its agent starts a new thread in the new folder, handed
  the recent conversation. Nothing moves under a running agent: a session asked to move mid-turn
  goes when the turn ends, and a worktree's directory is filed, renamed or repointed only when idle.
- **Pull Requests tab**: `gh pr list` per project, CI status, one-click "review in new worktree".
- **Slash-skill autocomplete** in the composer + quick-start skill/agent buttons on empty chats.

## Tests

```bash
cd web
npm run test:all   # vitest (every file at 100% coverage), then Playwright in headless Chromium
```

Tests run against throwaway state, fake `claude`/`codex`/`gh` binaries and their own ports;
they never touch your real sessions. `CLAUDE.md` holds the rules changes are held to.

## Layout

- `web/server` - the Node server: turns, worktrees, git, review, usage, the tools agents get.
- `web/src` - the React interface. `web/electron` - the Mac app shell.
- `Sources/`, `Tests/`, `Package.swift`, `scripts/build_app.sh` - the first, native Swift
  version of the app. It is kept for reference and no longer developed.

## State

`~/Library/Application Support/ClaudeOrchestrator/` — `state.json` (projects, worktrees, sessions,
settings) + `transcripts/<session>.json`. Delete a file there to reset that piece.

## Licence

MIT, see `LICENSE`.
