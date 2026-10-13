import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('what the agent is running shows above the composer, and a process can be killed from there', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('STALL for a bit')
  await box.press('Enter')
  const panel = page.getByTestId('activity-panel')
  await expect(panel).toContainText(/Running now · 1 tool call · \d+ process/)
  await panel.getByRole('button', { name: /Running now/ }).click()
  await expect(panel).toContainText('Task')
  await expect(panel).toContainText('sleep 30')
  const row = panel.locator('div').filter({ hasText: 'sleep 30' }).filter({ has: page.getByRole('button', { name: 'Kill' }) }).last()
  const killed = page.waitForRequest((request) => request.method() === 'DELETE' && /\/api\/tasks\/process\/\d+$/.test(request.url()))
  await row.getByRole('button', { name: 'Kill' }).click()
  await killed
  // Without its sleep the fake engine finishes at once; what the turn ran stays readable as the last turn.
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()
  await expect(panel).toContainText(/Last turn · \d+ finished/)
  // The panel was opened above and stays open across the turn's end.
  await panel.getByTestId('finished-tool').filter({ hasText: 'Task' }).getByRole('button').click()
  await expect(panel.getByTestId('tool-output').first()).toHaveText('done')
})
