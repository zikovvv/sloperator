import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'

/** ~/.claude, or a throwaway tree when tests say so: the real one is never touched by a test. */
export function claudeHome(): string {
  return process.env.ORCHESTRATOR_CLAUDE_HOME ?? join(homedir(), '.claude')
}
import { join, dirname, basename } from 'node:path'

export type InfraCategory = 'claudemd' | 'memories' | 'hooks' | 'skills' | 'agents' | 'commands'

export interface InfraItem {
  title: string
  subtitle: string
  path: string
  group: string
}


function frontmatter(path: string): { name?: string; description?: string } {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').slice(0, 60)
    if (lines[0]?.trim() !== '---') return {}
    const result: { name?: string; description?: string } = {}
    for (const line of lines.slice(1)) {
      if (line.trim() === '---') break
      if (line.startsWith('name:')) result.name = line.slice(5).trim()
      else if (line.startsWith('description:')) result.description = line.slice(12).trim()
    }
    return result
  } catch {
    return {}
  }
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/^["' ]+|["' ]+$/g, '')
  const dot = cleaned.indexOf('.')
  return dot > 20 ? cleaned.slice(0, dot + 1) : cleaned.slice(0, 160)
}

function listDir(path: string): string[] {
  try { return readdirSync(path).sort() } catch { return [] }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** Every skill, command and agent this machine has, global first then per project. */
export function skillCatalog(projectPaths: string[]) {
  const items: Array<{ name: string; description: string; path: string; kind: string; source: string }> = []

  const addSkills = (root: string, source: string) => {
    for (const entry of listDir(root)) {
      const file = join(root, entry, 'SKILL.md')
      if (!existsSync(file)) continue
      const meta = frontmatter(file)
      items.push({
        name: meta.name ?? entry, description: firstSentence(meta.description ?? ''),
        path: file, kind: 'skill', source,
      })
    }
  }
  const addMarkdownDir = (root: string, kind: string, source: string) => {
    for (const entry of listDir(root)) {
      if (!entry.endsWith('.md')) continue
      const file = join(root, entry)
      const meta = frontmatter(file)
      items.push({
        name: meta.name ?? entry.replace(/\.md$/, ''),
        description: firstSentence(meta.description ?? ''),
        path: file, kind, source,
      })
    }
  }

  addSkills(join(claudeHome(), 'skills'), 'global')
  addMarkdownDir(join(claudeHome(), 'commands'), 'command', 'global')
  addMarkdownDir(join(claudeHome(), 'agents'), 'agent', 'global')
  for (const project of projectPaths) {
    addSkills(join(project, '.claude/skills'), 'project')
    addMarkdownDir(join(project, '.claude/commands'), 'command', 'project')
    addMarkdownDir(join(project, '.claude/agents'), 'agent', 'project')
  }

  // Plugin skills live a few levels down; only look for skills/<name>/SKILL.md.
  const pluginRoot = join(claudeHome(), 'plugins')
  const walk = (directory: string, depth: number) => {
    if (depth > 5) return
    for (const entry of listDir(directory)) {
      const path = join(directory, entry)
      let stats
      try { stats = statSync(path) } catch { continue }
      if (!stats.isDirectory()) continue
      const skill = join(path, 'SKILL.md')
      if (basename(dirname(path)) === 'skills' && existsSync(skill)) {
        const meta = frontmatter(skill)
        items.push({
          name: meta.name ?? entry, description: firstSentence(meta.description ?? ''),
          path: skill, kind: 'skill', source: 'plugin',
        })
      } else walk(path, depth + 1)
    }
  }
  walk(pluginRoot, 0)

  const seen = new Set<string>()
  const priority = ['project', 'global', 'plugin']
  const ordered: typeof items = []
  for (const source of priority) {
    for (const item of items.filter((candidate) => candidate.source === source)) {
      const key = `${item.kind}|${item.name}`
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push(item)
    }
  }
  return ordered.sort((a, b) => a.name.localeCompare(b.name))
}

function hooksSummary(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const keys = Object.keys(parsed.hooks ?? {})
    return keys.length ? `Hooks: ${keys.sort().join(', ')}` : 'No hooks'
  } catch {
    return 'No hooks'
  }
}

export function infraItems(category: InfraCategory, projects: Array<{ name: string; path: string }>): InfraItem[] {
  const items: InfraItem[] = []
  const push = (path: string, title: string, subtitle: string, group: string) => {
    if (existsSync(path)) items.push({ title, subtitle, path, group })
  }

  switch (category) {
    case 'claudemd': {
      push(join(claudeHome(), 'CLAUDE.md'), 'Global CLAUDE.md', 'Applies to every project', 'Global')
      for (const project of projects) {
        push(join(project.path, 'CLAUDE.md'), 'CLAUDE.md', project.path, project.name)
        push(join(project.path, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'Not committed', project.name)
      }
      break
    }
    case 'memories': {
      const root = join(claudeHome(), 'projects')
      for (const slug of listDir(root)) {
        const memoryDir = join(root, slug, 'memory')
        const files = listDir(memoryDir).filter((file) => file.endsWith('.md'))
        if (!files.length) continue
        for (const file of files) {
          const path = join(memoryDir, file)
          const meta = frontmatter(path)
          items.push({
            title: file === 'MEMORY.md' ? 'MEMORY.md (index)' : file,
            subtitle: meta.description ?? '',
            path,
            group: slug.replace(/^-/, '/').replace(/-/g, '/'),
          })
        }
      }
      break
    }
    case 'hooks': {
      push(join(claudeHome(), 'settings.json'), 'Global settings.json',
           hooksSummary(join(claudeHome(), 'settings.json')), 'Global')
      for (const project of projects) {
        const path = join(project.path, '.claude/settings.json')
        push(path, 'settings.json', hooksSummary(path), project.name)
      }
      const hookScripts = join(claudeHome(), 'hooks')
      for (const file of listDir(hookScripts)) {
        const path = join(hookScripts, file)
        if (isFile(path)) items.push({ title: file, subtitle: 'Hook script', path, group: 'Hook scripts' })
      }
      break
    }
    case 'skills':
    case 'agents':
    case 'commands': {
      const wanted = category === 'skills' ? 'skill' : category === 'agents' ? 'agent' : 'command'
      for (const entry of skillCatalog(projects.map((project) => project.path))) {
        if (entry.kind !== wanted) continue
        items.push({
          title: entry.name, subtitle: entry.description, path: entry.path,
          group: entry.source[0].toUpperCase() + entry.source.slice(1),
        })
      }
      break
    }
  }
  return items
}

export function readInfraFile(path: string) {
  const stats = statSync(path)
  return { text: readFileSync(path, 'utf8'), modified: stats.mtimeMs }
}

/** Refuses if the file changed since it was read, rather than clobbering an agent's edit. */
export function writeInfraFile(path: string, text: string, knownModified?: number) {
  if (knownModified != null && existsSync(path)) {
    const current = statSync(path).mtimeMs
    if (current > knownModified + 1) {
      throw new Error(`${basename(path)} changed on disk since you opened it. Reload before saving.`)
    }
  }
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
  return statSync(path).mtimeMs
}
