import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session, TranscriptItem } from '../../shared/types.ts'
import { CodeBlock, CopyButton, Markdown } from './Markdown.tsx'
import { describeInput, PermissionCard } from './PermissionCard.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { ActivityPanel } from './ActivityPanel.tsx'
import { appendQuote, formatQuote } from '../lib/quote.ts'
import { copyText } from '../lib/clipboard.ts'
import { api } from '../lib/api.ts'
import { useVoice } from '../lib/useVoice.ts'
import type { LogDensity } from '../lib/density.ts'
import { quiet } from '../lib/quiet.ts'

export interface ReviewComment {
  id: string
  file: string
  line: number
  snippet: string
  body: string
}

interface Props {
  session: Session
  items: TranscriptItem[]
  running: boolean
  skills: Array<{ name: string; description: string; kind: string }>
  comments: ReviewComment[]
  onRemoveComment: (id: string) => void
  onClearComments: () => void
  onOpenFile: (path: string) => void
  density: LogDensity
  /** Picks a failed turn back up. */
  onContinue: () => void
  /** Opens a terminal running the engine's own login, for a turn that failed because its login did. */
  onSignIn?: () => void
  /** A path the agent wrote (absolute, or relative to the worktree) as a URL an <img> can load. */
  resolveImage?: (src: string) => string | null
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

/** How a quote names where it came from. */
export function quoteLabel(item: TranscriptItem, part: string | null): string {
  switch (item.role) {
    case 'user': return 'you said earlier'
    case 'assistant': return item.engine === 'codex' ? 'Codex said' : 'Claude said'
    case 'thinking': return "Claude's thinking"
    case 'tool': return `${item.toolName ?? 'tool'} ${part === 'output' ? 'output' : 'call'}`
    default: return 'from this session'
  }
}

/** One line per tool call, the way the Claude app shows it: what ran, not the whole command. */
function toolSummary(item: TranscriptItem): string {
  const name = item.toolName ?? 'tool'
  const first = (item.toolInput !== undefined ? describeInput(name, item.toolInput).headline : item.text).split('\n')[0]
  // A bare command shows its verb; a described one (or any other tool) shows what it was asked.
  if (/^(bash|shell)$/i.test(name) && first === item.text.split('\n')[0]) {
    const verb = first.trim().split(/\s+/)[0]
    return `${verb || 'command'} …`
  }
  if (/^(read|edit|write|multiedit)$/i.test(name)) return first.split('/').slice(-2).join('/')
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

/**
 * A turn is everything between one of your messages and the answer that closes it. Inside it,
 * a step is a line the agent said followed by the tools and thinking it did next. Compact view
 * folds each step's tools; ubercompact folds the whole turn once the answer is in.
 */
export interface Step { lead: TranscriptItem | null; work: TranscriptItem[] }
/** What a turn is made of, in the order it happened: steps of work, and notes (errors, info lines). */
export type Block = { kind: 'step'; step: Step } | { kind: 'note'; item: TranscriptItem }
export interface Turn { user: TranscriptItem | null; blocks: Block[]; answer: TranscriptItem | null; after: Block[] }

export function groupTurns(items: TranscriptItem[], running: boolean): Turn[] {
  const turns: Turn[] = []
  let turn: Turn = { user: null, blocks: [], answer: null, after: [] }
  let step: Step | null = null
  const closeStep = () => { if (step) { turn.blocks.push({ kind: 'step', step }); step = null } }
  const closeTurn = () => { closeStep(); if (turn.user || turn.blocks.length) turns.push(turn); turn = { user: null, blocks: [], answer: null, after: [] } }
  for (const item of items) {
    if (item.role === 'user') { closeTurn(); turn.user = item; continue }
    if (item.role === 'assistant') { closeStep(); step = { lead: item, work: [] }; continue }
    if (item.role === 'tool' || item.role === 'thinking') {
      if (!step) step = { lead: null, work: [] }
      step.work.push(item)
      continue
    }
    closeStep(); turn.blocks.push({ kind: 'note', item })   // errors and info lines keep their place
  }
  closeTurn()
  // A turn's answer is the agent's last line once nothing runs after it and no more work follows;
  // earlier lines are the agent talking to itself between tool calls. Notes that came after the
  // answer (a cost line, a later failure) stay after it.
  turns.forEach((entry, index) => {
    const settled = index < turns.length - 1 || !running
    const at = entry.blocks.map((block) => block.kind).lastIndexOf('step')
    const last = at === -1 ? null : (entry.blocks[at] as { kind: 'step'; step: Step }).step
    if (last?.lead && !last.work.length && settled) {
      entry.answer = last.lead
      entry.after = entry.blocks.slice(at + 1)
      entry.blocks = entry.blocks.slice(0, at)
    }
  })
  return turns
}

export const stepsOf = (turn: Turn): Step[] => turn.blocks.flatMap((block) => (block.kind === 'step' ? [block.step] : []))

const toolWord = (item: TranscriptItem) => item.toolName ?? 'tool'

/** What a folded step says about itself: what it ran last, or what it ran altogether. */
export function stepSummary(step: Step, live: boolean): string {
  const tools = step.work.filter((item) => item.role === 'tool')
  if (!tools.length) return live ? 'thinking…' : 'thought'
  if (live) return `${toolWord(tools[tools.length - 1])} ${toolSummary(tools[tools.length - 1])}`
  const names = [...new Set(tools.map(toolWord))]
  return `${tools.length} tool call${tools.length === 1 ? '' : 's'} · ${names.join(', ')}`
}

function FoldedStep({ step, live, density, onOpenFile, resolveImage }: {
  step: Step; live: boolean; density: LogDensity; onOpenFile: (path: string) => void; resolveImage?: (src: string) => string | null
}) {
  const [open, setOpen] = useState(false)
  const failed = step.work.some((item) => item.toolOutput?.startsWith('⚠️'))
  return (
    <div className="my-1">
      {step.lead && (
        <div className="text-[12px] text-ink-300" data-quote-item={step.lead.id}>
          <Markdown text={step.lead.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
        </div>)}
      {step.work.length > 0 && (
        <button className={`mt-1 flex items-center gap-2 text-[11px] ${failed ? 'text-warn' : 'text-ink-400'} hover:text-ink-200`}
                onClick={() => setOpen((value) => !value)} aria-expanded={open} data-testid="step-fold">
          <span className="text-ink-600">{open ? '▾' : '▸'}</span>
          {live && !open && <span className="dot-running h-1.5 w-1.5 rounded-full bg-ok" />}
          <span className={live && !open ? 'shimmer' : ''}>{stepSummary(step, live && !open)}</span>
        </button>)}
      {open && (
        <div className="ml-4 mt-1 space-y-1">
          {step.work.map((item) => item.role === 'thinking'
            ? <details key={item.id} className="text-ink-400" data-quote-item={item.id}><summary className="cursor-pointer text-[11px]">Thinking</summary><div className="whitespace-pre-wrap pt-1 text-[12px]">{item.text}</div></details>
            : <ToolRow key={item.id} item={item} onOpenFile={onOpenFile} expanded={density === 'verbose'} />)}
        </div>)}
    </div>
  )
}

/** A whole turn's work behind one line, once its answer has arrived. */
function FoldedTurn({ turn, density, onOpenFile, resolveImage, onContinue, onSignIn, running }: {
  turn: Turn; density: LogDensity; onOpenFile: (path: string) => void; resolveImage?: (src: string) => string | null
  onContinue: () => void; onSignIn?: () => void; running: boolean
}) {
  const [open, setOpen] = useState(false)
  const steps = stepsOf(turn)
  const tools = steps.reduce((total, step) => total + step.work.filter((item) => item.role === 'tool').length, 0)
  return (
    <div className="my-1">
      <button className="flex items-center gap-2 text-[11px] text-ink-400 hover:text-ink-200"
              onClick={() => setOpen((value) => !value)} aria-expanded={open} data-testid="turn-fold">
        <span className="text-ink-600">{open ? '▾' : '▸'}</span>
        <span>Worked in {steps.length} step{steps.length === 1 ? '' : 's'} · {tools} tool call{tools === 1 ? '' : 's'}</span>
      </button>
      {open && <div className="ml-4"><Blocks turn={turn} live={false} density={density} onOpenFile={onOpenFile} resolveImage={resolveImage} onContinue={onContinue} onSignIn={onSignIn} running={running} /></div>}
    </div>
  )
}

/** A turn's steps and notes in the order they happened; only the last step of a running turn is live. */
function Blocks({ turn, live, density, onOpenFile, resolveImage, onContinue, onSignIn, running }: {
  turn: Turn; live: boolean; density: LogDensity; onOpenFile: (path: string) => void; resolveImage?: (src: string) => string | null
  onContinue: () => void; onSignIn?: () => void; running: boolean
}) {
  const lastStep = turn.blocks.map((block) => block.kind).lastIndexOf('step')
  return (
    <>
      {turn.blocks.map((block, index) => block.kind === 'note'
        ? (block.item.role === 'error'
            ? <ErrorItem key={block.item.id} item={block.item} running={running} onContinue={onContinue} onSignIn={onSignIn} />
            : block.item.role === 'permission' && block.item.permission
              ? <PermissionCard key={block.item.id} item={block.item} />
              : <div key={block.item.id} className="text-center text-[11px] text-ink-500">{block.item.text}</div>)
        : <FoldedStep key={block.step.lead?.id ?? block.step.work[0].id} step={block.step}
                      live={live && index === lastStep}
                      density={density} onOpenFile={onOpenFile} resolveImage={resolveImage} />)}
    </>
  )
}

function ToolRow({ item, onOpenFile, expanded }: {
  item: TranscriptItem; onOpenFile: (path: string) => void; expanded?: boolean
}) {
  const [open, setOpen] = useState(!!expanded)
  const failed = item.toolOutput?.startsWith('⚠️')
  const isShell = /^(bash|shell)$/i.test(item.toolName ?? '')
  // Older transcripts carry only the summary text; newer ones carry the tool's input itself.
  const described = item.toolInput !== undefined ? describeInput(item.toolName ?? 'tool', item.toolInput) : null
  const headline = described?.headline || item.text
  const detail = described?.body && described.body.text ? described.body : (isShell ? { text: item.text, language: 'shell' } : null)
  const looksLikePath = /^[\w./~-]+\/[\w./-]+$/.test(headline.split('\n')[0])

  return (
    <div className="rounded-md border border-ink-800/80 bg-ink-900/40" data-quote-item={item.id}>
      <button
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`mt-px font-mono text-[10px] ${failed ? 'text-warn' : 'text-ink-400'}`}>
          {item.toolName ?? 'tool'}
        </span>
        {looksLikePath ? (
          <span
            role="link"
            tabIndex={0}
            className="flex-1 truncate font-mono text-[11px] text-accent hover:underline"
            onClick={(event) => { event.stopPropagation(); onOpenFile(headline.split('\n')[0]) }}
            onKeyDown={(event) => event.key === 'Enter' && onOpenFile(headline.split('\n')[0])}
          >{headline}</span>
        ) : (
          <span className={`flex-1 whitespace-pre-wrap break-words font-mono text-[11px] text-ink-300 ${open ? '' : 'line-clamp-3'}`}>
            {open && detail ? '' : headline}
          </span>
        )}
        <span className="text-[10px] text-ink-500">{open ? '−' : '+'}</span>
      </button>
      {open && detail && (
        <div className="border-t border-ink-800 px-2 py-1.5">
          <CodeBlock text={detail.text} language={detail.language} />
        </div>)}
      {open && item.toolOutput && (
        <div className="group relative border-t border-ink-800">
          <pre className="max-h-96 overflow-auto px-2 py-1.5 font-mono text-[11px] text-ink-300" data-quote-part="output">{item.toolOutput}</pre>
          <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <CopyButton text={item.toolOutput} label="Copy output" />
          </div>
        </div>
      )}
    </div>
  )
}

const CONNECTION_FAILURE = new RegExp([
  'fetch failed', 'ECONN\\w*', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'socket hang up',
  'network', 'timed? out', 'overloaded', 'rate.?limit', 'api error', 'unauthorized',
  '\\b(401|429|50[234])\\b',
].join('|'), 'i')

/** Whether a failure reads as the API or the connection, rather than the agent's own doing. */
export function isConnectionFailure(text: string): boolean {
  return CONNECTION_FAILURE.test(text)
}

const AUTH_FAILURE = /authenticat|oauth|revoked|expired|not logged in|log ?in|\b401\b/i

/** Whether a failure reads as the engine's login having lapsed, which only signing in again fixes. */
export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text)
}

