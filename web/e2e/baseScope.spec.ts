import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('the review panel can measure a branch against its base or against main, and says which', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  const askedMain = page.waitForRequest((request) => request.url().includes('/api/diff') && request.url().includes('scope=main'))
  await page.getByLabel('What to compare').selectOption('main')
  await askedMain
  await expect(page.getByTestId('diff-base')).toHaveText('vs main')
  // The main checkout's base is the default branch itself; only the working tree is shown for it.
  const askedBase = page.waitForRequest((request) => request.url().includes('/api/diff') && request.url().includes('scope=branch'))
  await page.getByLabel('What to compare').selectOption('branch')
  await askedBase
  await expect(page.getByTestId('diff-base')).toHaveText('vs main')
  const askedTree = page.waitForRequest((request) => request.url().includes('/api/diff') && request.url().includes('scope=uncommitted'))
  await page.getByLabel('What to compare').selectOption('uncommitted')
  await askedTree
  await expect(page.getByTestId('diff-base')).toHaveCount(0)
  await expect(page.getByTestId('diff-files')).toHaveText(/^[0-9]+ files$/)
})
