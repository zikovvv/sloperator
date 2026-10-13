import { useEffect, useMemo, useState } from 'react'
import { highlight } from '../lib/highlight.ts'

/**
 * Block-level Markdown. Agent output is mostly headings, lists and fenced code, and rendering
 * it as one flat string is what made the old transcript unreadable.
 */
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: Array<{ text: string; depth: number; task: boolean | null }> }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'numbers'; items: Array<{ marker: string; text: string }> }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; rows: string[][] }

/** `[[wiki-link]]` is the convention in Claude memory files. */
export function expandWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_match, name: string) =>
    `[${name}](${name.endsWith('.md') ? name : `${name}.md`})`)
}

const isBullet = (line: string) => /^[-*+] /.test(line)
const bulletDepth = (raw: string) => Math.floor(raw.match(/^\s*/)![0].length / 2)
const taskState = (text: string) => (/^\[[ xX]\] /.test(text) ? text[1] !== ' ' : null)
const stripTask = (text: string) => text.replace(/^\[[ xX]\] /, '')
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/
const numberedMarker = (line: string) => line.match(/^(\d+[.)])\s/)?.[1] ?? null
const headingLevel = (line: string) => line.match(/^(#{1,6})\s/)?.[1].length ?? null
const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim())

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      flush()
      const language = trimmed.slice(3).trim() || null
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        body.push(lines[index]); index += 1
      }
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }
    if (!trimmed) { flush(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); blocks.push({ kind: 'rule' }); continue }

    const level = headingLevel(trimmed)
    if (level) {
      flush()
      blocks.push({ kind: 'heading', level, text: trimmed.slice(level).trim() })
      continue
    }
    if (trimmed.startsWith('>')) {
      flush()
      const quoted: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoted.push(lines[index].trim().replace(/^>\s?/, '')); index += 1
      }
      index -= 1
      blocks.push({ kind: 'quote', text: quoted.join('\n') })
      continue
    }
    const image = trimmed.match(IMAGE)
    if (image) { flush(); blocks.push({ kind: 'image', alt: image[1], src: image[2] }); continue }
    if (isBullet(trimmed)) {
      flush()
      const items: Array<{ text: string; depth: number; task: boolean | null }> = []
      while (index < lines.length && isBullet(lines[index].trim())) {
        const body = lines[index].trim().slice(2)
        items.push({ text: stripTask(body), depth: bulletDepth(lines[index]), task: taskState(body) })
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'bullets', items })
      continue
    }
    if (numberedMarker(trimmed)) {
      flush()
      const items: Array<{ marker: string; text: string }> = []
      while (index < lines.length) {
        const marker = numberedMarker(lines[index].trim())
        if (!marker) break
        items.push({ marker, text: lines[index].trim().slice(marker.length).trim() })
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'numbers', items })
      continue
    }
    if (trimmed.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1]?.trim() ?? '')) {
      flush()
      const header = cells(trimmed)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(cells(lines[index].trim())); index += 1
      }
      index -= 1
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/** Inline runs: code spans, bold, italics and links, with links routed by the caller. */
function Inline({ text, onOpenFile, resolveImage }: {
  text: string; onOpenFile?: (path: string) => void; resolveImage?: (src: string) => string | null
}) {
  const parts = useMemo(() => {
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*|_[^_]+_)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>()]+)/g
    const result: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    let key = 0
    while ((match = pattern.exec(text))) {
      if (match.index > last) result.push(text.slice(last, match.index))
      const token = match[0]
      if (token.startsWith('`')) {
        result.push(
          <code key={key++} className="rounded bg-ink-800 px-1 py-px font-mono text-[12px] text-ink-100">
            {token.slice(1, -1)}
          </code>)
      } else if (token.startsWith('**')) {
        result.push(<strong key={key++} className="font-semibold text-white">{token.slice(2, -2)}</strong>)
      } else if (token.startsWith('~~')) {
        result.push(<del key={key++} className="text-ink-400">{token.slice(2, -2)}</del>)
      } else if (/^https?:/.test(token)) {
        result.push(<a key={key++} href={token} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2">{token}</a>)
      } else if (token.startsWith('![')) {
        const [, alt, source] = token.match(/!\[([^\]]*)\]\(([^)\s]+)\)/)!
        result.push(<Picture key={key++} alt={alt} source={source} resolveImage={resolveImage} inline />)
      } else if (token.startsWith('[')) {
        const [, label, href] = token.match(/\[([^\]]+)\]\(([^)]+)\)/)!
        const external = /^https?:/.test(href)
        result.push(
          <a
            key={key++}
            href={external ? href : '#'}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer' : undefined}
            onClick={external ? undefined : (event) => { event.preventDefault(); onOpenFile?.(href) }}
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >{label}</a>)
      } else {
        result.push(<em key={key++} className="italic">{token.slice(1, -1)}</em>)
      }
      last = match.index + token.length
    }
    if (last < text.length) result.push(text.slice(last))
    return result
  }, [text, onOpenFile, resolveImage])
  return <>{parts}</>
}

/**
 * A picture from the worktree shows at once. One from the web waits for a click: rendering an
 * agent's output must not make the browser call out to whatever host that output names.
 */
