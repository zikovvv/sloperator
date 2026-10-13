import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('a file reference with a line, clicked in a reply, opens that file in the diff being reviewed', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const plainFile: string[] = []
  page.on('request', (request) => { if (/\/api\/file\?/.test(request.url())) plainFile.push(request.url()) })
  const box = page.getByPlaceholder(/Message the agent/)
  // The fake engine repeats the prompt in its reply, link and all.
  await box.fill('see [the greeting](src/app.py#L2)'); await box.press('Enter')
  const reply = page.locator('p').filter({ hasText: /^FAKE-REPLY/ })
  await expect(reply).toBeVisible()
  const sides = page.waitForRequest((request) => request.url().includes('/api/diff/file') && request.url().includes(encodeURIComponent('src/app.py')))
  await reply.getByRole('link', { name: 'the greeting' }).click()
  await sides
  await expect(page.locator('.monaco-diff-editor').first()).toBeAttached({ timeout: 30_000 })
  await expect(page.getByTestId('review-panel')).toContainText('src/app.py')
  await expect(page.getByTestId('review-panel')).toContainText('Uncommitted')   // still the comparison that was on screen
  // The cursor sits on the line the reference named.
  await expect(page.locator('.monaco-diff-editor .editor.modified .current-line').first()).toBeAttached()
  expect(plainFile).toEqual([])   // never opened as a plain file
})
