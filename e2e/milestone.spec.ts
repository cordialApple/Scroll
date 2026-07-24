import { test, expect, type Page } from '@playwright/test'

const SCROLL_SELECTOR = '.canvas'
const BLOCK_SELECTOR = '[data-block-id]'
const SEED_COUNT = 400
const INSERT_COUNT = 50

interface Metrics {
  anchorId: string
  relTop: number
  scrollTop: number
  nodeCount: number
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate(
    ({ scrollSel }) => {
      const w = window as unknown as {
        __scroll: { api: { current: { anchorId(): string } } }
      }
      const canvas = document.querySelector(scrollSel) as HTMLElement
      const anchorId = w.__scroll.api.current.anchorId()
      const contTop = canvas.getBoundingClientRect().top
      const el = canvas.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(anchorId)}"]`,
      )
      return {
        anchorId,
        relTop: el ? el.getBoundingClientRect().top - contTop : NaN,
        scrollTop: canvas.scrollTop,
        nodeCount: canvas.querySelectorAll('[data-block-id]').length,
      }
    },
    { scrollSel: SCROLL_SELECTOR },
  )
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  )
  await page.waitForTimeout(400)
}

test('insert above the camera does not move the top block (P0 anti-jump)', async ({
  page,
}) => {
  await page.goto('/')

  await page.waitForFunction(() => {
    const w = window as unknown as {
      __scroll?: { api?: { current?: unknown } }
    }
    const bootGone = !document.querySelector('.boot-label')
    return bootGone && !!w.__scroll && !!w.__scroll.api?.current
  })

  await page.evaluate((count) => {
    const w = window as unknown as {
      __scroll: {
        doc: unknown
        appendBlock: (doc: unknown, type: string, text: string) => string
      }
    }
    for (let i = 0; i < count; i++) {
      const words = 4 + (i % 40)
      const text = `Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(words).trim()}`
      w.__scroll.appendBlock(w.__scroll.doc, 'paragraph', text)
    }
  }, SEED_COUNT)

  await settle(page)

  await page.evaluate((scrollSel) => {
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const max = canvas.scrollHeight - canvas.clientHeight
    canvas.scrollTop = Math.round(max * 0.45)
  }, SCROLL_SELECTOR)

  await settle(page)

  const before = await readMetrics(page)

  expect(before.anchorId, 'an anchor block should be resolved').toBeTruthy()
  expect(before.scrollTop, 'should be scrolled mid-document').toBeGreaterThan(100)
  expect(
    before.nodeCount,
    'virtualization: rendered nodes must be far fewer than total',
  ).toBeLessThan(250)
  expect(before.nodeCount).toBeGreaterThan(5)

  await page.evaluate(
    ({ anchorId, count }) => {
      const w = window as unknown as {
        __scroll: {
          doc: unknown
          insertAbove: (doc: unknown, beforeId: string, n: number) => string[]
        }
      }
      w.__scroll.insertAbove(w.__scroll.doc, anchorId, count)
    },
    { anchorId: before.anchorId, count: INSERT_COUNT },
  )

  await settle(page)

  const after = await readMetrics(page)

  expect(after.anchorId, 'top block identity is unchanged').toBe(before.anchorId)
  expect(
    Math.abs(after.relTop - before.relTop),
    'top block stays at the same on-screen offset',
  ).toBeLessThanOrEqual(1.5)
  expect(
    after.scrollTop,
    'scrollTop grows to absorb the inserted height above the camera',
  ).toBeGreaterThan(before.scrollTop)
  expect(
    after.nodeCount,
    'still virtualized after insert',
  ).toBeLessThan(250)
})
