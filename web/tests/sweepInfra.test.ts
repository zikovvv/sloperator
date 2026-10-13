import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeHome, infraItems, skillCatalog } from '../server/infra.ts'

let home = ''
let project = ''
const saved = process.env.ORCHESTRATOR_CLAUDE_HOME

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-claude-home-'))
  process.env.ORCHESTRATOR_CLAUDE_HOME = home
  const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  write(join(home, 'skills/named/SKILL.md'), '---\nname: Named Skill\n---\nbody\n')          // a name, no description
  mkdirSync(join(home, 'skills/broken/SKILL.md'), { recursive: true })                          // a folder where a file should be
  mkdirSync(join(home, 'skills/empty'), { recursive: true })                                     // no SKILL.md at all
  write(join(home, 'skills/plain.txt'), 'not a skill')
  write(join(home, 'skills/dup/SKILL.md'), '---\nname: shared\ndescription: global copy\n---\n')
  write(join(home, 'plugins/one/two/three/four/five/six/seven/skills/deep/SKILL.md'), '---\nname: deep\n---\n')   // beyond reach
  write(join(home, 'plugins/near/skills/close/SKILL.md'), '---\nname: close\ndescription: A plugin skill.\nversion: 2\n---\n')
  write(join(home, 'plugins/bare/skills/nameless/SKILL.md'), '---\n---\nno front matter to speak of\n')
  write(join(home, 'plugins/stray.txt'), 'a file among folders')
  symlinkSync('/nowhere/plugin', join(home, 'plugins/ghost'))
  write(join(home, 'settings.json'), '{}')
  write(join(home, 'hooks/run.sh'), 'echo hi\n')
  mkdirSync(join(home, 'hooks/folder'), { recursive: true })
  symlinkSync('/nowhere/hook', join(home, 'hooks/dangling'))
  write(join(home, 'projects/-w-a/memory/MEMORY.md'), '- index\n')
  write(join(home, 'projects/-w-a/memory/thing.md'), '---\ndescription: a fact\n---\n')
  write(join(home, 'projects/-w-b/memory/notes.txt'), 'not markdown')
  project = mkdtempSync(join(tmpdir(), 'orch-proj-'))
  write(join(project, '.claude/skills/dup/SKILL.md'), '---\nname: shared\ndescription: project copy\n---\n')
  write(join(project, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }))
})
afterAll(() => { process.env.ORCHESTRATOR_CLAUDE_HOME = saved })

describe('the Claude config tree', () => {
  it('falls back to the real ~/.claude when no folder is pinned', () => {
    delete process.env.ORCHESTRATOR_CLAUDE_HOME
    try { expect(claudeHome()).toBe(join(homedir(), '.claude')) } finally { process.env.ORCHESTRATOR_CLAUDE_HOME = home }
  })

  it('lists skills by their front matter, skips what is not a skill, and lets a project shadow a global one', () => {
    const catalog = skillCatalog([project])
    const names = catalog.map((entry) => `${entry.source}:${entry.name}`)
    expect(names).toContain('global:Named Skill')
    expect(names).toContain('global:broken')             // unreadable front matter: named after its folder
    expect(names).toContain('plugin:close')
    expect(names).toContain('plugin:nameless')          // empty front matter: named after its folder
    expect(names).not.toContain('plugin:deep')            // too far down to look
    expect(names).not.toContain('global:empty')
    expect(catalog.filter((entry) => entry.name === 'shared')).toEqual([expect.objectContaining({ source: 'project', description: 'project copy' })])
    expect(catalog.find((entry) => entry.name === 'Named Skill')?.description).toBe('')
  })

  it('reads hooks and memories, leaving out what is not a file or not markdown', () => {
    const hooks = infraItems('hooks', [{ name: 'proj', path: project }])
    expect(hooks.find((item) => item.title === 'Global settings.json')?.subtitle).toBe('No hooks')
    expect(hooks.find((item) => item.group === 'proj')?.subtitle).toBe('Hooks: PreToolUse, Stop')
    expect(hooks.filter((item) => item.group === 'Hook scripts').map((item) => item.title)).toEqual(['run.sh'])
    const memories = infraItems('memories', [])
    expect(memories.map((item) => item.title)).toEqual(['MEMORY.md (index)', 'thing.md'])
    expect(memories[1].subtitle).toBe('a fact')
    expect(memories.every((item) => item.group === '/w/a')).toBe(true)
  })
})
