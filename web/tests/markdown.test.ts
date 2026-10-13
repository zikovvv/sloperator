import { describe, expect, it } from 'vitest'
import { expandWikiLinks, parseBlocks } from '../src/components/Markdown.tsx'

describe('markdown', () => {
  it('turns [[wiki-links]] into relative markdown links', () => {
    expect(expandWikiLinks('see [[foo-bar]]')).toMatch(/\[foo-bar\]\(foo-bar\.md\)/)
  })
  it('parses headings, lists, fences and tables into blocks', () => {
    const blocks = parseBlocks('# T\n\n- a\n- b\n\n```py\nx=1\n```\n\n| h |\n|---|\n| v |\n')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'bullets', 'code', 'table'])
  })
  it('does not lose a paragraph directly after a heading', () => {
    const blocks = parseBlocks('# T\nbody')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph'])
  })
})
