import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => {
  await collectCoverage(page)
  rmSync(join(process.env.E2E_REPO!, 'touched.txt'), { force: true })   // the fake engine's trace, not part of the shared world
})

test('the review panel can show just what the last turn changed', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('TOUCH a file for me')
  await box.press('Enter')
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()
  await page.getByRole('button', { name: 'Files and settings' }).click()
  // Uncommitted has the world's own dirty files; the last turn has only what the engine left.
  await expect(page.getByTestId('tree-file').filter({ hasText: 'app.py' })).toBeVisible()
  const asked = page.waitForRequest((request) => request.url().includes('/api/diff') && request.url().includes('scope=turn'))
  await page.getByLabel('What to compare').selectOption('turn')
  await asked
  await expect(page.getByTestId('tree-file').filter({ hasText: 'touched.txt' })).toBeVisible()
  await expect(page.getByTestId('tree-file').filter({ hasText: 'app.py' })).toHaveCount(0)
})
