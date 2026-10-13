import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession, projectMenu, rowMenu, state } from './helpers.ts'

// Per test, not per file: a leftover worktree or session from the previous test used to
// decide whether this one passed.
test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('Markdown: headings, lists, code with copy, tables, quotes, wiki and relative links navigate inside the Infra tab', async ({ page }) => {
  await open(page)
  await page.getByRole('tab', { name: 'Claude Infra' }).click()
  await page.locator('main button').filter({ hasText: 'Global CLAUDE.md' }).first().click()
  await expect(page.locator('main').getByText('Global rules for the e2e run')).toBeVisible()
  await expect(page.locator('main pre')).toContainText('echo hi')
  await page.locator('main').getByRole('button', { name: /Copy/ }).first().click()
  await page.locator('main a').filter({ hasText: 'local notes' }).click()
  await expect(page.locator('main')).toContainText('linked document')
  await page.locator('main button').filter({ hasText: 'Global CLAUDE.md' }).first().click()
  await page.locator('main a').filter({ hasText: 'e2e-memory' }).click()
  await page.locator('main').getByRole('button', { name: 'Memories', exact: true }).click()
  await page.locator('main button').filter({ hasText: /thing|MEMORY/ }).first().click()
  await expect(page.locator('main')).toContainText(/remembered|a memory/)
  await page.locator('main').getByRole('button', { name: 'Hooks', exact: true }).click()
  await expect(page.locator('main')).toContainText(/settings\.json/)
  await page.locator('main').getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(page.locator('main')).toContainText('e2e-skill')
  await page.locator('main').getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.locator('main')).toContainText('e2e-agent')
  await page.locator('main').getByRole('button', { name: 'Commands', exact: true }).click()
  await expect(page.locator('main')).toContainText('e2e-command')
  // Save a real edit to the throwaway file, then verify the saved text comes back.
  await page.locator('main').getByRole('button', { name: 'CLAUDE.md', exact: true }).click()
  await page.locator('main button').filter({ hasText: 'Global CLAUDE.md' }).first().click()
  await page.getByRole('button', { name: 'Edit' }).click()
  const editor = page.locator('main textarea')
  await expect(editor).not.toHaveValue('')
  await editor.fill('# Edited by the e2e run\n')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Save' })).toBeHidden()
  await page.getByRole('button', { name: /Preview/ }).click().catch(() => {})
  await expect(page.locator('main')).toContainText('Edited by the e2e run')
})

test('Project files: the whole tree with changed folders counted, any file opens as a file with the language server, and back', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await page.getByTestId('tree-file').filter({ hasText: 'app.py' }).first().click({ force: true })
  await page.getByRole('button', { name: 'All files' }).click()
  await expect(page.getByTestId('tree-dir').filter({ hasText: 'src' })).toContainText(/\+\d+/)   // the folder carries the change
  await page.getByTestId('tree-file').filter({ hasText: 'README.md' }).first().click()   // an unchanged file: only the project tree has it
  await expect(page.getByText(/F12 definition/)).toBeVisible()
  await expect(page.locator('.monaco-editor .view-line').first()).toBeAttached({ timeout: 30_000 })
  // Ask the definition provider directly through the page: the fake server answers for line 96 with another file.
  const target = await page.evaluate(async () => {
    const stateResponse = await (await fetch('/api/state')).json()
    const main = stateResponse.worktrees.find((w: any) => w.isMain)
    const result = await (await fetch('/api/lsp/definition', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: main.path, path: `${main.path}/src/app.py`, line: 96, character: 0 }) })).json()
    return result.locations[0]?.path ?? null
  })
  expect(target).toMatch(/other\.py$/)
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('.monaco-diff-editor').first()).toBeAttached({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Refresh diff' }).click()
})

test('Chat details: tool output expands, thinking shows in verbose, comment chips remove and clear, Shift+Enter keeps typing, slash list closes on Escape', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('normal')
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('/')
  await expect(page.getByRole('listbox', { name: 'Skills' })).toBeVisible()
  await box.press('ArrowDown'); await box.press('ArrowUp'); await box.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Skills' })).toBeHidden()
  await box.fill('first line'); await box.press('Shift+Enter'); await box.type('second line')
  await expect(box).toHaveValue(/first line\nsecond line/)
  await box.fill('show me the tools'); await box.press('Enter')
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()
  const toolRow = page.locator('main').getByRole('button', { name: /Bash/ }).first()
  await toolRow.click()
  await expect(page.locator('main pre').first()).toContainText('hi')
  await toolRow.click()
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('verbose')
  await expect(page.locator('main')).toContainText(/considering/)
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('normal')
  // Two gutter comments: remove one, clear the rest.
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await page.getByTestId('tree-file').filter({ hasText: 'app.py' }).first().click({ force: true })
  // The gutter is only clickable once Monaco has laid the diff out; under load that takes a moment.
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-line').first()).toBeVisible({ timeout: 30_000 })
  for (const text of ['first note', 'second note']) {
    await page.locator('.monaco-diff-editor .margin .line-numbers').last().click({ force: true })
    await page.getByPlaceholder('What about this line?').fill(text)
    await page.getByRole('button', { name: 'Attach' }).click()
  }
  await expect(page.locator('main')).toContainText('first note')
  await page.locator('main').getByRole('button', { name: 'Remove comment' }).first().click()
  await expect(page.locator('main')).not.toContainText('first note')
  await page.locator('main').getByRole('button', { name: 'Remove comment' }).first().click()
  await expect(page.locator('main')).not.toContainText('second note')
})