function ErrorItem({ item, running, onContinue, onSignIn }: {
  item: TranscriptItem; running: boolean; onContinue: () => void; onSignIn?: () => void
}) {
  const signedOut = !!onSignIn && isAuthFailure(item.text)
  return (
    <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-red-200">
      <div className="whitespace-pre-wrap">{item.text}</div>
      {item.canRetry && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {signedOut && (
            <button className="btn-primary py-0.5 text-[11px]" title="Opens a terminal running the engine's login; finish it in the browser"
                    onClick={onSignIn}>Sign in again</button>)}
          <button className={`${signedOut ? 'chip-button' : 'btn-primary'} py-0.5 text-[11px]`} disabled={running}
                  title="Send your last message again; the engine resumes this conversation"
                  onClick={onContinue}>Continue</button>
          <span className="text-[11px] text-red-200/70">
            {signedOut
              ? 'The login was revoked or has expired. Sign in again, then Continue.'
              : isConnectionFailure(item.text)
                ? 'The engine could not be reached. Continue when the connection is back.'
                : 'The turn did not finish.'}
          </span>
        </div>)}
    </div>
  )
}

export function Chat({
  session, items, running, skills, comments, onRemoveComment, onClearComments, onOpenFile, density,
  onContinue, onSignIn, resolveImage,
}: Props) {
  const [draft, setDraft] = useState('')
  const draftLoaded = useRef(false)
  const [hintIndex, setHintIndex] = useState(0)
  const [pinned, setPinned] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; label: string } | null>(null)
  const voice = useVoice((text) => setDraft((current) => (current ? `${current} ${text}` : text)))

  /** Puts a quote under the draft and leaves the caret after it, ready for the words that go with it. */
  const caretToEnd = useRef(false)
  const insertQuote = (quote: string) => {
    caretToEnd.current = true
    setDraft((current) => appendQuote(current, quote))
  }
  // The review panel and the PR conversations quote through this; they have no hand on the draft.
  useEffect(() => {
    const onCompose = (event: Event) => insertQuote((event as CustomEvent<{ text: string }>).detail.text)
    window.addEventListener('orchestrator:compose', onCompose)
    return () => window.removeEventListener('orchestrator:compose', onCompose)
  }, [])

  /** Right-click on selected text, or on a message, offers to copy it or quote it in the next message. */
  const onContextMenu = (event: React.MouseEvent) => {
    const selection = window.getSelection()
    const selected = selection && !selection.isCollapsed && logRef.current?.contains(selection.anchorNode) ? selection.toString() : ''
    const target = event.target as HTMLElement
    const origin = selected
      ? (selection!.anchorNode instanceof Element ? selection!.anchorNode : selection!.anchorNode?.parentElement)
      : target
    const holder = origin?.closest<HTMLElement>('[data-quote-item]')
    const item = holder ? items.find((entry) => entry.id === holder.dataset.quoteItem) : undefined
    const part = origin?.closest<HTMLElement>('[data-quote-part]')?.dataset.quotePart ?? null
    // The output part is only on screen when there is an output.
    const text = selected || (item ? (part === 'output' ? item.toolOutput! : item.text) : '')
    if (!text.trim()) return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, text, label: item ? quoteLabel(item, part) : 'from this session' })
  }

  // The draft belongs to the session, not to this mount: it survives switching away and quitting.
  useEffect(() => {
    void api.draft(session.id)
      .then((stored) => { if (stored.text) setDraft(stored.text) })
      .catch(quiet)
      .finally(() => { draftLoaded.current = true })
  }, [session.id])

  useEffect(() => {
    const dictate = () => voice.toggle()
    window.addEventListener('orchestrator:dictate', dictate)
    return () => window.removeEventListener('orchestrator:dictate', dictate)
  }, [voice])

  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => {
    if (!draftLoaded.current) return
    const timer = setTimeout(() => void api.saveDraft(session.id, draft).catch(quiet), 400)
    return () => clearTimeout(timer)
  }, [draft, session.id])
  // Leaving the session mid-sentence must not lose the sentence.
  useEffect(() => () => {
    if (draftLoaded.current) void api.saveDraft(session.id, latestDraft.current).catch(quiet)
  }, [session.id])

  // Only follow the tail when the reader is already there.
  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items.length, pinned])

  useEffect(() => { inputRef.current?.focus() }, [session.id])

  // The box grows with the text and shrinks back when it goes — including when the draft is cleared
  // on send or replaced by a skill, neither of which fires an input event. With nothing in it the
  // inline height is dropped entirely, so the one-line height comes from CSS and cannot be a stale
  // measurement left over from a big paste.
  useEffect(() => {
    const box = inputRef.current!
    if (!draft) { box.style.height = ''; return }
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, 208)}px`
    if (caretToEnd.current) {
      caretToEnd.current = false
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    }
  }, [draft])

  const slashQuery = useMemo(() => {
    const match = draft.match(/(?:^|\s)\/([\w-]*)$/)
    return match ? match[1] : null
  }, [draft])

  const matches = useMemo(() => {
    if (slashQuery == null) return []
    const query = slashQuery.toLowerCase()
    return skills
      .filter((skill) => skill.kind !== 'agent')
      .filter((skill) => !query || skill.name.toLowerCase().includes(query))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)))
      .slice(0, 6)
  }, [skills, slashQuery])

  const applySkill = (name: string) => {
    setDraft((current) => current.replace(/\/[\w-]*$/, `/${name} `))
    setHintIndex(0)
    inputRef.current?.focus()
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void api.send(session.id, text, comments)
    onClearComments()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setHintIndex((i) => Math.min(i + 1, matches.length - 1)); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setHintIndex((i) => Math.max(i - 1, 0)); return }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault(); applySkill(matches[hintIndex].name); return
      }
      if (event.key === 'Escape') { setDraft((current) => current.replace(/\/[\w-]*$/, '')); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
  }

  const quickStarts = skills.slice(0, 12)
  const pending = items.filter((item) => item.role === 'permission' && item.permission?.status === 'pending')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onContextMenu={onContextMenu}
        onScroll={(event) => {
          const element = event.currentTarget
          setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 60)
        }}
      >
        <div className="mx-auto max-w-3xl space-y-3">
          {!items.length && (
            <div className="space-y-3 pt-2">
              <div>
                <div className="text-[14px] font-semibold text-white">Session ready</div>
                <p className="text-ink-400">
                  CLAUDE.md is picked up natively by both engines. ⏎ sends · ⇧⏎ newline ·
                  <span className="font-mono"> / </span>skills · ⌘K for everything else.
                </p>
              </div>
              {!!quickStarts.length && (
                <div>
                  <div className="label mb-1.5">Quick start</div>
                  <div className="flex flex-wrap gap-1.5">
                    {quickStarts.map((skill) => (
                      <button
                        key={skill.name}
                        className="chip-button"
                        title={skill.description}
                        onClick={() => {
                          setDraft(skill.kind === 'agent' ? `Use the ${skill.name} subagent: ` : `/${skill.name} `)
                          inputRef.current?.focus()
                        }}
                      >{skill.kind === 'agent' ? skill.name : `/${skill.name}`}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {(density === 'compact' || density === 'ubercompact') ? groupTurns(items, running).map((turn, turnIndex, turns) => {
            const isLast = turnIndex === turns.length - 1
            const waiting = turn.blocks.some((block) => block.kind === 'note' && block.item.permission?.status === 'pending')
            const foldAll = density === 'ubercompact' && !!turn.answer && stepsOf(turn).length > 0 && !waiting
            return (
              <div key={turn.user?.id ?? turn.answer?.id ?? turnIndex} className="space-y-2">
                {turn.user && (
                  <div className="flex justify-end">
                    <div className="min-w-0 max-w-[85%] rounded-lg rounded-br-sm bg-accent/20 px-3 py-2 ring-1 ring-inset ring-accent/30" data-quote-item={turn.user.id}>
                      <Markdown text={turn.user.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                    </div>
                  </div>)}
                {foldAll
                  ? <FoldedTurn turn={turn} density={density} onOpenFile={onOpenFile} resolveImage={resolveImage} onContinue={onContinue} onSignIn={onSignIn} running={running} />
                  : <Blocks turn={turn} live={isLast && running} density={density} onOpenFile={onOpenFile} resolveImage={resolveImage} onContinue={onContinue} onSignIn={onSignIn} running={running} />}
                {turn.answer && (
                  <div className="space-y-1" data-quote-item={turn.answer.id}>
                    <div className="flex items-center gap-2 text-[10px] text-ink-500">
                      <span className={turn.answer.engine === 'claude' ? 'text-orange-400' : 'text-teal-400'}>
                        {turn.answer.engine === 'codex' ? 'Codex' : 'Claude'}
                      </span>
                      <span>{relativeTime(turn.answer.timestamp)}</span>
                    </div>
                    <Markdown text={turn.answer.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                  </div>)}
                {turn.after.length > 0 && (
                  <Blocks turn={{ ...turn, blocks: turn.after }} live={false} density={density} onOpenFile={onOpenFile} resolveImage={resolveImage} onContinue={onContinue} onSignIn={onSignIn} running={running} />)}
              </div>)
          }) : items.map((item, index) => {
            if (item.role === 'user') {
              return (
                <div key={item.id} className="flex justify-end">
                  <div className="min-w-0 max-w-[85%] rounded-lg rounded-br-sm bg-accent/20 px-3 py-2 ring-1 ring-inset ring-accent/30" data-quote-item={item.id}>
                    <Markdown text={item.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                  </div>
                </div>)
            }
            if (item.role === 'assistant') {
              return (
                <div key={item.id} className="space-y-1" data-quote-item={item.id}>
                  <div className="flex items-center gap-2 text-[10px] text-ink-500">
                    <span className={item.engine === 'claude' ? 'text-orange-400' : 'text-teal-400'}>
                      {item.engine === 'codex' ? 'Codex' : 'Claude'}
                    </span>
                    <span>{relativeTime(item.timestamp)}</span>
                  </div>
                  <Markdown text={item.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                </div>)
            }
            if (item.role === 'tool') {
              return <ToolRow key={item.id} item={item} onOpenFile={onOpenFile} expanded={density === 'verbose'} />
            }
            if (item.role === 'thinking') {
              return (
                <details key={item.id} className="text-ink-400" data-quote-item={item.id}>
                  <summary className="cursor-pointer text-[11px]">Thinking</summary>
                  <div className="whitespace-pre-wrap pt-1 text-[12px]">{item.text}</div>
                </details>)
            }
            if (item.role === 'error') return <ErrorItem key={item.id} item={item} running={running} onContinue={onContinue} onSignIn={onSignIn} />
            if (item.role === 'permission' && item.permission) return <PermissionCard key={item.id} item={item} />
            return <div key={item.id} className="text-center text-[11px] text-ink-500">{item.text}</div>
          })}

          {running && (
            <div className="flex items-center gap-2 text-[12px] text-ink-400">
              <span className="dot-running h-1.5 w-1.5 rounded-full bg-ok" />
              {session.engine === 'codex' ? 'Codex' : 'Claude'} is working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <ActivityPanel sessionID={session.id} running={running} />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: 'Copy', run: () => void copyText(menu.text) },
          { label: 'Quote in next message', run: () => insertQuote(formatQuote(menu.label, menu.text)) },
        ]} />)}
      {pending.length > 0 && (
        <div className="border-t border-warn/40 bg-warn/10 px-4 py-1.5" data-testid="waiting-strip">
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-[12px] text-yellow-100">
            <span className="dot-running h-1.5 w-1.5 rounded-full bg-warn" />
            <span className="flex-1">
              {`${pending[0].engine === 'codex' ? 'Codex' : 'Claude'} is waiting for ${pending.length === 1 ? 'your answer' : `${pending.length} answers`}`}
            </span>
            <button className="chip-button" onClick={() => document.getElementById(`permission-${pending[0].permission!.id}`)?.scrollIntoView({ block: 'center' })}>
              Show
            </button>
          </div>
        </div>)}
      {!!comments.length && (
        <div className="border-t border-accent/30 bg-accent/10 px-4 py-1.5">
          <div className="mx-auto max-w-3xl space-y-1">
            {comments.map((comment) => (
              <div key={comment.id} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-ink-300">
                  {comment.file.split('/').pop()}:{comment.line}
                </span>
                <span className="flex-1 truncate">{comment.body}</span>
                <button className="icon-button" aria-label="Remove comment"
                        onClick={() => onRemoveComment(comment.id)}>×</button>
              </div>))}
            <div className="text-[10px] text-ink-400">Attached to your next message — ⏎ to send.</div>
          </div>
        </div>
      )}

      {!!matches.length && (
        <div className="border-t border-ink-800 bg-ink-900/95 px-4 py-1">
          <div role="listbox" aria-label="Skills" className="mx-auto max-w-3xl">
            {matches.map((skill, index) => (
              <button
                key={skill.name}
                role="option"
                aria-selected={index === hintIndex}
                className={`row ${index === hintIndex ? 'row-active' : 'row-idle'}`}
                onMouseEnter={() => setHintIndex(index)}
                onClick={() => applySkill(skill.name)}
              >
                <span className="font-mono text-[12px]">/{skill.name}</span>
                <span className="flex-1 truncate text-[11px] text-ink-400">{skill.description}</span>
              </button>))}
          </div>
        </div>
      )}

      <div className="border-t border-ink-800 bg-ink-900 px-4 py-2.5">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            autoFocus
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={running
              ? (session.steeringMode === 'steer'
                  ? 'Steer the running turn…' : 'Queue for when it finishes…')
              : 'Message the agent…   ⏎ send · ⇧⏎ newline · / skills'}
            aria-label="Message"
            className="field max-h-52 min-h-[38px] flex-1 resize-none"
          />
          <button
            className={`icon-button h-9 w-9 ${voice.state === 'recording' ? 'bg-bad/25 text-red-300' : ''}`}
            title={voice.state === 'unavailable' ? (voice.hint ?? 'Voice unavailable') : 'Dictate (⌘⇧V)'}
            aria-label="Dictate"
            disabled={voice.state === 'unavailable'}
            onClick={voice.toggle}
          >{voice.state === 'transcribing' ? '…' : '🎙'}</button>
          {running && (
            <button className="btn-quiet h-9" onClick={() => void api.stop(session.id)} title="Stop (⌘.)">
              Stop
            </button>)}
          <button className="btn-primary h-9" onClick={submit} disabled={!draft.trim()}>Send</button>
        </div>
      </div>
    </div>
  )
}
