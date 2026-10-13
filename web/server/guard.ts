import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * A localhost service is reachable by any page the user visits: DNS rebinding makes an attacker
 * origin resolve to 127.0.0.1, and WebSockets are exempt from the same-origin policy entirely.
 * So every request must prove it came from this app, and every path must stay inside a root the
 * user actually registered.
 */
/**
 * The hostname is the whole defence: rebinding needs an attacker-owned name, and that is what is
 * refused. The port is deliberately not checked — dev servers and test runners proxy from their
 * own ports, and a port check only ever locked those out.
 */
export function hostIsLocal(host: string | undefined, _port?: number): boolean {
  if (!host) return false
  const match = /^(.*?)(?::(\d+))?$/.exec(host)
  if (!match) return false
  const name = match[1].toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

export function originIsAllowed(origin: string | undefined, _port?: number): boolean {
  if (!origin) return true          // curl, same-origin fetch in some browsers, Electron file://
  if (origin === 'null') return false
  try {
    const name = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return name === 'localhost' || name === '127.0.0.1' || name === '::1'
  } catch {
    return false
  }
}

/**
 * Browsers label every request with where it came from: an <img>, a script or a link on another
 * site carries no Origin but does say `cross-site`. curl, Electron and same-origin fetches never do.
 */
export function fetchSiteIsAllowed(site: string | undefined): boolean {
  return site !== 'cross-site'
}

/** True when `candidate` is inside one of `roots`, following symlinks on both sides. */
export function isInsideAny(candidate: string, roots: string[]): boolean {
  const real = (path: string) => {
    try { return realpathSync(path) } catch { return resolve(path) }
  }
  // A file being created does not exist yet, nor perhaps its folder: resolve the nearest
  // ancestor that does exist and append the rest, so symlinked roots still match.
  const realTarget = (path: string): string => {
    const absolute = resolve(path)
    const missing: string[] = []
    let cursor = absolute
    for (;;) {
      try { return join(realpathSync(cursor), ...missing.reverse()) } catch { /* keep climbing */ }
      const parent = dirname(cursor)
      missing.push(basename(cursor))
      cursor = parent
    }
  }
  const target = realTarget(candidate)
  return roots.some((root) => {
    const base = real(root)
    return target === base || target.startsWith(`${base}/`)
  })
}

/** Roots the UI is allowed to read and write: the Claude config tree and registered projects. */
export function allowedRoots(projectPaths: string[], worktreePaths: string[]): string[] {
  // The same tree the Infra tab reads from; tests point both at a throwaway one.
  const claude = process.env.ORCHESTRATOR_CLAUDE_HOME ?? join(homedir(), '.claude')
  return [claude, ...projectPaths, ...worktreePaths]
}

