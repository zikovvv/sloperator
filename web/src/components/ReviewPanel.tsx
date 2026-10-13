import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../lib/monaco.ts'
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react'
import { ContextMenu } from './ContextMenu.tsx'
import { compose, formatQuote, hunkLines } from '../lib/quote.ts'
import { copyText } from '../lib/clipboard.ts'
import { api } from '../lib/api.ts'
import { matchChanged } from '../lib/fileRef.ts'
import { splitTotals } from '../../shared/testPaths.ts'
import type { DiffFile, PRConversationResult } from '../../shared/types.ts'
import { startDrag, useStoredValue } from '../lib/resizable.ts'
import { ensureProviders, languageFor, NAVIGATION_HINT, wireLanguageServers } from '../lib/lspProviders.ts'
import { ancestorsOf, buildTree, splitTests, type TreeFile, type TreeNode } from '../lib/fileTree.ts'
import type { ReviewComment } from './Chat.tsx'
import { PanelToggle } from './PanelToggle.tsx'

const SCOPES = [
  { id: 'uncommitted', label: 'Uncommitted' },
  { id: 'turn', label: 'Last turn' },
  { id: 'staged', label: 'Staged' },
  { id: 'branch', label: 'Branch vs its base' },
  { id: 'main', label: 'Branch vs main' },
  { id: 'remote', label: 'vs Remote' },
] as const


/** Where the reader was in this worktree's review, kept across reloads and panel toggles. */
interface ReviewState {
  scope: string
  commitSHA: string | null
  selected: string | null
  /** 'diff' shows the change; 'file' reads any file the navigation led to. */
  mode: 'diff' | 'file'
  /** Only the changed files, or the whole project with the changed ones marked. */
  treeMode: 'changed' | 'all'
  panelOpen: boolean
  viewing: { path: string; line?: number } | null
  history: Array<{ path: string; line?: number }>
  /** Files stepped back from, so Forward can return to them. */
  future: Array<{ path: string; line?: number }>
  /** Folders folded shut in the tree. */
  folds: string[]
  /** The pull-request conversations, stacked under the tree in the same sidebar. */
  conversationsOpen: boolean
  /** How tall the tree is when the conversations share the sidebar with it. */
  treeHeight: number
  /** Long lines wrap to the panel's width instead of scrolling sideways. */
  wrap: boolean
}

const initialState = (isMain: boolean): ReviewState => ({
  // A branch is reviewed against what it forked from; the main checkout has only its edits.
  scope: isMain ? 'uncommitted' : 'branch', commitSHA: null, selected: null,
  mode: 'diff', treeMode: 'changed', panelOpen: false, viewing: null, history: [], future: [], folds: ['§tests'],
  conversationsOpen: false, treeHeight: 260, wrap: false,
})

interface Props {
  worktreeID: string
  worktreePath: string
  /** Which pull request the conversations come from; inferred from git, so it can be absent. */
  branch: string | null
  baseBranch: string | null
  isMain: boolean
  generation: number
  onAddComment: (comment: ReviewComment) => void
  /** Sends a quoted selection to the open session right away, no composer step. */
  onQuote: (text: string) => void
  /** Present when the panel can be tucked away. */
  onCollapse?: () => void
  /** A file the chat asked to see; a fresh nonce opens the same path again. */
  open?: { path: string; line?: number; nonce: number } | null
}

const EDITOR_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** The scope by name — with the branch it was measured against once the server has said. */
export function describeScope(scope: string, base: string | null): string {
  if (scope === 'branch' || scope === 'main') return `Branch vs ${base ?? (scope === 'main' ? 'main' : 'its base')}`
  return SCOPES.find((candidate) => candidate.id === scope)!.label
}

