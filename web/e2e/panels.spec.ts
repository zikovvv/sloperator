import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

// Per test, not per file: a leftover worktree or session from the previous test used to
// decide whether this one passed.
test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('review panel: source and test files split, scope and context change, gutter comment attaches and sends', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await expect(page.getByTestId('review-panel')).toBeVisible()
  await expect(page.getByTestId('review-sidebar')).toHaveCount(0)   // code first; the sidebar is asked for
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await expect(page.getByTestId('tree-file').filter({ hasText: 'app.py' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Tests \(1 files\)/ })).toBeVisible()
  await page.getByRole('button', { name: /Tests \(1 files\)/ }).click()
  await expect(page.getByText('test_app.py')).toBeVisible()
  await page.getByRole('combobox', { name: 'What to compare' }).selectOption('branch')
  await page.getByRole('combobox', { name: 'What to compare' }).selectOption('uncommitted')
  await page.getByTestId('tree-file').filter({ hasText: 'app.py' }).first().click()
  await expect(page.locator('.monaco-diff-editor .view-line').first()).toBeAttached({ timeout: 30_000 })
  // The gutter handler listens for mousedown on the margin; the line-number cell is the margin.
  // Monaco wires that handler as it lays out, so under load the first click can land too early.
  const comment = page.getByPlaceholder('What about this line?')
  await expect.poll(async () => {
    await page.locator('.monaco-diff-editor .margin .line-numbers').last().click({ force: true })
    return comment.count()
  }, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(comment).toBeVisible()
  await comment.fill('this line is wrong')
  await page.getByRole('button', { name: 'Attach' }).click()
  await expect(page.getByText(/this line is wrong/)).toBeVisible()
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('fix it'); await box.press('Enter')
  await expect(page.locator('main').getByText(/Review comments on the current diff/).first()).toBeVisible()
  // The panel remembers its scope, context and open sidebar across a reload.
  await page.reload()
  await expect(page.getByTestId('review-sidebar')).toBeVisible()
})

test('terminal drawer: a shell opens in the worktree, a second tab, close one', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Toggle terminal' }).click()
  const tabs = page.getByRole('tablist', { name: 'Terminals' })
  await expect(tabs.getByRole('tab', { name: /Terminal 1/ })).toBeVisible()
  await expect(page.locator('.xterm')).toBeVisible()
  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(tabs.getByRole('tab', { name: /Terminal 2/ })).toBeVisible()
  await tabs.getByRole('tab', { name: /Terminal 2/ }).getByLabel('Close terminal').click()
  await expect(tabs.getByRole('tab', { name: /Terminal 2/ })).toBeHidden()
  await page.getByRole('button', { name: 'Hide terminal' }).click()
})

test('tabs: Claude Infra lists and previews; Usage renders; Pull Requests and GitHub degrade; Tasks lists running agents', async ({ page }) => {
  await open(page)
  await page.getByRole('tab', { name: 'Claude Infra' }).click()
  await expect(page.getByRole('button', { name: /CLAUDE\.md/ }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Usage' }).click()
  await expect(page.getByText(/Plan usage limits|Not signed in|expired|Asking Claude/)).toBeVisible()
  await page.getByRole('tab', { name: 'Pull Requests' }).click()
  await expect(page.locator('main')).toContainText(/Asking GitHub|gh|remote|not installed|No open pull requests/)
  await page.getByRole('tab', { name: 'GitHub' }).click()
  // Still asking, degraded, or already answered by the fake gh: any of them is the tab working.
  await expect(page.locator('main')).toContainText(/Asking GitHub|gh|remote|Nobody has commented|not installed|comments/)
  await page.getByRole('tab', { name: 'Tasks' }).click()
  await expect(page.getByText('Running now')).toBeVisible()
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('SLOW task'); await box.press('Enter')
  await expect(page.getByText(/Working/)).toBeVisible()
  await page.getByRole('tab', { name: 'Tasks' }).click()
  await expect(page.getByText('Stop turn')).toBeVisible()
  await page.getByRole('button', { name: 'Stop turn' }).click()
  await expect(page.getByText('No agent is running')).toBeVisible({ timeout: 15_000 })
})

test('settings dialog opens, edits a rate, closes with Escape', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('spinbutton').first().fill('3')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('side panels: cute buttons tuck the sidebar and review panel away, edges drag to resize, and it is remembered', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const sidebar = page.getByTestId('sidebar-column')
  const review = page.getByTestId('review-column')
  await expect(sidebar).toBeVisible(); await expect(review).toBeVisible()
  const width = async (locator: typeof sidebar) => (await locator.boundingBox())!.width
  const before = await width(sidebar)
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 100)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + 100, { steps: 4 }); await page.mouse.up()
  await expect.poll(() => width(sidebar)).toBeGreaterThan(before + 60)
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(sidebar).toBeHidden()
  await page.getByRole('button', { name: 'Hide review panel' }).click()
  await expect(review).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect.poll(() => width(page.getByTestId('sidebar-column'))).toBeGreaterThan(before + 60)
  await page.getByRole('button', { name: 'Show review panel' }).click()
  await expect(page.getByTestId('review-column')).toBeVisible()
})

test('a failed turn shows the failure and a Continue button that runs it again', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('please FAIL loudly'); await box.press('Enter')
  await expect(page.locator('main')).toContainText(/401/)
  // The fake's failure is a lapsed login: sign in again is offered beside Continue.
  await expect(page.getByText(/The login was revoked or has expired/)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/Continuing after the failure/)).toBeVisible()
  // It failed again, so there are two of them now.
  await expect.poll(async () => page.getByRole('button', { name: 'Continue' }).count()).toBeGreaterThan(1)
})
