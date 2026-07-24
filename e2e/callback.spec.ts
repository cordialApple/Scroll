import { test, expect } from '@playwright/test'

const CALLBACK = 'http://127.0.0.1:47999/scroll/verdict/corr-1?k=secret'

const SCHEMA = {
  schemaVersion: 1,
  kind: 'ide-es',
  title: 'Callback sum',
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
  resultCallbackUrl: CALLBACK,
}

const SOLUTION = `function solve(input) {
  return String(input.trim().split(/\\s+/).map(Number).reduce((a, b) => a + b, 0))
}`

function spawnUrl(schema: unknown): string {
  const s = Buffer.from(JSON.stringify(schema)).toString('base64url')
  return `/#/es/new?s=${s}`
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

test('a graded submission fires a contract-6 callback POST carrying the ResultPayload', async ({ page }) => {
  let body: Record<string, unknown> | null = null

  await page.route('**/scroll/verdict/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (req.method() === 'POST') body = req.postDataJSON()
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' })
  })

  await page.goto(spawnUrl(SCHEMA))
  await page.waitForFunction(() => /^#\/es\/[^/]+$/.test(window.location.hash))
  const endpointId = new URL(page.url()).hash.split('/').pop()!

  await page.locator('.es-editor').fill(SOLUTION)
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(page.locator('.es-verdict')).toHaveClass(/es-verdict-pass/, { timeout: 15_000 })

  await expect.poll(() => body, { timeout: 10_000 }).not.toBeNull()
  expect(body).toMatchObject({
    endpointId,
    status: 'pass',
    withinBudget: true,
    passed: 2,
    total: 2,
  })
  expect(typeof body!.at).toBe('number')
})

test('an endpoint with no callback url fires no POST', async ({ page }) => {
  let hits = 0
  await page.route('**/scroll/verdict/**', async (route) => {
    hits++
    return route.fulfill({ status: 200, headers: CORS, body: '{}' })
  })

  const { resultCallbackUrl, ...noCallback } = SCHEMA
  void resultCallbackUrl
  await page.goto(spawnUrl(noCallback))
  await page.waitForFunction(() => /^#\/es\/[^/]+$/.test(window.location.hash))
  await page.locator('.es-editor').fill(SOLUTION)
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(page.locator('.es-verdict')).toHaveClass(/es-verdict-pass/, { timeout: 15_000 })

  expect(hits).toBe(0)
})
