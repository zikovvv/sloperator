import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('the review diff numbers rows by their file line, and wraps long lines from the button and with ⌥Z', async ({ page }) => {
  // The changed line is far wider than the panel, and deep enough in long.py that its row and file line differ.
  writeFileSync(join(process.env.E2E_REPO!, 'src', 'long.py'),
    Array.from({ length: 30 }, (_, index) => (index === 24 ? `line_25 = "${'wide '.repeat(80)}"` : `line_${index + 1} = ${index + 1}`)).join('\n') + '\n')
  await open(page)
  await openFreshSession(page)
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await page.getByTestId('tree-file').filter({ hasText: 'long.py' }).first().click()
  // Close the files sidebar at once: every row count below is taken at this one editor width.
  await page.getByRole('button', { name: 'Files and settings' }).click()
  await expect(page.getByTestId('review-sidebar')).toHaveCount(0)
  const editor = page.locator('.monaco-diff-editor .editor.modified')
  await expect(editor.locator('.view-line').first()).toBeVisible({ timeout: 30_000 })
  await expect(editor.locator('.line-numbers').filter({ hasText: /^25$/ })).toHaveCount(1)
  const rows = () => editor.locator('.view-line').count()
  const unwrapped = await rows()
  const wrap = page.getByRole('button', { name: 'Wrap long lines' })
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(rows).toBeGreaterThan(unwrapped)
  const wrapped = await rows()
  // Monaco's line container is what takes the pointer; its lines re-render as the text re-wraps.
  await editor.locator('.lines-content > .view-lines').click({ position: { x: 24, y: 6 } })   // not the deleted-code zone's own
  await page.keyboard.press('Alt+z')
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(rows).toBeLessThan(wrapped)
})
