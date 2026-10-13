import { expect, type Page } from '@playwright/test'

export const API = 'http://127.0.0.1:8797'

export async function state(page: Page) {
  return page.evaluate(async () => (await fetch('/api/state')).json())
}

/**
 * Opens the ⋯ menu of the sidebar row whose text contains `label`, clicks `item`. The innermost
 * container that holds both the text and a Row actions button is the row itself.
 */
export async function rowMenu(page: Page, label: string, item: string) {
  const rows = page.locator('nav div').filter({ hasText: label }).filter({ has: page.getByRole('button', { name: 'Row actions' }) })
  const row = rows.last()
  await row.getByRole('button', { name: 'Row actions' }).first().click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function confirmDialog(page: Page, button = 'Delete') {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: button }).click()
  await expect(dialog).toBeHidden()
}

export async function collectCoverage(page: Page) {
  const coverage = await page.evaluate(() => (window as any).__coverage__ ?? null)
  if (!coverage) return
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync('.nyc_output', { recursive: true })
  writeFileSync(`.nyc_output/${Date.now()}-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(coverage))
}

/** The project header's ⋯ menu: the first Row actions button in the sidebar belongs to it. */
export async function projectMenu(page: Page, item: string) {
  await page.locator('nav').getByRole('button', { name: 'Row actions' }).first().click()
  await page.getByRole('menuitem', { name: item }).click()
}

/** Loads the app and waits until the sidebar has real data. */
export async function open(page: Page) {
  await page.goto('/')
  // Panel widths, folds and the review toggle live in localStorage: every spec starts from the defaults.
  await page.evaluate(() => { try { localStorage.clear() } catch { /* blocked */ } })
  await page.reload()
  await expect(page.locator('nav')).toContainText(/main\s*\(/)
}

/** Clicks the main worktree's + and waits until the NEW chat is the one on screen. */
export async function openFreshSession(page: Page) {
  const before = (await state(page)).sessions.length
  // The main checkout's row carries the ⌂ glyph; its + is the one we want whatever the folder order.
  const mainRow = page.locator('nav div.row').filter({ hasText: '⌂' }).first()
  await mainRow.getByRole('button', { name: 'New session', exact: true }).click()
  await expect.poll(async () => (await state(page)).sessions.length).toBe(before + 1)
  await expect(page.getByText('Session ready')).toBeVisible()
  await expect(page.getByPlaceholder(/Message the agent/)).toBeVisible()
  // A new session inherits the previous one's settings; the specs assume the fake claude.
  await page.getByRole('combobox', { name: 'Engine' }).selectOption('claude')
  await page.getByRole('group', { name: 'Steering' }).getByRole('button', { name: /Queue/ }).click()
}

/**
 * Every spec file starts from the same world: one project, its main worktree with two dirty
 * files, no sessions, no extra folders. Specs share one server, so this is what keeps them
 * independent of each other.
 */
export async function resetState(page: Page) {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const repo = process.env.E2E_REPO!
  await page.goto('/')
  const current = await state(page)
  for (const project of current.projects) {
    await page.evaluate(async (id) => { await fetch(`/api/project/${id}`, { method: 'DELETE' }) }, project.id)
  }
  for (const worktree of execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')) {
    const path = /^worktree (.*)$/.exec(worktree)?.[1]
    if (path && path !== repo) { try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path]) } catch { /* gone */ } }
  }
  execFileSync('git', ['-C', repo, 'worktree', 'prune'])
  for (const branch of execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n')) {
    if (/^orch\//.test(branch)) { try { execFileSync('git', ['-C', repo, 'branch', '-D', branch]) } catch { /* in use */ } }
  }
  execFileSync('git', ['-C', repo, 'checkout', '-q', '--', '.'])
  // The throwaway Claude home is edited by some specs; put its seed text back.
  writeFileSync(join(process.env.E2E_STATE_DIR!, 'claude-home', 'CLAUDE.md'),
    '# Global rules for the e2e run\n\nSee [[e2e-memory]] and [local notes](notes.md).\n\n- one\n- two\n\n```sh\necho hi\n```\n')
  writeFileSync(join(repo, 'src', 'app.py'), 'def greet(name):\n    return "hi " + name\n')
  writeFileSync(join(repo, 'tests', 'test_app.py'), 'def test_greet(): assert True\n')
  // One changed line deep in a long file, so a diff row and a file line are not the same number.
  writeFileSync(join(repo, 'src', 'long.py'),
    Array.from({ length: 30 }, (_, index) => (index === 24 ? 'line_25 = 250' : `line_${index + 1} = ${index + 1}`)).join('\n') + '\n')
  await page.evaluate(async (path) => { await fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }) }, repo)
  await page.goto('/')
  await expect(page.locator('nav')).toContainText(/main\s*\(1\)/)
}

/** Unfolds the main checkout so its session rows are reachable (one-session worktrees stay folded). */
export async function expandMain(page: Page) {
  const chevron = page.locator('nav div.row').filter({ hasText: '⌂' }).first()
    .getByRole('button', { name: 'Expand worktree' })
  if (await chevron.count()) await chevron.click()
}
