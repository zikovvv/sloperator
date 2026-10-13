import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('a scope shows its own diff, however late the previous scope\'s answer arrives', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await expect(page.getByTestId('diff-files')).toHaveText(/files/)   // the main checkout's edits, uncommitted
  // From here on the uncommitted diff takes longer than any other.
  await page.route('**/api/diff?*', async (route) => {
    if (route.request().url().includes('scope=uncommitted')) await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.getByRole('button', { name: 'Refresh diff' }).click()
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await page.getByLabel('What to compare').selectOption('staged')
  await expect(page.getByText(/No changes in “Staged”/).first()).toBeVisible()
  await page.waitForTimeout(2000)
  await expect(page.getByText(/No changes in “Staged”/).first()).toBeVisible()
  await expect(page.getByTestId('diff-files')).toHaveCount(0)
})
