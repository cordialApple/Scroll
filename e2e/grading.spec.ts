import { test, expect, type Page } from '@playwright/test'

const SOLUTION = `function solve(input) {
  return String(input.trim().split(/\\s+/).map(Number).reduce((a, b) => a + b, 0))
}`

const WRONG = `function solve() { return '0' }`
const HANG = `function solve() { while (true) {} }`

async function spawnIde(page: Page): Promise<void> {
  await page.goto('/#/es')
  await page.getByRole('button', { name: 'Spawn IDE endpoint (sample)' }).click()
  await page.waitForFunction(() => /^#\/es\/[^/]+$/.test(window.location.hash))
  await expect(page.locator('.es-editor')).toBeVisible()
}

async function submit(page: Page, code: string): Promise<void> {
  const editor = page.locator('.es-editor')
  await editor.fill(code)
  await expect(editor).toHaveValue(code)
  await page.getByRole('button', { name: 'Submit' }).click()
}

test('correct solution grades Accepted through the real worker', async ({ page }) => {
  await spawnIde(page)
  await submit(page, SOLUTION)
  const verdict = page.locator('.es-verdict')
  await expect(verdict).toHaveClass(/es-verdict-pass/, { timeout: 15_000 })
  await expect(verdict).toContainText('Accepted')
  await expect(verdict).toContainText('4/4 tests')

  const hash = await page.evaluate(() => window.location.hash)
  const id = hash.replace('#/es/', '')
  await page.goto(`/#/es/${id}/result`)
  await expect(page.locator('.es-json')).toContainText('"status": "pass"')
})

test('wrong answer grades as Wrong answer', async ({ page }) => {
  await spawnIde(page)
  await submit(page, WRONG)
  const verdict = page.locator('.es-verdict')
  await expect(verdict).toHaveClass(/es-verdict-fail/, { timeout: 15_000 })
  await expect(verdict).toContainText('Wrong answer')
})

test('non-terminating solution is killed by the TLE budget', async ({ page }) => {
  await spawnIde(page)
  await submit(page, HANG)
  const verdict = page.locator('.es-verdict')
  await expect(verdict).toHaveClass(/es-verdict-tle/, { timeout: 20_000 })
  await expect(verdict).toContainText('Time limit exceeded')
})
