import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, open, openFreshSession, state } from './helpers.ts'

test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('the model chooser offers the featured models, unfolds the others on request, and a pick sticks', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const chooser = page.getByRole('combobox', { name: 'Model' })
  // The catalog was fetched as the page opened; the e2e Claude home has none, so it is the built-in list.
  // A session starts on the model last chosen, which may be an unfeatured one from an earlier run.
  const options = () => chooser.locator('option').allTextContents()
  await expect.poll(options).toEqual(expect.arrayContaining(['Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5', 'Other models…']))
  expect((await options()).at(-1)).toBe('Other models…')
  expect(await options()).not.toContain('Sonnet 4.6')
  await chooser.selectOption({ label: 'Other models…' })
  await expect.poll(options).toEqual(expect.arrayContaining(['Opus 4.8', 'Sonnet 4.6', 'Fewer models…']))
  await chooser.selectOption({ label: 'Opus 4.8' })
  await expect.poll(async () => (await state(page)).sessions.at(-1).model).toBe('claude-opus-4-8')
  await expect(chooser).toHaveValue('claude-opus-4-8')
  await chooser.selectOption({ label: 'Fewer models…' })
  await expect.poll(options).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8', 'Other models…'])
  await chooser.selectOption({ label: 'Fable 5.1' })   // leave the remembered default where other specs expect it
  await expect.poll(async () => (await state(page)).sessions.at(-1).model).toBe('claude-fable-5-1')
})
