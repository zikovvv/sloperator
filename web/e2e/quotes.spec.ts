import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('right-click quotes a reply, your own words, or just the selected part into the next message', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('Summarise the readme')
  await box.press('Enter')
  const reply = page.locator('p').filter({ hasText: /^FAKE-REPLY/ })   // the reply itself, not the composer once it quotes it
  await expect(reply).toBeVisible()
  await reply.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Quote in next message' }).click()
  await expect(box).toHaveValue('> [Claude said]\n> FAKE-REPLY resume=0 prompt=Summarise the readme\n')
  await page.getByText('Summarise the readme', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Quote in next message' }).click()
  await expect(box).toHaveValue('> [Claude said]\n> FAKE-REPLY resume=0 prompt=Summarise the readme\n\n> [you said earlier]\n> Summarise the readme\n')
  // Only the selected words, when some are selected.
  await reply.evaluate((element) => {
    const range = document.createRange()
    range.setStart(element.firstChild!, 0)
    range.setEnd(element.firstChild!, 10)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  // The right-click lands on the selected words themselves; anywhere else would drop the selection.
  await reply.click({ button: 'right', position: { x: 12, y: 8 } })
  await page.getByRole('menuitem', { name: 'Quote in next message' }).click()
  await expect(box).toHaveValue(/\n\n> \[Claude said\]\n> FAKE-REPLY\n$/)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('the review editor and the pull-request comments quote into the composer too', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await page.getByTestId('tree-file').filter({ hasText: 'app.py' }).first().click({ force: true })
  await expect(page.locator('.monaco-diff-editor').first()).toBeAttached({ timeout: 30_000 })
  const line = page.locator('.monaco-diff-editor .editor.modified .view-line').last()
  await expect(line).toBeVisible({ timeout: 30_000 })
  await line.click()
  await line.click({ button: 'right' })
  // Monaco's menu ignores a mouse-up in its first moments, so an accidental click cannot pick an item.
  await page.waitForTimeout(400)
  await page.locator('.monaco-menu').getByText('Quote in chat').click()
  const box = page.getByPlaceholder(/Message the agent/)
  // The changed line of app.py, as the hunk: what it was, what it is now.
  await expect(box).toHaveValue('> [src/app.py:2, from the diff]\n> -     return name\n> +     return "hi " + name\n')
  // A comment on the pull request, with who wrote it and where.
  await page.getByRole('button', { name: /Conversations/ }).click()
  await expect(page.getByText('rename this')).toBeVisible()
  await page.getByText('rename this').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Quote in chat' }).click()
  await expect(box).toHaveValue(/\n\n> \[alice on #\d+, app\.py:12\]\n> rename this\n$/)
})
