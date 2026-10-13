import { useState } from 'react'
import type { PermissionRequest, TranscriptItem } from '../../shared/types.ts'
import { api } from '../lib/api.ts'
import { reportError } from '../lib/toast.ts'
import { CodeBlock } from './Markdown.tsx'

/**
 * What Claude is waiting on: permission for a tool call, or answers to the questions it asked.
 * The card is the answering mechanism — nothing else can unblock a print-mode turn.
 */
export function PermissionCard({ item }: { item: TranscriptItem }) {
  const request = item.permission!
  return (
    <div id={`permission-${request.id}`} data-testid="permission-card"
         className={`rounded-lg border px-3 py-2 text-[12px] ${request.status === 'pending' ? 'border-warn/60 bg-warn/10' : 'border-ink-800 bg-ink-900/60'}`}>
      {request.toolName === 'AskUserQuestion'
        ? <QuestionCard request={request} />
        : <ApprovalCard request={request} />}
    </div>
  )
}

interface Question { question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }
const OTHER = '__other__'

function QuestionCard({ request }: { request: PermissionRequest }) {
  const questions: Question[] = (request.input as { questions?: Question[] } | null)?.questions ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const toggle = (question: Question, label: string) => setPicked((current) => {
    const chosen = current[question.question] ?? []
    if (!question.multiSelect) return { ...current, [question.question]: [label] }
    return { ...current, [question.question]: chosen.includes(label) ? chosen.filter((entry) => entry !== label) : [...chosen, label] }
  })
  const answerOf = (question: Question): string | string[] | null => {
    const chosen = picked[question.question] ?? []
    const labels = chosen.map((label) => (label === OTHER ? other[question.question]?.trim() ?? '' : label)).filter(Boolean)
    if (!labels.length) return null
    return question.multiSelect ? labels : labels[0]
  }
  const complete = questions.every((question) => answerOf(question) !== null)

  const send = (decision: Parameters<typeof api.answerPermission>[1]) => {
    setBusy(true)
    void api.answerPermission(request.id, decision).catch(reportError).finally(() => setBusy(false))
  }
  const submit = () => {
    const answers: Record<string, string | string[]> = {}
    for (const question of questions) answers[question.question] = answerOf(question)!
    send({ behavior: 'allow', answers })
  }

  if (request.status !== 'pending') {
    return (
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">Claude asked</div>
        {questions.map((question) => (
          <div key={question.question} className="mb-1">
            <div className="text-ink-300">{question.question}</div>
            <div className="text-ink-100">
              {request.status === 'allowed'
                ? `→ ${([] as string[]).concat(request.answers?.[question.question] ?? []).join(', ') || '—'}`
                : request.status === 'denied' ? `Declined${request.message ? `: ${request.message}` : ''}`
                : 'Nobody answered before the turn ended'}
            </div>
          </div>))}
      </div>
    )
  }
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-warn">Claude is asking you</div>
      {questions.map((question) => (
        <fieldset key={question.question} className="mb-2" aria-label={question.header ?? question.question}>
          <legend className="mb-1 text-ink-100">{question.question}</legend>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => {
              const on = (picked[question.question] ?? []).includes(option.label)
              return (
                <button key={option.label} type="button" aria-pressed={on} title={option.description}
                        className={`chip-button ${on ? 'bg-accent/30 text-ink-100 ring-accent/60' : ''}`}
                        onClick={() => toggle(question, option.label)}>{option.label}</button>)
            })}
            <button type="button" aria-pressed={(picked[question.question] ?? []).includes(OTHER)}
                    className={`chip-button ${(picked[question.question] ?? []).includes(OTHER) ? 'bg-accent/30 text-ink-100' : ''}`}
                    onClick={() => toggle(question, OTHER)}>Other…</button>
          </div>
          {(picked[question.question] ?? []).includes(OTHER) && (
            <input className="field mt-1" aria-label={`Your answer to: ${question.question}`} placeholder="Type your own answer"
                   value={other[question.question] ?? ''}
                   onChange={(event) => setOther((current) => ({ ...current, [question.question]: event.target.value }))} />)}
          {question.multiSelect && <div className="mt-0.5 text-[10px] text-ink-500">Pick any that apply.</div>}
        </fieldset>))}
      <div className="flex items-center gap-2">
        <button className="btn-primary" disabled={!complete || busy} onClick={submit}>Answer</button>
        <button className="btn-quiet" disabled={busy}
                onClick={() => send({ behavior: 'deny', message: 'The user declined to answer.' })}>Decline</button>
      </div>
    </div>
  )
}

