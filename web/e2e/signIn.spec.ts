import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('a turn that failed on the login offers to sign in again, in a terminal running the engine\'s login', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('FAIL on purpose'); await box.press('Enter')
  await expect(page.getByText('The login was revoked or has expired. Sign in again, then Continue.')).toBeVisible()
  const opened = page.waitForRequest((request) => request.method() === 'POST' && /\/terminals$/.test(request.url()) && request.postDataJSON()?.login === 'claude')
  await page.getByRole('button', { name: 'Sign in again' }).click()
  await opened
  await expect(page.getByRole('tab', { name: /Sign in to Claude/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.xterm')).toContainText('FAKE-LOGIN', { timeout: 15_000 })
})