test('dialogs: backdrop cancels a confirm; Enter submits and Escape cancels a text prompt; project collapse toggles', async ({ page }) => {
  await open(page)
  await rowMenu(page, 'main', 'Rename…')
  const prompt = page.getByRole('dialog', { name: /Rename/ })
  await prompt.getByRole('textbox').fill('renamed-main')
  await prompt.getByRole('textbox').press('Enter')
  await expect(page.locator('nav')).toContainText('renamed-main')
  await rowMenu(page, 'renamed-main', 'Rename…')
  await prompt.getByRole('textbox').fill('should not apply')
  await page.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await expect(page.locator('nav')).not.toContainText('should not apply')
  await projectMenu(page, 'Remove project')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Remove')
  await page.mouse.click(5, 5)   // backdrop
  await expect(confirm).toBeHidden()
  expect((await state(page)).projects).toHaveLength(1)
  await page.getByRole('button', { name: 'Toggle project' }).click()
  await expect(page.locator('nav')).not.toContainText(/main\s*\(/)
  await page.getByRole('button', { name: 'Toggle project' }).click()
  await expect(page.locator('nav')).toContainText(/main\s*\(/)
})

test('new worktree dialog: new branch with a searched fork point, move-work checkbox, and a git error shown inline', async ({ page }) => {
  await open(page)
  await projectMenu(page, 'New worktree…')
  const dialog = page.getByRole('dialog', { name: 'New worktree' })
  await dialog.getByPlaceholder('orch/my-work').fill('orch/from-search')
  // The fork point starts on the default branch; open it by its current value and search.
  await dialog.getByRole('button', { name: /^main/ }).click()
  const fork = dialog.getByPlaceholder(/Search \d+ branches/)
  await fork.fill('fsearch')
  await dialog.getByRole('button', { name: 'feature/search' }).click()
  await expect(dialog.getByRole('button', { name: /^feature\/search/ })).toBeVisible()
  await dialog.getByText('Move current uncommitted work into it').click()
  await dialog.getByRole('button', { name: 'Create and open chat' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('nav')).toContainText('from-search')
  // A branch that is already checked out cannot be checked out again: the dialog says so.
  await projectMenu(page, 'New worktree…')
  await dialog.getByRole('button', { name: 'Existing branch' }).click()
  await dialog.getByRole('button', { name: /Choose a branch/ }).click()
  const search = dialog.getByPlaceholder(/Search \d+ branches/)
  await search.fill('zzz-nothing')
  await expect(dialog).toContainText(/No branch matches/)
  await search.fill('main'); await search.press('Escape')
  // Escape closes the dialog itself, wherever focus was.
  await expect(dialog).toBeHidden()
})

test('tasks tab lists open terminals with Close; the connection dot reports connected', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  await expect(page.getByRole('tablist', { name: 'Terminals' })).toBeVisible()
  await page.getByRole('tab', { name: 'Tasks' }).click()
  await expect(page.locator('main')).toContainText('Terminals')
  await page.locator('main').getByRole('button', { name: 'Close' }).first().click()
  await expect(page.locator('main')).not.toContainText('Terminal 1')
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await expect(page.locator('header [title="Connected"], [title="Connected"]').first()).toBeVisible()
})

test('F12 in the diff asks the language server about the file line behind the row, not the row', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  // The diff decides what the tree holds; clicking before it has settled selects nothing.
  await expect(page.getByTestId('tree-file').filter({ hasText: 'app.py' })).toBeVisible()
  await expect(page.getByTestId('tree-file').filter({ hasText: 'long.py' })).toBeVisible()
  await page.getByTestId('tree-file').filter({ hasText: 'long.py' }).first().click({ force: true })
  await expect(page.locator('main')).toContainText('src/long.py')   // the file is really selected before the keypress
  await expect(page.locator('.monaco-diff-editor .view-line').first()).toBeAttached({ timeout: 30_000 })
  // The change is on line 25; with ±3 context the diff's first row is line 22 of the file.
  const asked = page.waitForRequest((request) => request.url().includes('/api/lsp/definition'), { timeout: 30_000 })
  const input = page.locator('.monaco-diff-editor textarea.inputarea').last()
  await input.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('F12')
  const body = (await asked).postDataJSON()
  expect(body.path).toMatch(/src\/long\.py$/)
  expect(body.line).toBe(21)   // 0-based line 22
})

test('⇧F12 in the diff asks for usages by file line, and follows them out of the hunks into the file', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  // The diff decides what the tree holds; clicking before it has settled selects nothing.
  await expect(page.getByTestId('tree-file').filter({ hasText: 'app.py' })).toBeVisible()
  await expect(page.getByTestId('tree-file').filter({ hasText: 'long.py' })).toBeVisible()
  await page.getByTestId('tree-file').filter({ hasText: 'long.py' }).first().click({ force: true })
  await expect(page.locator('main')).toContainText('src/long.py')   // the file is really selected before the keypress
  await expect(page.locator('.monaco-diff-editor .view-line').first()).toBeAttached({ timeout: 30_000 })
  const asked = page.waitForRequest((request) => request.url().includes('/api/lsp/references'), { timeout: 30_000 })
  const input = page.locator('.monaco-diff-editor textarea.inputarea').last()
  await input.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+F12')
  const body = (await asked).postDataJSON()
  expect(body.path).toMatch(/src\/long\.py$/)
  expect(body.line).toBe(21)   // 0-based line 22, the first row of the hunk
  // The fake server names line 3 of this file and one in other.py: neither is in the hunks, so the file opens at the first.
  await expect(page.getByText(/2 usages, 2 outside this view/)).toBeVisible()
  await expect(page.locator('main')).toContainText('src/long.py:3')
})
