import { test, expect } from '@playwright/test'
import { resetState, collectCoverage, state, open, openFreshSession, expandMain } from './helpers.ts'

// Per test, not per file: a leftover worktree or session from the previous test used to
// decide whether this one passed.
test.beforeEach(async ({ page }) => { await resetState(page) })
test.afterEach(async ({ page }) => { await collectCoverage(page) })

test('sending a message runs the agent, streams the reply, names the session, shows cost', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('Summarise the readme for me')
  await box.press('Enter')
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()
  await expandMain(page)   // its one session is folded away until asked for
  await expect(page.locator('nav')).toContainText('Summarise the readme for me')
  await expect(page.getByText(/\$0\.25/).first()).toBeVisible()
})

test('header controls: steer toggle, engine, model, effort, access, density persist to the session', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const steering = page.getByRole('group', { name: 'Steering' })
  await steering.getByRole('button', { name: /Steer/ }).click()
  await expect(steering.getByRole('button', { name: /Steer/ })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('combobox', { name: 'Engine' }).selectOption('codex')
  await page.getByRole('combobox', { name: 'Access mode' }).selectOption('full')
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('compact')
  await expect.poll(async () => {
    const session = (await state(page)).sessions.find((entry: any) => entry.engine === 'codex' && entry.accessMode === 'full')
    return !!session
  }).toBe(true)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Log detail' })).toHaveValue('compact')
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('normal')
})

test('compact density collapses tool calls into one line; verbose expands outputs', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('run the tools'); await box.press('Enter')
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('compact')
  // The tools the agent ran sit behind one line per step; opening it shows them as rows.
  const fold = page.getByTestId('step-fold').first()
  await expect(fold).toContainText(/tool call/)
  await expect(page.locator('main pre')).toHaveCount(0)
  await fold.click()
  await expect(page.locator('main').getByText(/Bash/).first()).toBeVisible()
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('ubercompact')
  await expect(page.getByTestId('turn-fold').first()).toContainText(/Worked in \d+ step/)
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('verbose')
  await expect(page.locator('main pre').first()).toBeVisible()
  await page.getByRole('combobox', { name: 'Log detail' }).selectOption('normal')
})

test('slash autocomplete lists skills and inserts one; quick-start chips fill the composer', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('/')
  await expect(page.getByRole('listbox', { name: 'Skills' })).toBeVisible()
  await box.press('Tab')
  await expect(box).toHaveValue(/^\/\S+ $/)
  await box.fill('')
  await expect(page.getByText('Quick start')).toBeVisible()
  await page.locator('main').getByRole('button', { name: /^\// }).first().click()
  await expect(box).toHaveValue(/^\//)
})

test('draft survives switching sessions and stays with its own session', async ({ page }) => {
  await open(page)
  await openFreshSession(page); await openFreshSession(page)
  const sessions = page.locator('nav div.row.pl-9')
  await sessions.nth(0).click()
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('half a thought')
  await page.waitForTimeout(600)
  await sessions.nth(1).click()
  await expect(page.getByPlaceholder(/Message the agent/)).toHaveValue('')
  await sessions.nth(0).click()
  await expect(page.getByPlaceholder(/Message the agent/)).toHaveValue('half a thought')
  await page.getByPlaceholder(/Message the agent/).fill('')
})

test('a failing turn shows an error bubble and the stop button stops a running turn', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('please FAIL now'); await box.press('Enter')
  await expect(page.getByText(/401/)).toBeVisible()
  await box.fill('SLOW hold on'); await box.press('Enter')
  await expect(page.getByText(/Working/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText(/Working/)).toBeHidden({ timeout: 15_000 })
})

test('keyboard: cmd-K palette jumps to a tab; cmd-J opens the terminal; cmd-shift-R hides review', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByPlaceholder(/Jump to a session/)
  await expect(palette).toBeVisible()
  await palette.fill('usage')
  await palette.press('Enter')
  await expect(page.getByText('Plan usage limits').or(page.getByText(/Asking Claude|Not signed in|expired/))).toBeVisible()
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('tablist', { name: 'Terminals' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('tablist', { name: 'Terminals' })).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Shift+r')
  await expect(page.getByText('Review', { exact: true })).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Shift+r')
})

test('a picture from the web is not fetched until its button is clicked', async ({ page }) => {
  await open(page)
  await openFreshSession(page)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  let fetched = 0
  await page.route('https://img.example.com/**', (route) => { fetched += 1; void route.fulfill({ body: png, contentType: 'image/png' }) })
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill('![web](https://img.example.com/x.png)'); await box.press('Enter')
  await expect(page.getByText(/FAKE-REPLY/)).toBeVisible()   // the fake engine echoes the prompt, so the reply carries the picture too
  const buttons = page.getByRole('button', { name: /load from img\.example\.com/ })
  await expect(buttons.first()).toBeVisible()
  expect(fetched).toBe(0)
  await buttons.first().click()
  await expect(page.getByAltText('web').first()).toBeVisible()
  await expect.poll(() => fetched).toBe(1)
})
