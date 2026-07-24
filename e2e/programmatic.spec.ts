import { test, expect } from '@playwright/test'

const SCHEMA = {
  schemaVersion: 1,
  kind: 'ide-es',
  title: 'Programmatic sum',
  lifecycleOwner: 'consumer',
  programmatic: 'on',
  goalCondition: 'sum the integers',
  problem: 'Sum the whitespace-separated integers in the input.',
  entry: { language: 'javascript', functionName: 'solve' },
  tleBudgetMs: 1000,
  tests: [
    { name: 'sample', input: '1 2 3', expectedOutput: '6', hidden: false },
    { name: 'hidden', input: '4 5', expectedOutput: '9', hidden: true },
  ],
}

const SOLUTION = `function solve(input) {
  return String(input.trim().split(/\\s+/).map(Number).reduce((a, b) => a + b, 0))
}`

function spawnUrl(schema: unknown): string {
  const s = Buffer.from(JSON.stringify(schema)).toString('base64url')
  return `/#/es/new?s=${s}`
}

test('a programmatic spawn URL creates a gradable endpoint and redirects to it', async ({ page }) => {
  await page.goto(spawnUrl(SCHEMA))
  await page.waitForFunction(() => /^#\/es\/[^/]+$/.test(window.location.hash))
  await expect(page.locator('.es-title')).toHaveText('Programmatic sum')
  await expect(page.locator('.es-editor')).toBeVisible()

  const editor = page.locator('.es-editor')
  await editor.fill(SOLUTION)
  await expect(editor).toHaveValue(SOLUTION)
  await page.getByRole('button', { name: 'Submit' }).click()

  const verdict = page.locator('.es-verdict')
  await expect(verdict).toHaveClass(/es-verdict-pass/, { timeout: 15_000 })
  await expect(verdict).toContainText('2/2 tests')

  await page.goBack()
  expect(page.url()).not.toContain('/es/new')
})

test('a spawn URL with a garbage payload shows a spawn error, not a broken app', async ({ page }) => {
  await page.goto('/#/es/new?s=not-a-valid-payload')
  await expect(page.locator('.es-missing')).toContainText('Could not spawn endpoint')
  await expect(page.locator('.es-back')).toBeVisible()
})
