import type { LayerResult } from '../shared/types.ts'
import { currentBranch, gitResult } from './git.ts'
import { createPullRequest, failureText, openPullRequestFor } from './github.ts'

/** One layer as the stack operations need it: where it is checked out, and its branch there now. */
export interface Layer { id: string; path: string; title: string }

async function branchOf(layer: Layer): Promise<string> {
  const branch = await currentBranch(layer.path)
  if (!branch || branch === 'HEAD') throw new Error(`${layer.title} is not on a branch`)
  return branch
}

/** Pushes a layer that tracks a remote, so its pull request shows what was merged; nothing for one that does not. */
async function pushIfTracked(path: string): Promise<string> {
  const upstream = await gitResult(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstream.ok) return ''
  const pushed = await gitResult(path, ['push', '--quiet'])
  return pushed.ok ? ', pushed' : `, but the push failed: ${pushed.stderr.trim()}`
}

/**
 * Brings each layer up to date with the one below it, bottom to top. `bottomFrom`, when given, is
 * merged into the bottom layer first (the stack's base, after the layer below was landed). Stops
 * at the first layer that cannot be merged cleanly and leaves it as it was.
 */
export async function updateLayers(layers: Layer[], bottomFrom?: string): Promise<LayerResult[]> {
  const results: LayerResult[] = []
  const steps: Array<{ layer: Layer; from: string }> = []
  if (bottomFrom && layers.length) steps.push({ layer: layers[0], from: bottomFrom })
  for (let index = 1; index < layers.length; index += 1) steps.push({ layer: layers[index], from: await branchOf(layers[index - 1]) })
  for (const { layer, from } of steps) {
    const branch = await branchOf(layer)
    const merged = await gitResult(layer.path, ['merge', '--no-edit', from])
    if (merged.ok) {
      const upToDate = /Already up to date/i.test(merged.stdout)
      results.push({ worktreeID: layer.id, branch, status: upToDate ? 'up-to-date' : 'merged',
                     message: upToDate ? `already has ${from}` : `merged ${from}${await pushIfTracked(layer.path)}` })
      continue
    }
    const conflicted = (await gitResult(layer.path, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean)
    if (conflicted.length) {
      await gitResult(layer.path, ['merge', '--abort'])
      results.push({ worktreeID: layer.id, branch, status: 'conflict',
                     message: `${from} conflicts in ${conflicted.join(', ')}; left as it was` })
    } else {
      results.push({ worktreeID: layer.id, branch, status: 'failed', message: `${merged.stderr}${merged.stdout}`.trim() })
    }
    break
  }
  return results
}

/** Pushes every layer and opens a draft pull request for each that has none, based on the layer below. */
export async function openStackPRs(projectPath: string, base: string, layers: Layer[]): Promise<LayerResult[]> {
  const results: LayerResult[] = []
  let parent = base
  for (const [index, layer] of layers.entries()) {
    const branch = await branchOf(layer)
    try {
      const pushed = await gitResult(layer.path, ['push', '--quiet', '-u', 'origin', branch])
      if (!pushed.ok) throw Object.assign(new Error('push failed'), { stderr: pushed.stderr })
      const existing = await openPullRequestFor(projectPath, branch)
      if (existing) {
        results.push({ worktreeID: layer.id, branch, status: 'exists', message: `#${existing.number} is already open`, url: existing.url })
      } else {
        const url = await createPullRequest(projectPath, { base: parent, head: branch, title: layer.title,
          body: `Layer ${index + 1} of ${layers.length} in a stack; based on \`${parent}\`.` })
        results.push({ worktreeID: layer.id, branch, status: 'created', message: `opened on ${parent}`, url })
      }
    } catch (error) {
      results.push({ worktreeID: layer.id, branch, status: 'failed', message: failureText(error) })
      break   // every layer above builds on this one
    }
    parent = branch
  }
  return results
}
