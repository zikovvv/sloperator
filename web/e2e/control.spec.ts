import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, state } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('an agent asked in the chat rearranges the sidebar: its worktree and its stack are renamed at once', async ({ page }) => {
  await open(page)
  // A stack's first layer is a worktree of its own with a session already open in it.
  await page.locator('nav').getByRole('button', { name: 'New stack' }).click()
  const box = page.getByPlaceholder(/Message the agent/)
  await expect(box).toBeVisible()
  const { id, worktreeID } = (await state(page)).sessions.at(-1)
  const sent = page.waitForResponse((response) => response.url().endsWith(`/api/session/${id}/send`))
  await box.fill('SIDEBAR update_worktree {"name":"Filed by the agent","pinned":true}'); await box.press('Enter')
  expect((await sent).status()).toBe(200)
  // Without full access the app asks first, and nothing changes until the yes.
  const card = page.getByTestId('permission-card').last()
  await expect(card).toContainText('Claude wants to run'); await expect(card).toContainText('mcp__orchestrator__update_worktree')
  expect((await state(page)).worktrees.find((entry: any) => entry.id === worktreeID).name).not.toBe('Filed by the agent')
  const answered = page.waitForResponse((response) => /\/api\/permission\/[^/]+$/.test(response.url()))
  await card.getByRole('button', { name: 'Allow' }).click()
  expect((await answered).status()).toBe(200)
  // The agent named no worktree: it meant the one it is in.
  await expect(page.locator('nav').getByTestId('worktree-title').filter({ hasText: 'Filed by the agent' })).toBeVisible()
  await expect(page.locator('main')).toContainText('update_worktree')
  await expect(page.locator('main')).toContainText('DID: ')
  expect((await state(page)).worktrees.find((entry: any) => entry.id === worktreeID)).toMatchObject({ name: 'Filed by the agent', isPinned: true })

  await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/api/tasks')).json()).tasks.length))).toBe(0)
  // With full access the same kind of request just happens.
  await page.getByRole('combobox', { name: 'Access mode' }).selectOption('full')
  await box.fill('SIDEBAR manage_stack {"action":"rename","name":"Agent stack"}'); await box.press('Enter')
  await expect(page.getByTestId('stack')).toContainText('Agent stack')
  await expect(page.getByTestId('permission-card')).toHaveCount(1)
})

test('anything outside the app can ask the same: the operations are listed and run over HTTP', async ({ page }) => {
  await open(page)
  const listing = await page.evaluate(async () => (await fetch('/api/control')).json())
  expect(listing.operations.map((operation: any) => operation.name)).toContain('update_session')
  const main = (await state(page)).worktrees.find((entry: any) => entry.isMain)
  const made = await page.evaluate(async (worktree) => (await fetch('/api/control/create_session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worktree, title: 'Made from outside' }),
  })).json(), main.id)
  expect(made.ok).toBe(true)
  // It shows in the sidebar without a reload: the app was told like any other change.
  await page.locator('nav div.row').filter({ hasText: '⌂' }).first().getByRole('button', { name: 'Expand worktree' }).click()
  await expect(page.locator('nav').getByText('Made from outside', { exact: true })).toBeVisible()
})
