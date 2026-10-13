import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

const ask = async (page: import('@playwright/test').Page, text: string) => {
  await open(page)
  await openFreshSession(page)
  // The host is only offered when the session is not already unrestricted.
  await page.getByRole('combobox', { name: 'Access mode' }).selectOption('edits')
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill(text)
  await box.press('Enter')
  await expect(page.getByTestId('permission-card')).toBeVisible()
  await expect(page.getByTestId('waiting-strip')).toContainText('Claude is waiting for your answer')
  await expect(page.locator('nav').getByTitle('Waiting for your answer').first()).toBeVisible()
}

test('a question from Claude gets a card with its options; the pick reaches the agent', async ({ page }) => {
  await ask(page, 'ASK me something')
  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('Claude is asking you')
  await expect(card).toContainText('Continue?')
  await card.getByRole('button', { name: 'Yes' }).click()
  const sent = page.waitForRequest((request) => request.url().includes('/api/permission/') && request.method() === 'POST')
  await card.getByRole('button', { name: 'Answer' }).click()
  expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ behavior: 'allow', answers: { 'Continue?': 'Yes' } })
  await expect(page.getByText('HOST-SAID answered: {"Continue?": "Yes"}')).toBeVisible()
  await expect(card).toContainText('→ Yes')
  await expect(page.getByTestId('waiting-strip')).toHaveCount(0)
  await expect(page.locator('nav').getByTitle('Waiting for your answer')).toHaveCount(0)
})

test('a command that needs approval can be denied with a reason the agent then sees', async ({ page }) => {
  await ask(page, 'APPROVE the probe')
  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('Claude wants to run')
  await expect(card).toContainText('Probe')
  await card.getByRole('button', { name: 'Deny…' }).click()
  await card.getByLabel('Why not').fill('not on this branch')
  const sent = page.waitForRequest((request) => request.url().includes('/api/permission/') && request.method() === 'POST')
  await card.getByLabel('Why not').press('Enter')
  expect(JSON.parse((await sent).postData() ?? '{}')).toEqual({ behavior: 'deny', message: 'not on this branch' })
  await expect(page.getByText('HOST-SAID denied: not on this branch')).toBeVisible()
  await expect(card).toContainText('Denied — not on this branch')
})

test('stopping the turn expires an open question instead of leaving it hanging', async ({ page }) => {
  await ask(page, 'ASK me and wait')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('permission-card')).toContainText('Nobody answered before the turn ended')
  await expect(page.getByTestId('waiting-strip')).toHaveCount(0)
})
