import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FolderListing } from '../shared/types.ts'

/** Where the folder browser starts. */
export function browseHome(): string {
  return process.env.ORCHESTRATOR_BROWSE_HOME ?? homedir()
}

const isFolder = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * The folders inside one folder, by name, hidden ones left out; git repositories are marked. A
 * folder with thousands of entries lists its first `limit` and says how many more there are.
 * Throws when it cannot be read.
 */
export function listFolders(path: string, limit = 300): FolderListing {
  const names = readdirSync(path, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isSymbolicLink() && isFolder(join(path, entry.name)))))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const folders = names.slice(0, limit).map((name) => ({ name, path: join(path, name), isGit: existsSync(join(path, name, '.git')) }))
  return { path, parent: dirname(path) === path ? null : dirname(path), isGit: existsSync(join(path, '.git')), folders, more: names.length - folders.length }
}