export function ReviewPanel({
  worktreeID, worktreePath, branch, baseBranch, isMain, generation, onAddComment, onQuote, onCollapse, open,
}: Props) {
  const [state, setState] = useStoredValue<ReviewState>(`orchestrator.review.${worktreeID}`, initialState(isMain))
  const patch = useCallback((changes: Partial<ReviewState>) => setState((current) => ({ ...current, ...changes })), [setState])
  const [files, setFiles] = useState<DiffFile[]>([])
  const [everything, setEverything] = useState<TreeFile[]>([])
  const [commits, setCommits] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  /** Whether the diff has answered at least once for this worktree, so its file list can be trusted. */
  const [diffKnown, setDiffKnown] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fileText, setFileText] = useState('')
  const [commentLine, setCommentLine] = useState<{ line: number; snippet: string } | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  /** The turn "Last turn" shows, or null when none has finished in this worktree. */
  const [turn, setTurn] = useState<{ sessionID: string; endedAt: number } | null>(null)
  /** The branch the server measured against, for the two scopes that have one. */
  const [base, setBase] = useState<string | null>(null)
  const { scope, commitSHA, selected, mode, treeMode, panelOpen, viewing, history, folds } = state
  const future = state.future ?? []
  const conversationsOpen = state.conversationsOpen ?? false
  const treeHeight = state.treeHeight ?? 260
  const wrap = state.wrap ?? false

  /** Which refresh is the newest: an older one's answer is for a worktree or scope no longer shown. */
  const requestRef = useRef(0)
  /** Whether the next refresh asks the server to fetch origin first: on arrival, and on the button. */
  const freshRef = useRef(true)
  const refresh = useCallback(async (fresh: boolean) => {
    const mine = ++requestRef.current
    setLoading(true)
    try {
      const [diff, log] = await Promise.all([
        api.diff(worktreePath, scope, isMain ? null : baseBranch, 3, commitSHA ?? undefined, fresh || undefined),
        api.commits(worktreePath, isMain ? null : baseBranch).catch(() => ({ commits: [] })),
      ])
      if (mine !== requestRef.current) return
      const changed: DiffFile[] = diff.files ?? []
      setFiles(changed)
      setTurn(diff.turn ?? null)
      setBase(diff.base ?? null)
      setCommits(log.commits ?? [])
      setState((current) => ({
        ...current,
        selected: current.selected && changed.some((file) => file.path === current.selected)
          ? current.selected : changed[0]?.path ?? null,
      }))
      setFailure(null)
    } catch (error) {
      if (mine !== requestRef.current) return
      setFailure((error as Error).message)
    } finally {
      if (mine === requestRef.current) { setLoading(false); setDiffKnown(true) }
    }
  }, [worktreePath, scope, baseBranch, isMain, commitSHA, setState])

  // Another worktree starts from nothing: the previous one's diff must not stand in for it while it loads.
  useEffect(() => { setFiles([]); setCommits([]); setTurn(null); setBase(null); setFailure(null); setDiffKnown(false); freshRef.current = true }, [worktreePath])
  useEffect(() => { void refresh(freshRef.current); freshRef.current = false }, [refresh, generation])

  // The whole project is only listed when someone is looking at it.
  useEffect(() => {
    if (treeMode !== 'all') return
    void api.tree(worktreePath, scope, isMain ? null : baseBranch, commitSHA ?? undefined)
      .then((result) => setEverything(result.files))
      .catch((error) => setNotice((error as Error).message))
  }, [treeMode, worktreePath, scope, baseBranch, isMain, commitSHA, generation])

  const [conversations, setConversations] = useState<PRConversationResult | null>(null)
  useEffect(() => {
    if (!conversationsOpen || !branch) return
    let live = true
    void api.conversations(worktreePath, branch)
      .then((result) => { if (live) setConversations(result) })
      .catch((error) => { if (live) setConversations({ ok: false, message: (error as Error).message }) })
    return () => { live = false }
  }, [conversationsOpen, branch, worktreePath, generation])

  const absolute = useCallback((path: string) => (path.startsWith('/') ? path : `${worktreePath}/${path}`), [worktreePath])
  const relative = useCallback((path: string) => (path.startsWith(`${worktreePath}/`) ? path.slice(worktreePath.length + 1) : path), [worktreePath])

  // A file outside the diff: read it as it is, with the tree opened to it.
  const showFile = useCallback((path: string, line?: number) => {
    const rel = relative(path)
    setState((current) => ({
      ...current, mode: 'file', treeMode: 'all', viewing: { path: rel, line }, selected: rel,
      history: current.viewing ? [...current.history, current.viewing].slice(-30) : current.history,
      future: [],
      folds: current.folds.filter((fold) => !ancestorsOf(rel).includes(fold)),
    }))
  }, [relative, setState])

  useEffect(() => {
    if (mode !== 'file' || !viewing) return
    void api.file(absolute(viewing.path)).then((file) => setFileText(file.text)).catch((error) => { setFileText(''); setNotice((error as Error).message) })
  }, [mode, viewing, absolute])

  // The chat asked for a file: a changed one opens in the diff being reviewed, at its line; anything else as a file.
  const lastOpen = useRef<number | null>(null)
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null)
  const diffEditor = useRef<{ path: string; editor: any } | null>(null)
  useEffect(() => {
    // Until the diff has answered once, nobody knows whether the file is in it: wait rather than guess.
    if (!open || open.nonce === lastOpen.current || !diffKnown) return
    lastOpen.current = open.nonce
    const changed = matchChanged(relative(open.path), files.map((file) => file.path))
    if (!changed) { showFile(open.path, open.line); return }
    patch({ mode: 'diff', selected: changed, viewing: null })
    setReveal(open.line ? { path: changed, line: open.line, nonce: open.nonce } : null)
  }, [open, files, diffKnown, relative, patch, showFile])
  /** Brings the line the chat named into view, once the diff of its file is the one mounted. */
  const revealIn = useCallback((mounted: { path: string; editor: any } | null, wanted: typeof reveal) => {
    if (!mounted || !wanted || mounted.path !== wanted.path) return
    mounted.editor.revealLineInCenter(wanted.line)
    mounted.editor.setPosition({ lineNumber: wanted.line, column: 1 })
  }, [])
  useEffect(() => { if (mode === 'diff') revealIn(diffEditor.current, reveal) }, [reveal, mode, revealIn])

  const file = useMemo(() => files.find((candidate) => candidate.path === selected) ?? files[0] ?? null, [files, selected])
  // The whole file on each side, as the review shows it: the change inline in its file, as VS Code does.
  const [sides, setSides] = useState<{ path: string; before: string; after: string } | null>(null)
  const sidesRef = useRef(0)
  useEffect(() => {
    if (!file) { setSides(null); return }
    const mine = ++sidesRef.current
    api.diffFile(worktreePath, scope, isMain ? null : baseBranch, file.path, commitSHA ?? undefined)
      .then((text) => { if (mine === sidesRef.current) setSides({ path: file.path, before: text.before ?? '', after: text.after ?? '' }) })
      .catch((error: Error) => { if (mine === sidesRef.current) setFailure(error.message) })
  }, [file, worktreePath, scope, baseBranch, isMain, commitSHA, generation])
  const totals = useMemo(() => splitTotals(files), [files])
  const shownPath = mode === 'file' && viewing ? viewing.path : file?.path ?? null

  // The language servers answer for whatever is on screen; the providers are shared by every editor.
  const currentRef = useRef({ workspace: worktreePath, path: shownPath ? absolute(shownPath) : worktreePath })
  currentRef.current = { workspace: worktreePath, path: shownPath ? absolute(shownPath) : worktreePath }
  // Every view shows a whole file, so a rendered row is that line of the file.
  const toFileLine = useCallback((row: number) => row, [])
  const toRow = useCallback((line: number) => line, [])
  useEffect(() => {
    wireLanguageServers({ current: () => currentRef.current, toFileLine, toRow, navigate: showFile, notice: setNotice })
  }, [showFile, toFileLine, toRow])
  const threadCount = conversations?.ok ? conversations.threads.length : null
  const openThread = useCallback((path: string, line: number | null) => {
    showFile(absolute(path), line ?? undefined)
    if (line === null) {
      setNotice('That conversation is outdated: the line it was written against is gone, so it is shown with its own snippet.')
    }
  }, [showFile, absolute])

  const beforeMount = (monaco: Monaco) => ensureProviders(monaco, languageFor(shownPath!))

  const quote = (from: number, to: number, text: string) => {
    const where = from === to ? `${shownPath}:${from}` : `${shownPath}:${from}-${to}`
    onQuote(`From ${where}:\n\`\`\`\n${text}\n\`\`\``)
    setSelection(null)
  }
  const sendQuote = () => quote(toFileLine(selection!.from), toFileLine(selection!.to), selection!.text)

  const scopeLabel = commitSHA
    ? commits.find((commit) => commit.sha === commitSHA)?.subject ?? 'Commit'
    : describeScope(scope, base)
  const nothingHere = scope === 'turn' && !turn ? 'No turn has finished in this worktree yet.' : `No changes in “${scopeLabel}”.`

  const back = useCallback(() => setState((current) => {
    const previous = current.history.at(-1)
    const trail = current.viewing ? [current.viewing, ...(current.future ?? [])].slice(0, 30) : (current.future ?? [])
    return previous
      ? { ...current, viewing: previous, selected: previous.path, history: current.history.slice(0, -1), future: trail }
      : { ...current, mode: 'diff', viewing: null, treeMode: 'changed', selected: files[0]?.path ?? null, future: trail }
  }), [files, setState])

  const forward = useCallback(() => setState((current) => {
    const [next, ...rest] = current.future ?? []
    if (!next) return current
    return { ...current, mode: 'file', viewing: next, selected: next.path, future: rest,
             history: current.viewing ? [...current.history, current.viewing].slice(-30) : current.history }
  }), [setState])

  // The mouse's side buttons walk that trail instead of leaving the app entirely.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      if (event.type !== 'mouseup') return   // act once, on release
      if (event.button === 3) back()
      else forward()
    }
    for (const kind of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(kind, onMouse as EventListener)
    return () => { for (const kind of ['mousedown', 'mouseup', 'auxclick']) window.removeEventListener(kind, onMouse as EventListener) }
  }, [back, forward])

  const tree = useMemo(() => {
    if (treeMode === 'all') return { main: buildTree(everything), tests: [] as TreeNode[] }
    const { source, tests } = splitTests(files)
    return { main: buildTree(source), tests: buildTree(tests) }
  }, [treeMode, everything, files])

  const toggleFold = (path: string) =>
    setState((current) => ({ ...current, folds: current.folds.includes(path) ? current.folds.filter((entry) => entry !== path) : [...current.folds, path] }))
  const pick = (path: string) => {
    if (files.some((entry) => entry.path === path)) patch({ mode: 'diff', selected: path, viewing: null, future: [] })
    else showFile(path)
  }

  const wireEditor = (editor: any, mapLine: (line: number) => number, diff?: any) => {
    // ⌥Z, as in VS Code: wrap long lines, or let them run off to the right again.
    editor.addCommand(512 | 56, () => setState((current) => ({ ...current, wrap: !current.wrap })))   // KeyMod.Alt | KeyCode.KeyZ
    // Right-click → "Quote in chat": the selected lines go into the composer as a quote. In the
    // diff they come as the hunk the inline view draws, deleted lines included.
    editor.addAction({
      id: 'orchestrator.quote', label: 'Quote in chat', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 1.5,
      run: () => {
        const range = editor.getSelection()
        const model = editor.getModel()
        if (!range || !model) return
        const from = range.startLineNumber
        // A selection that ends at the start of the next line was not meant to include that line.
        const to = range.endLineNumber > from && range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber
        const lines = diff
          ? hunkLines(from, to, diff.getLineChanges() ?? [], (line) => model.getLineContent(line),
                      (line) => diff.getOriginalEditor().getModel()?.getLineContent(line) ?? '')
          : Array.from({ length: to - from + 1 }, (_, index) => model.getLineContent(from + index))
        const where = `${shownPath}:${mapLine(from)}${to > from ? `-${mapLine(to)}` : ''}`
        compose(formatQuote(diff ? `${where}, from the diff` : where, lines.join('\n')))
      },
    })
    editor.onDidChangeCursorSelection((event: any) => {
      const range = event.selection
      const text = editor.getModel()?.getValueInRange(range) ?? ''
      setSelection(text.trim() ? { from: range.startLineNumber, to: range.endLineNumber, text } : null)
    })
    editor.addCommand(2048 | 3, () => {   // KeyMod.CtrlCmd | KeyCode.Enter
      const range = editor.getSelection()
      const text = range ? editor.getModel()?.getValueInRange(range) ?? '' : ''
      if (!text.trim() || !range) return
      quote(mapLine(range.startLineNumber), mapLine(range.endLineNumber), text)
    })
    // Click a line number to comment on that line; it rides along with the next message.
    editor.onMouseDown((event: any) => {
      if (event.target.type !== 3) return
      const line = event.target.position?.lineNumber
      if (!line) return
      setCommentLine({ line: mapLine(line), snippet: editor.getModel()?.getLineContent(line) ?? '' })
      setCommentBody('')
    })
  }

  const editorOptions = {
    readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false,
    folding: false, glyphMargin: false, lineNumbersMinChars: 3,
    // Room for the diff's +/- signs, which otherwise spill onto the code; automaticLayout re-wraps on resize.
    lineDecorationsWidth: 18, automaticLayout: true, contextmenu: true, fontFamily: EDITOR_FONT,
    wordWrap: wrap ? 'on' as const : 'off' as const,
    // The scrollbar doubles as a map of the file: what changed, where the cursor is, and every
    // other place the symbol under it is used.
    renderOverviewRuler: true, overviewRulerLanes: 3, overviewRulerBorder: false,
    hideCursorInOverviewRuler: false, selectionHighlight: true,
    occurrencesHighlight: 'singleFile' as const,
    scrollbar: { horizontal: 'auto' as const, verticalScrollbarSize: 14, horizontalScrollbarSize: 8 },
  }

  /**
   * A line can only carry a review comment when it exists in the head commit the conversations
   * were fetched against — that is what GitHub anchors a comment to. Anywhere else (an outdated
   * view, an older commit, a file mode) the comment can still go to the chat, but not to GitHub.
   */
  const pr = conversations?.ok ? conversations : null
  const canPostToPR = !!pr && mode === 'diff' && !commitSHA && scope !== 'staged' && !!shownPath
  const [posting, setPosting] = useState(false)
  const postToPR = (target: { line: number }) => {
    setPosting(true)
    void api.postLineComment({ path: worktreePath, prNumber: pr!.number, commitSHA: pr!.headSHA,
                               file: shownPath!, line: target.line, body: commentBody.trim() })
      .then((result) => {
        if (!result.ok) { setNotice(result.message ?? 'GitHub refused the comment.'); return }
        setCommentLine(null); setCommentBody('')
        setNotice(`Posted on ${shownPath}:${target.line}.`)
        void api.conversations(worktreePath, branch!).then(setConversations).catch(() => {})
      })
      .catch((error) => setNotice((error as Error).message))
      .finally(() => setPosting(false))
  }

  const attach = () => {
    if (!commentLine || !shownPath || !commentBody.trim()) return
    onAddComment({ id: crypto.randomUUID(), file: shownPath, line: commentLine.line, snippet: commentLine.snippet, body: commentBody.trim() })
    setCommentLine(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-900" data-testid="review-panel">
      <div className="flex items-center gap-1.5 border-b border-ink-800 px-2 py-1.5">
        {onCollapse && (
          <PanelToggle collapsed={false} onClick={onCollapse}
                       label="Hide review panel" title="Hide the review panel (⌘⇧R)" />)}
        <button className={`icon-button ${panelOpen ? 'bg-white/10 text-ink-100' : ''}`} aria-label="Files and settings"
                aria-pressed={panelOpen} title="Files, scope and settings"
                onClick={() => patch({ panelOpen: !panelOpen })}>☰</button>
        {mode === 'file' && (
          <button className="chip-button" aria-label="Back" title="Back (mouse 4)" onClick={back}>‹ {history.length ? 'Back' : 'Diff'}</button>)}
        {future.length > 0 && (
          <button className="chip-button" aria-label="Forward" title="Forward (mouse 5)" onClick={forward}>›</button>)}
        <button className="chip-button" aria-pressed={treeMode === 'all'}
                aria-label={treeMode === 'changed' ? 'Show the whole project' : 'Show only changed files'}
                title={treeMode === 'changed' ? 'Showing changed files — click for the whole project' : 'Showing the whole project — click for changed files only'}
                onClick={() => patch({ treeMode: treeMode === 'changed' ? 'all' : 'changed' })}>
          {treeMode === 'changed' ? 'Changed' : 'All files'}
        </button>
        <span className="truncate font-mono text-[11px] text-ink-300" title={shownPath ?? ''}>
          {shownPath ?? scopeLabel}{mode === 'file' && viewing?.line ? `:${viewing.line}` : ''}
        </span>
        {mode === 'diff' && shownPath && <span className="chip text-[10px]">{scopeLabel}</span>}
        {loading && <span className="dot-running h-1.5 w-1.5 rounded-full bg-accent" />}
        <span className="ml-auto font-mono text-[11px] text-ok" title="Lines added, every file counted, as GitHub counts them">+{totals.source.added + totals.tests.added}</span>
        <span className="font-mono text-[11px] text-bad" title="Lines removed, every file counted">−{totals.source.removed + totals.tests.removed}</span>
        {files.length > 0 && (
          <span className="chip font-mono text-[10px] text-ink-400" data-testid="diff-files">{files.length} {files.length === 1 ? 'file' : 'files'}</span>)}
        {totals.tests.files > 0 && (
          <span className="chip font-mono text-[10px] text-ink-400" title={`${totals.tests.files} test file(s), part of the total`}>
            of which tests +{totals.tests.added} −{totals.tests.removed}
          </span>)}
        {base && (scope === 'branch' || scope === 'main') && (
          <span className="chip font-mono text-[10px] text-ink-400" title="What this branch is measured against" data-testid="diff-base">
            vs {base}
          </span>)}
        {selection && (
          <button className="btn-primary py-0.5 text-[11px]" title="Send the selected lines to the chat now (⌘⏎)"
                  onClick={sendQuote}>Quote → chat</button>)}
        <button className={`chip-button ${wrap ? 'bg-white/10 text-ink-100' : ''}`} aria-label="Wrap long lines" aria-pressed={wrap}
                title="Wrap long lines to the panel's width (⌥Z)" onClick={() => patch({ wrap: !wrap })}>Wrap</button>
        <button className="icon-button" aria-label="Refresh diff" title="Fetch origin and read the diff again" onClick={() => void refresh(true)}>⟳</button>
      </div>
      {notice && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-yellow-200">
          <span className="flex-1">{notice}</span>
          <button className="underline" onClick={() => setNotice(null)}>dismiss</button>
        </div>)}

      <div className="flex min-h-0 flex-1">
        <div className="review-code relative min-w-0 flex-1">
          {failure && <div className="px-3 py-2 text-[12px] text-red-200">{failure}</div>}
          {mode === 'file' && viewing ? (
            <Editor
              key={viewing.path}
              value={fileText}
              language={languageFor(viewing.path)}
              theme="vs-dark"
              beforeMount={beforeMount}
              onMount={(editor) => {
                wireEditor(editor, (line) => line)
                if (viewing.line) { editor.revealLineInCenter(viewing.line); editor.setPosition({ lineNumber: viewing.line, column: 1 }) }
              }}
              options={editorOptions}
            />
          ) : file && sides?.path === file.path ? (
            <DiffEditor
              key={`${file.path}-${scope}-${commitSHA ?? ''}`}
              original={sides.before}
              modified={sides.after}
              language={languageFor(file.path)}
              theme="vs-dark"
              beforeMount={beforeMount}
              options={{ ...editorOptions, renderSideBySide: false, renderMarginRevertIcon: false, diffWordWrap: wrap ? 'on' : 'off' }}
              onMount={(editor) => {
                wireEditor(editor.getModifiedEditor(), toFileLine, editor)
                diffEditor.current = { path: file.path, editor: editor.getModifiedEditor() }
                revealIn(diffEditor.current, reveal)
              }}
            />
          ) : (
            <div className="grid h-full place-items-center px-4 text-center text-[12px] text-ink-500">
              {failure ? '' : nothingHere}
            </div>)}
          <div className="pointer-events-none absolute bottom-1 right-3 text-[10px] text-ink-600">{NAVIGATION_HINT}</div>

          {commentLine && shownPath && (
            <div className="absolute inset-x-3 bottom-6 rounded-lg border border-accent/40 bg-ink-850 p-2 shadow-xl">
              <div className="mb-1 font-mono text-[10px] text-ink-400">{shownPath.split('/').pop()}:{commentLine.line}</div>
              <textarea
                autoFocus rows={2} className="field resize-none text-[12px]" placeholder="What about this line?"
                value={commentBody} onChange={(event) => setCommentBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setCommentLine(null)
                  if (event.key === 'Enter' && (event.metaKey || !event.shiftKey)) { event.preventDefault(); attach() }
                }}
              />
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[10px] text-ink-400">
                  {canPostToPR
                    ? `Attach to the chat, or comment on #${pr!.number}.`
                    : 'Attaches to the chat; sent with your next message.'}
                </span>
                <button className="btn-quiet ml-auto" onClick={() => setCommentLine(null)}>Cancel</button>
                {canPostToPR && (
                  <button className="btn-quiet" disabled={!commentBody.trim() || posting}
                          title={`Post a review comment on #${pr!.number} at this line`}
                          onClick={() => postToPR(commentLine)}>{posting ? 'Posting…' : 'Comment on PR'}</button>)}
                <button className="btn-primary" disabled={!commentBody.trim()} onClick={attach}>Attach</button>
              </div>
            </div>)}
        </div>

        {panelOpen && (
          <div className="flex w-72 shrink-0 flex-col border-l border-ink-800" data-testid="review-sidebar">
            <div className="space-y-1.5 border-b border-ink-800 p-2">
              <select
                className="field w-full py-1 text-[11px]" aria-label="What to compare"
                value={commitSHA ?? scope}
                onChange={(event) => {
                  const value = event.target.value
                  if (value.startsWith('sha:')) patch({ commitSHA: value.slice(4), scope: 'commit' })
                  else patch({ commitSHA: null, scope: value })
                }}
              >
                {SCOPES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                {commits.length > 0 && (
                  <optgroup label="Commits">
                    {commits.map((commit) => (
                      <option key={commit.sha} value={`sha:${commit.sha}`}>{commit.shortSHA} {commit.subject}</option>))}
                  </optgroup>)}
              </select>
              <div className="flex items-center gap-1.5">
                <div className="flex rounded-md bg-ink-850 p-0.5" role="group" aria-label="Which files">
                  {(['changed', 'all'] as const).map((choice) => (
                    <button key={choice} aria-pressed={treeMode === choice}
                            className={`rounded px-2 py-0.5 text-[11px] ${treeMode === choice ? 'bg-ink-700 text-white' : 'text-ink-400'}`}
                            onClick={() => patch({ treeMode: choice })}>
                      {choice === 'changed' ? 'Changed' : 'All files'}
                    </button>))}
                </div>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto p-1" data-testid="file-tree"
                 style={conversationsOpen ? { flex: `0 0 ${Math.max(80, treeHeight)}px` } : { flex: '1 1 0%' }}>
              {!tree.main.length && !tree.tests.length && (
                <div className="px-2 py-3 text-[12px] text-ink-500">{treeMode === 'all' ? 'Listing…' : nothingHere}</div>)}
              <TreeRows nodes={tree.main} depth={0} folds={folds} current={shownPath} onFold={toggleFold} onPick={pick} />
              {tree.tests.length > 0 && (
                <div className="mt-3 border-t border-dashed border-ink-700 pt-1">
                  <button className="row row-idle text-[11px] text-ink-400" aria-expanded={!folds.includes('§tests')}
                          onClick={() => toggleFold('§tests')}>
                    <span className="w-3">{folds.includes('§tests') ? '▸' : '▾'}</span>
                    <span className="flex-1">Tests ({totals.tests.files} files)</span>
                    <span className="font-mono text-[10px] text-ok">+{totals.tests.added}</span>
                    <span className="font-mono text-[10px] text-bad">−{totals.tests.removed}</span>
                  </button>
                  {!folds.includes('§tests') && (
                    <TreeRows nodes={tree.tests} depth={0} folds={folds} current={shownPath} onFold={toggleFold} onPick={pick} />)}
                </div>)}
            </div>

            {conversationsOpen && (
              <div className="h-1.5 shrink-0 cursor-row-resize border-y border-ink-800 bg-ink-900 hover:bg-accent/40"
                   role="separator" aria-label="Resize conversations" aria-orientation="horizontal"
                   onMouseDown={(event) => startDrag(event, treeHeight, 1, (height) => patch({ treeHeight: Math.max(80, height) }), 'y')}
                   onDoubleClick={() => patch({ treeHeight: 260 })} />)}
            <div className={`flex min-h-0 flex-col ${conversationsOpen ? 'flex-1' : 'shrink-0'} border-t border-ink-800`}>
              <button className="row row-idle shrink-0 text-[11px] text-ink-400" aria-expanded={conversationsOpen}
                      onClick={() => patch({ conversationsOpen: !conversationsOpen })}>
                <span className="w-3">{conversationsOpen ? '▾' : '▸'}</span>
                <span className="flex-1 text-left">Conversations{threadCount === null ? '' : ` (${threadCount})`}</span>
              </button>
              {conversationsOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1" data-testid="conversations">
                  <Conversations result={conversations} branch={branch} onOpen={openThread} />
                </div>)}
            </div>
          </div>)}
      </div>
    </div>
  )
}

