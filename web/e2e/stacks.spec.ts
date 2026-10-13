import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, state } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('a stack starts with a layer, grows one layer at a time on the top one, and updates bottom to top', async ({ page }) => {
  await open(page)
  await page.locator('nav').getByRole('button', { name: 'New stack' }).click()
  const stack = page.getByTestId('stack')
  await expect(stack).toContainText('Stack 1')
  await expect(page.getByPlaceholder(/Message the agent/)).toBeVisible()   // layer 1's session is open
  await stack.getByRole('button', { name: 'Add layer' }).click()
  await expect(stack.getByTestId('worktree-title')).toHaveCount(2)
  await expect(stack.getByTitle('Layer 2: builds on the layer below')).toHaveText('2')
  const [bottom, top] = (await state(page)).stacks[0].layers
  const worktrees = (await state(page)).worktrees
  expect(worktrees.find((entry: any) => entry.id === top).baseBranch).toBe(worktrees.find((entry: any) => entry.id === bottom).branch)
  const updated = page.waitForResponse((response) => /\/api\/stack\/[^/]+\/update$/.test(response.url()))
  await stack.getByRole('button', { name: 'Row actions' }).first().click()
  await page.getByRole('menuitem', { name: 'Update stack' }).click()
  expect((await (await updated).json()).results[0].status).toBe('up-to-date')
  await expect(page.getByText(/Updated Stack 1:/)).toBeVisible()
})
