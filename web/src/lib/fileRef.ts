/** A file as chat text refers to it: "a.py", "a.py:12", "a.py:12-20", "a.py:12:3", "a.py#L12", "a.py#L12-L20". */
export function parseFileRef(ref: string): { path: string; line?: number } {
  const hash = /^(.+?)#L(\d+)(?:-L?\d+)?$/.exec(ref)
  if (hash) return { path: hash[1], line: Number(hash[2]) }
  const colon = /^(.+?):(\d+)(?:[-:]\d+)*$/.exec(ref)
  if (colon) return { path: colon[1], line: Number(colon[2]) }
  return { path: ref }
}

/**
 * The changed file a reference means: the same path, the one an absolute path ends with (whatever
 * checkout it was written against), or the only one that ends with it (a bare file name).
 */
export function matchChanged(path: string, changed: string[]): string | null {
  const clean = path.replace(/^\.\//, '')
  if (changed.includes(clean)) return clean
  const tails = changed.filter((file) => clean.endsWith(`/${file}`)).sort((a, b) => b.length - a.length)
  if (tails.length) return tails[0]
  const endings = changed.filter((file) => file.endsWith(`/${clean}`))
  return endings.length === 1 ? endings[0] : null
}

/** A path as this worktree holds it: relative ones under it, and ones written against another checkout of the project moved onto it. */
export function inWorktree(path: string, worktree: string, otherCheckouts: string[]): string {
  if (!path.startsWith('/')) return `${worktree}/${path.replace(/^\.\//, '')}`
  if (path.startsWith(`${worktree}/`)) return path
  const root = otherCheckouts.filter((checkout) => path.startsWith(`${checkout}/`)).sort((a, b) => b.length - a.length)[0]
  return root ? `${worktree}${path.slice(root.length)}` : path
}