function TreeRows({ nodes, depth, folds, current, onFold, onPick }: {
  nodes: TreeNode[]
  depth: number
  folds: string[]
  current: string | null
  onFold: (path: string) => void
  onPick: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        const folded = folds.includes(node.path)
        const counts = (node.added > 0 || node.removed > 0) && (
          <span className="ml-auto flex gap-1 font-mono text-[10px]">
            {node.added > 0 && <span className="text-ok">+{node.added}</span>}
            {node.removed > 0 && <span className="text-bad">−{node.removed}</span>}
          </span>)
        if (node.kind === 'dir') {
          return (
            <div key={node.path}>
              <button className="row row-idle py-0.5 text-[11px] text-ink-300" style={{ paddingLeft: 6 + depth * 12 }}
                      aria-expanded={!folded} onClick={() => onFold(node.path)} data-testid="tree-dir">
                <span className="w-3 text-ink-500">{folded ? '▸' : '▾'}</span>
                <span className="truncate">{node.name}</span>
                {counts}
              </button>
              {!folded && <TreeRows nodes={node.children} depth={depth + 1} folds={folds} current={current} onFold={onFold} onPick={onPick} />}
            </div>)
        }
        const isCurrent = node.path === current
        return (
          <button key={node.path} className={`row py-0.5 ${isCurrent ? 'row-active' : 'row-idle'}`} style={{ paddingLeft: 6 + depth * 12 }}
                  aria-current={isCurrent ? 'true' : undefined} onClick={() => onPick(node.path)} data-testid="tree-file">
            <span className={`w-3 font-mono text-[10px] ${node.status === 'A' ? 'text-ok' : node.status === 'D' ? 'text-bad' : node.status ? 'text-warn' : 'text-ink-700'}`}>
              {node.status ?? '·'}
            </span>
            <span className="truncate text-[12px]">{node.name}</span>
            {counts}
          </button>)
      })}
    </>
  )
}


