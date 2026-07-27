import { test, expect, type Page } from '@playwright/test'

const CANVAS = '.canvas'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => {
    const w = window as unknown as { __scroll?: { api?: { current?: unknown } } }
    return !document.querySelector('.boot-label') && !!w.__scroll && !!w.__scroll.api?.current
  })
}

// Splitting a block mid-text while it is focused must leave the FIRST half showing only the first half —
// the truncation of the focused block must reach the DOM even though focus then moves to the new tail
// block. Guards the useLayoutEffect timing change against clobbering the split path (child layout effect
// runs while the first-half block is still focused, so its innerText sync must be reconciled on blur).
test('splitting a focused block truncates the first half in the DOM (P6.1 split not clobbered)', async ({
  page,
}) => {
  await boot(page)

  const blockIds = await page.evaluate(() => {
    const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (doc: unknown) => string[] } }
    return w.__scroll.blockOrder(w.__scroll.doc)
  })
  const targetId = blockIds[blockIds.length - 1]

  const target = page.locator(`[data-block-id="${targetId}"]`)
  await target.click()
  await page.keyboard.type('HelloWorld')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(200)

  const firstHalf = await page.evaluate(
    ({ canvasSel, id }) => {
      const el = (document.querySelector(canvasSel) as HTMLElement).querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(id)}"]`,
      )
      return el?.innerText ?? null
    },
    { canvasSel: CANVAS, id: targetId },
  )

  expect(firstHalf, 'the first-half block shows only "Hello", not the un-truncated full text').toBe('Hello')

  const secondHalfText = await page.evaluate(() => {
    const w = window as unknown as {
      __scroll: { doc: unknown; blockOrder: (d: unknown) => string[]; blockTextString: (d: unknown, id: string) => string | null }
    }
    const order = w.__scroll.blockOrder(w.__scroll.doc)
    return w.__scroll.blockTextString(w.__scroll.doc, order[order.length - 1])
  })
  expect(secondHalfText, 'the new tail block holds "World"').toBe('World')
})

// The sibling structural edit: merging a focused block into the previous one must land the concatenated
// text in the previous block's DOM. Unlike split, focus is lost as the merged-away block unmounts, so the
// previous block's layout-effect sync (guard now false) does the reconcile — a separate path from onBlur.
test('merging a focused block into the previous lands the concatenation in the DOM (P6.1 merge not clobbered)', async ({
  page,
}) => {
  await boot(page)

  const blockIds = await page.evaluate(() => {
    const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (doc: unknown) => string[] } }
    return w.__scroll.blockOrder(w.__scroll.doc)
  })
  const firstId = blockIds[blockIds.length - 1]

  await page.locator(`[data-block-id="${firstId}"]`).click()
  await page.keyboard.type('Hello')
  await page.keyboard.press('Enter')
  await page.keyboard.type('World')
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(200)

  const merged = await page.evaluate(
    ({ canvasSel, id }) => {
      const el = (document.querySelector(canvasSel) as HTMLElement).querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(id)}"]`,
      )
      return el?.innerText ?? null
    },
    { canvasSel: CANVAS, id: firstId },
  )
  expect(merged, 'the surviving block shows the concatenation "HelloWorld"').toBe('HelloWorld')
})