/** One line that says what the tool would do, and the full input behind it. */
export function describeInput(toolName: string, input: unknown): { headline: string; body: { text: string; language: string | null } | null } {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '')
  const json = () => ({ text: JSON.stringify(record, null, 2), language: 'json' })
  switch (toolName) {
    case 'Bash': case 'shell':
      return { headline: str('description') || str('command').split('\n')[0], body: { text: str('command'), language: 'shell' } }
    case 'Read':
      return { headline: `${str('file_path')}${record.offset ? `:${record.offset}` : ''}${record.limit ? ` (+${record.limit} lines)` : ''}`, body: null }
    case 'Edit': case 'edit':
      return { headline: str('file_path'), body: { text: `--- old\n${str('old_string')}\n+++ new\n${str('new_string')}`, language: 'diff' } }
    case 'Write':
      return { headline: str('file_path'), body: { text: str('content'), language: null } }
    case 'Glob': case 'Grep':
      return { headline: `${str('pattern')}${str('path') ? ` in ${str('path')}` : ''}`, body: null }
    case 'Agent': case 'Task':
      return { headline: str('description') || 'subagent', body: { text: str('prompt'), language: 'markdown' } }
    case 'TodoWrite': {
      const todos = Array.isArray(record.todos) ? record.todos as Array<{ content?: string; status?: string }> : []
      return { headline: `${todos.length} todo${todos.length === 1 ? '' : 's'}`,
               body: { text: todos.map((todo) => `${todo.status === 'completed' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'} ${todo.content ?? ''}`).join('\n'), language: null } }
    }
    case 'WebFetch': return { headline: str('url'), body: str('prompt') ? { text: str('prompt'), language: null } : null }
    case 'WebSearch': return { headline: str('query'), body: null }
    case 'Skill': return { headline: `/${str('skill')}${str('args') ? ` ${str('args')}` : ''}`, body: null }
    case 'ToolSearch': return { headline: str('query'), body: null }
    case 'AskUserQuestion': {
      const questions = Array.isArray(record.questions) ? record.questions as Array<{ question?: string }> : []
      return { headline: questions.map((question) => question.question).filter(Boolean).join(' · '), body: json() }
    }
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName)
      return { headline: mcp ? `${mcp[1]} · ${mcp[2]}` : Object.values(record).find((value) => typeof value === 'string') as string ?? '', body: json() }
    }
  }
}

function ApprovalCard({ request }: { request: PermissionRequest }) {
  const [reason, setReason] = useState('')
  const [denying, setDenying] = useState(false)
  const [busy, setBusy] = useState(false)
  const { headline, body } = describeInput(request.toolName, request.input)
  const send = (decision: Parameters<typeof api.answerPermission>[1]) => {
    setBusy(true)
    void api.answerPermission(request.id, decision).catch(reportError).finally(() => setBusy(false))
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-[10px] uppercase tracking-wide ${request.status === 'pending' ? 'text-warn' : 'text-ink-500'}`}>
          {request.status === 'pending' ? 'Claude wants to run' : 'Claude asked to run'}
        </span>
        <span className="font-mono text-[11px] text-ink-200">{request.toolName}</span>
        {headline && <span className="truncate font-mono text-[11px] text-ink-400" title={headline}>{headline}</span>}
      </div>
      {body && body.text && <CodeBlock text={body.text} language={body.language} />}
      {request.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => send({ behavior: 'allow' })}>Allow</button>
          {denying
            ? <>
                <input className="field flex-1" aria-label="Why not" placeholder="Tell Claude why, or what to do instead" autoFocus
                       value={reason} onChange={(event) => setReason(event.target.value)}
                       onKeyDown={(event) => { if (event.key === 'Enter') send({ behavior: 'deny', message: reason }) }} />
                <button className="btn-danger" disabled={busy} onClick={() => send({ behavior: 'deny', message: reason })}>Deny</button>
              </>
            : <button className="btn-quiet" disabled={busy} onClick={() => setDenying(true)}>Deny…</button>}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-ink-400">
          {request.status === 'allowed' ? 'Allowed' : request.status === 'denied' ? `Denied${request.message ? ` — ${request.message}` : ''}` : 'Nobody answered before the turn ended'}
        </div>
      )}
    </div>
  )
}