/** The pull request's conversations: newest work first, outdated ones keeping their own snippet. */
function Conversations({ result, branch, onOpen }: {
  result: PRConversationResult | null
  branch: string | null
  onOpen: (path: string, line: number | null) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; label: string } | null>(null)
  if (!branch) return <p className="px-2 py-2 text-[11px] text-ink-500">This worktree is not on a branch.</p>
  if (!result) return <p className="px-2 py-2 text-[11px] text-ink-500">Asking GitHub…</p>
  if (!result.ok) return <p className="px-2 py-2 text-[11px] text-ink-500">{result.message}</p>
  if (!result.threads.length) return <p className="px-2 py-2 text-[11px] text-ink-500">No comments on #{result.number} yet.</p>
  return (
    <div className="space-y-1.5">
      {result.threads.map((thread) => (
        <div key={thread.id} className="rounded-md border border-ink-800 bg-ink-900/60 p-1.5" data-testid="pr-thread">
          <div className="flex items-center gap-1.5 text-[10px]">
            {thread.path
              ? <button className="truncate font-mono text-accent hover:underline" onClick={() => onOpen(thread.path!, thread.line)}
                        title={thread.line === null ? 'Outdated: the line is gone' : `${thread.path}:${thread.line}`}>
                  {thread.path.split('/').slice(-1)[0]}{thread.line === null ? '' : `:${thread.line}`}
                </button>
              : <span className="text-ink-500">on the pull request</span>}
            {thread.outdated && <span className="chip text-[9px] text-warn">outdated</span>}
            {thread.resolved && <span className="chip text-[9px] text-ok">resolved</span>}
          </div>
          {thread.outdated && thread.snippet && (
            <pre className="mt-1 max-h-24 overflow-auto rounded bg-ink-950/60 p-1 font-mono text-[10px] text-ink-400">{thread.snippet}</pre>)}
          {thread.comments.map((comment) => (
            <div key={comment.id} className="mt-1 border-t border-ink-800/60 pt-1 first:border-0 first:pt-0"
                 onContextMenu={(event) => {
                   event.preventDefault()
                   const where = thread.path ? `, ${thread.path.split('/').pop()}${thread.line === null ? '' : `:${thread.line}`}` : ''
                   setMenu({ x: event.clientX, y: event.clientY, text: comment.body, label: `${comment.author} on #${result.number}${where}` })
                 }}>
              <div className="text-[10px] text-ink-500">{comment.author}</div>
              <div className="whitespace-pre-wrap break-words text-[11px] text-ink-200">{comment.body}</div>
            </div>))}
        </div>))}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: 'Copy', run: () => void copyText(menu.text) },
          { label: 'Quote in chat', run: () => compose(formatQuote(menu.label, menu.text)) },
        ]} />)}
    </div>
  )
}