export function Picture({ alt, source, resolveImage, inline }: {
  alt: string; source: string; resolveImage?: (src: string) => string | null; inline?: boolean
}) {
  const remote = /^https?:/i.test(source)
  // A URL that does not parse (`https://`) is named like a missing file, never offered.
  const host = (() => { try { return new URL(source).host } catch { return '' } })()
  const [loaded, setLoaded] = useState(false)
  const src = remote ? (loaded ? source : null) : resolveImage?.(source) ?? null
  if (src) return <img src={src} alt={alt} className={`${inline ? 'my-1 ' : ''}max-h-96 rounded-md border border-ink-800`} />
  if (remote && host) {
    return (
      <button className="chip-button" title={source} onClick={() => setLoaded(true)}>
        🖼 {alt || 'image'} · load from {host}
      </button>)
  }
  return inline ? <span className="text-ink-400">🖼 {alt || source}</span> : <p className="text-ink-400">🖼 {alt || source}</p>
}

/** Copies and says so for a moment; the clipboard may be missing in a plain http page. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="icon-button" aria-label={label} title={label}
            onClick={() => {
              void navigator.clipboard?.writeText(text)?.then(() => { setDone(true); setTimeout(() => setDone(false), 1200) }).catch(() => {})
            }}>{done ? '✓' : '⧉'}</button>
  )
}

export function CodeBlock({ text, language }: { text: string; language: string | null }) {
  // Monaco colours it once it is loaded; until then (and for languages it lacks) the text stands as is.
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void highlight(text, language).then((result) => { if (live) setHtml(result) })
    return () => { live = false }
  }, [text, language])
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-ink-800 bg-ink-950/60 p-2.5">
        {html
          ? <code className="font-mono text-[12px] leading-relaxed text-ink-100" data-highlighted dangerouslySetInnerHTML={{ __html: html }} />
          : <code className="font-mono text-[12px] leading-relaxed text-ink-100">{text}</code>}
      </pre>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {language && <span className="text-[10px] text-ink-400">{language}</span>}
        <CopyButton text={text} label="Copy code" />
      </div>
    </div>
  )
}

export function Markdown({ text, onOpenFile, resolveImage }: {
  text: string
  onOpenFile?: (path: string) => void
  /** Turns a path the agent wrote into a URL the browser can load; absent, only web images show. */
  resolveImage?: (src: string) => string | null
}) {
  const blocks = useMemo(() => parseBlocks(expandWikiLinks(text)), [text])
  return (
    // A line with nowhere to break (a URL, a quoted command) wraps anyway instead of pushing out of what holds it;
    // break-words, not "anywhere", so a wide table still scrolls rather than cutting its words.
    <div className="min-w-0 space-y-2 break-words leading-relaxed">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const size = block.level <= 1 ? 'text-[16px]' : block.level === 2 ? 'text-[14px]' : 'text-[13px]'
            return (
              <div key={index} className={`${size} font-semibold text-white ${block.level <= 2 ? 'mt-3' : 'mt-2'}`}>
                <Inline text={block.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
              </div>)
          }
          case 'paragraph':
            return <p key={index}><Inline text={block.text} onOpenFile={onOpenFile} resolveImage={resolveImage} /></p>
          case 'bullets':
            return (
              <ul key={index} className="space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-2" style={{ paddingLeft: item.depth * 16 }}>
                    {item.task === null
                      ? <span className="select-none text-ink-500">{item.depth ? '◦' : '•'}</span>
                      : <input type="checkbox" readOnly checked={item.task} aria-label={item.task ? 'done' : 'to do'} className="mt-1 accent-accent" />}
                    <span className={item.task ? 'text-ink-400 line-through' : ''}><Inline text={item.text} onOpenFile={onOpenFile} resolveImage={resolveImage} /></span>
                  </li>))}
              </ul>)
          case 'image':
            return <Picture key={index} alt={block.alt} source={block.src} resolveImage={resolveImage} />
          case 'numbers':
            return (
              <ol key={index} className="space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-2">
                    <span className="select-none font-mono text-ink-500">{item.marker}</span>
                    <span><Inline text={item.text} onOpenFile={onOpenFile} resolveImage={resolveImage} /></span>
                  </li>))}
              </ol>)
          case 'quote':
            return (
              <blockquote key={index} className="border-l-2 border-ink-600 pl-3 text-ink-300">
                <Inline text={block.text} onOpenFile={onOpenFile} resolveImage={resolveImage} />
              </blockquote>)
          case 'code':
            return <CodeBlock key={index} text={block.text} language={block.language} />
          case 'rule':
            return <hr key={index} className="border-ink-800" />
          case 'table':
            return (
              <div key={index} className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>{block.header.map((cell, cellIndex) => (
                      <th key={cellIndex} className="border border-ink-800 bg-ink-850 px-2 py-1 text-left font-semibold">
                        <Inline text={cell} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                      </th>))}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="border border-ink-800 px-2 py-1 align-top">
                          <Inline text={cell} onOpenFile={onOpenFile} resolveImage={resolveImage} />
                        </td>))}</tr>))}
                  </tbody>
                </table>
              </div>)
        }
      })}
    </div>
  )
}
