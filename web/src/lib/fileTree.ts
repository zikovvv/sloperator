import { isTestPath } from '../../shared/testPaths.ts'

export interface TreeFile { path: string; status: string | null; added: number; removed: number }

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  status: string | null
  added: number
  removed: number
  children: TreeNode[]
}

/**
 * Files as a folder tree, every folder carrying the sum of what changed beneath it, so a folder
 * row says "+120 −8" before it is opened. Folders first, then files, both alphabetical.
 */
export function buildTree(files: TreeFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', status: null, added: 0, removed: 0, children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join('/')
      let next = node.children.find((child) => child.kind === 'dir' && child.path === path)
      if (!next) {
        next = { name: parts[index], path, kind: 'dir', status: null, added: 0, removed: 0, children: [] }
        node.children.push(next)
      }
      next.added += file.added; next.removed += file.removed
      node = next
    }
    node.children.push({ name: parts[parts.length - 1], path: file.path, kind: 'file', status: file.status, added: file.added, removed: file.removed, children: [] })
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    node.children.forEach(sort)
  }
  sort(root)
  return root.children
}

/** The changed files with their tests set apart, the way the diff list reads them. */
export function splitTests(files: TreeFile[]) {
  return { source: files.filter((file) => !isTestPath(file.path)), tests: files.filter((file) => isTestPath(file.path)) }
}

/** Folders on the way to a file, so the tree can be opened down to it. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'))
}
