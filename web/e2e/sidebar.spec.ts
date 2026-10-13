import { test, expect } from '@playwright/test'
import { rowMenu, projectMenu, confirmDialog, state, collectCoverage, resetState, open, openFreshSession, expandMain } from './helpers.ts'

// Per test, not per file: a leftover worktree or session from the previous test used to
// decide whether this one passed.
test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('the project, its main folder and main worktree render, and the app lands on a session', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('nav')).toContainText(/main\s*\(1\)/)
  await expect(page.locator('nav button[aria-expanded]').filter({ hasText: 'main' })).toBeVisible()
  // Lands somewhere useful without a click: a session if one exists, else the main worktree's page.
  // A fresh state has no session yet: the main worktree offers to open its first one.
  await expect(page.getByRole('button', { name: /^Open / }).or(page.getByPlaceholder(/Message the agent/))).toBeVisible()
})

test('folders fold and unfold and show their counts', async ({ page }) => {
  await page.goto('/')
  const fold = page.locator('nav button[aria-expanded]').filter({ hasText: 'main' })
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('nav').getByRole('button', { name: /New session/ })).toHaveCount(0)
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
})

test('add group directory, then remove it while empty; main is never removable', async ({ page }) => {
  await page.goto('/')
  await projectMenu(page, 'Add group directory…')
  await page.getByRole('dialog', { name: /New group/ }).getByRole('textbox').fill('review')
  await page.getByRole('dialog', { name: /New group/ }).getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('nav')).toContainText(/review\s*\(0\)/)
  await expect(page.locator('nav button[aria-label="Remove empty group"]')).toHaveCount(1)
  await page.locator('nav button[aria-label="Remove empty group"]').click()
  await expect(page.locator('nav')).not.toContainText(/review\s*\(/)
})

test('one-click new session, rename it through the dialog, pin, archive and restore, delete', async ({ page }) => {
  await page.goto('/')
  const before = (await state(page)).sessions.length
  await page.locator('nav').getByRole('button', { name: 'New session', exact: true }).first().click()
  await expect.poll(async () => (await state(page)).sessions.length).toBe(before + 1)
  await expandMain(page)   // its one session is folded away until asked for

  await rowMenu(page, 'New session', 'Rename…')
  const rename = page.getByRole('dialog', { name: /Rename session/ })
  await rename.getByRole('textbox').fill('Renamed by test')
  await rename.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('nav')).toContainText('Renamed by test')

  await rowMenu(page, 'Renamed by test', 'Pin to top')
  await expect(page.locator('nav').getByTitle('Pinned').or(page.locator('nav').getByText('▲')).first()).toBeVisible()

  await rowMenu(page, 'Renamed by test', 'Archive')
  await expect(page.locator('nav')).toContainText('Archived sessions (1)')
  await page.locator('nav summary').filter({ hasText: 'Archived sessions' }).click()
  await page.locator('nav').getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('nav')).not.toContainText('Archived sessions')

  await rowMenu(page, 'Renamed by test', 'Delete session')
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.method() === 'DELETE' && candidate.url().includes('/api/session/')),
    confirmDialog(page, 'Delete'),
  ])
  expect(request.method()).toBe('DELETE')
  await expect(page.locator('nav')).not.toContainText('Renamed by test')
})

