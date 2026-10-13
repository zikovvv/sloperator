import { test, expect } from '@playwright/test'
import { API, resetState, collectCoverage, expandMain, open, openFreshSession, rowMenu, state } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('Claude names a session from what was asked, and names it again on request', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('NAMEME tidy the header'); await box.press('Enter')
  await expect.poll(async () => (await state(page)).sessions.at(-1).title).toBe('Named: tidy the header')
  await expandMain(page)
  await expect(page.locator('nav').getByText('Named: tidy the header', { exact: true })).toBeVisible()
  const asked = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/session\/[^/]+\/name$/.test(response.url()))
  await rowMenu(page, 'Named: tidy the header', 'Rename with Claude')
  expect((await asked).status()).toBe(200)
})

test('/rename typed in the chat names the session on the spot, without starting a turn', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('/rename Release checklist'); await box.press('Enter')
  await expect.poll(async () => (await state(page)).sessions.at(-1).title).toBe('Release checklist')
  const id = (await state(page)).sessions.at(-1).id
  const items = await (await page.request.get(`${API}/api/transcript/${id}`, { headers: { Origin: API } })).json()
  expect(items.map((item: any) => item.text)).toEqual(['Session renamed to “Release checklist”'])
  await expect(page.getByText('Session renamed to “Release checklist”')).toBeVisible()
})