test('new worktree dialog: branch search, named after the branch, a chat opens', async ({ page }) => {
  await page.goto('/')
  // The + button is the no-questions path now; the full dialog lives in the project menu.
  await projectMenu(page, 'New worktree…')
  const dialog = page.getByRole('dialog', { name: 'New worktree' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Existing branch' }).click()
  await dialog.getByRole('button', { name: /Choose a branch/ }).click()
  await dialog.getByPlaceholder(/Search \d+ branches/).fill('flogin')
  await dialog.getByRole('button', { name: 'feature/login' }).click()
  await expect(dialog.getByPlaceholder(/feature\/login \(from the branch\)/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Create and open chat' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('nav')).toContainText('feature/login')
  await expect(page.getByPlaceholder(/Message the agent/)).toBeVisible()
  const worktree = (await state(page)).worktrees.find((entry: any) => entry.name === 'feature/login')
  expect(worktree.group).toBe('main')
})

test('quick worktree from the menu, move it to another folder, delete it from the menu (branch kept)', async ({ page }) => {
  await page.goto('/')
  await projectMenu(page, 'Add group directory…')
  await page.getByRole('dialog', { name: /New group/ }).getByRole('textbox').fill('work')
  await page.getByRole('dialog', { name: /New group/ }).getByRole('button', { name: 'OK' }).click()
  await projectMenu(page, 'Quick worktree (auto branch, no questions)')
  await expect.poll(async () => (await state(page)).worktrees.filter((entry: any) => !entry.isMain).length).toBeGreaterThan(0)
  const quick = (await state(page)).worktrees.filter((entry: any) => !entry.isMain).at(-1)!
  await rowMenu(page, quick.name, 'Move to work')
  await expect.poll(async () => (await state(page)).worktrees.find((entry: any) => entry.id === quick.id)?.group).toBe('work')
  await rowMenu(page, quick.name, 'Delete worktree…')
  await expect(page.getByRole('alertdialog')).toContainText('is NOT deleted')
  await confirmDialog(page, 'Delete')
  await expect.poll(async () => (await state(page)).worktrees.some((entry: any) => entry.id === quick.id)).toBe(false)
  await page.locator('nav button[aria-label="Remove empty group"]').click()
})

test('a worktree opens its first session; its panel renames, opens a terminal, archives, restores and deletes it', async ({ page }) => {
  await page.goto('/')
  await projectMenu(page, 'Quick worktree (auto branch, no questions)')
  const quick = await (async () => {
    // A quick worktree is named after its generated branch, so take the newest non-main one.
    await expect.poll(async () => (await state(page)).worktrees.filter((entry: any) => !entry.isMain).length).toBeGreaterThan(0)
    return (await state(page)).worktrees.filter((entry: any) => !entry.isMain).at(-1)
  })()
  await page.locator('nav').getByText(quick.name, { exact: true }).click()
  await expect(page.getByPlaceholder(/Message the agent/)).toBeVisible()   // straight into its first session
  const setup = page.getByTestId('worktree-setup')
  // A fresh worktree's panel starts open; a used one starts folded. Either way the fields must be there.
  await setup.getByRole('button', { name: 'Worktree…' }).click()   // it opens only when asked for
  const name = page.getByLabel('Worktree name')
  await expect(name).toBeVisible()
  await name.fill('page-renamed'); await name.press('Enter')
  await expect.poll(async () => (await state(page)).worktrees.find((entry: any) => entry.id === quick.id)?.name).toBe('page-renamed')
  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  await expect(page.getByRole('tablist', { name: 'Terminals' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide terminal' }).click()
  await setup.getByRole('button', { name: 'Archive' }).click()
  await expect(page.locator('nav')).toContainText('Archived worktrees (1)')
  await page.locator('nav summary').filter({ hasText: 'Archived worktrees' }).click()
  await page.locator('nav').getByRole('button', { name: 'Restore' }).click()
  await page.locator('nav [title="page-renamed"]').click()   // the row is titled by its work; the name is its tooltip
  await expect(page.getByPlaceholder(/Message the agent/)).toBeVisible()
  if (!(await setup.getByRole('button', { name: 'Delete worktree' }).count())) await setup.getByRole('button', { name: 'Worktree…' }).click()
  await expect(setup.getByRole('button', { name: 'Delete worktree' })).toBeVisible()
  await setup.getByRole('button', { name: 'Delete worktree' }).click()
  await confirmDialog(page, 'Delete')
  await expect.poll(async () => (await state(page)).worktrees.some((entry: any) => entry.id === quick.id)).toBe(false)
})

test('add project dialog rejects a missing folder with a toast, not a native alert', async ({ page }) => {
  await page.goto('/')
  let nativeDialogs = 0
  page.on('dialog', (dialog) => { nativeDialogs += 1; void dialog.dismiss() })
  await page.getByRole('button', { name: '+ Add project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add project' })
  await dialog.getByRole('textbox').fill('/definitely/not/here')
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.getByRole('status')).toContainText(/No such folder/)
  expect(nativeDialogs).toBe(0)
})

test('a worktree folds shut over its sessions from its chevron, stays folded across a reload, and opens again', async ({ page }) => {
  await open(page)
  // Two sessions: a worktree holding only one stays folded on purpose.
  await openFreshSession(page)
  await openFreshSession(page)
  const sessions = page.locator('nav div.row.pl-9')
  await expect(sessions.first()).toBeVisible()
  const mainRow = () => page.locator('nav div.row').filter({ hasText: '⌂' }).first()
  await mainRow().getByRole('button', { name: 'Collapse worktree' }).click()
  await expect(sessions).toHaveCount(0)
  await page.reload()
  await expect(page.locator('nav')).toContainText(/main\s*\(/)
  await expect(page.locator('nav div.row.pl-9')).toHaveCount(0)   // the fold outlives the page, even for the open worktree
  await mainRow().getByRole('button', { name: 'Expand worktree' }).click()
  await expect(page.locator('nav div.row.pl-9').first()).toBeVisible()
})

test('a worktree with a single session stays folded when you open it; the chat is what you get', async ({ page }) => {
  await open(page)
  await openFreshSession(page)                       // the main checkout now holds exactly one session
  await expect(page.getByText('Session ready')).toBeVisible()
  await expect(page.locator('nav div.row.pl-9')).toHaveCount(0)
  const mainRow = () => page.locator('nav div.row').filter({ hasText: '⌂' }).first()
  await expect(mainRow().getByRole('button', { name: 'Expand worktree' })).toBeVisible()
  // A second session gives it something to choose between, so it unfolds.
  await openFreshSession(page)
  await expect(page.locator('nav div.row.pl-9').first()).toBeVisible()
})
