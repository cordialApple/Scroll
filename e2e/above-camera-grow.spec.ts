import { test, expect, type Page } from '@playwright/test'

const SCROLL_SELECTOR = '.canvas'
const SEED_COUNT = 400
const GROW_WORDS = 220

interface Metrics {
  anchorId: string
  relTop: number
  scrollTop: number
  nodeCount: number
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate(
    ({ scrollSel }) => {
      const w = window as unknown as { __scroll: { api: { current: { anchorId(): string } } } }
      const canvas = document.querySelector(scrollSel) as HTMLElement
      const anchorId = w.__scroll.api.current.anchorId()
      const contTop = canvas.getBoundingClientRect().top
      const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorId)}"]`)
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
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(400)
}

// P6.1: growing a RENDERED block above the camera must not move the human's viewport. Distinct from the
// P0 insert-above test, which inserts un-rendered blocks whose height is an estimate absorbed by the top
// spacer. Here the grown block is rendered and measured, so this exercises the innerText-sync-vs-measure
// timing the passive useEffect got wrong (the block grows after paint, so it was measured stale → drift).
test('growing a rendered above-camera block holds the camera (P6.1 no measurement-lag drift)', async ({
  page,
}) => {
  await page.goto('/')

  await page.waitForFunction(() => {
    const w = window as unknown as { __scroll?: { api?: { current?: unknown } } }
    return !document.querySelector('.boot-label') && !!w.__scroll && !!w.__scroll.api?.current
  })

  await page.evaluate((count) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; appendBlock: (doc: unknown, type: string, text: string) => string }
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
    canvas.scrollTop = Math.round((canvas.scrollHeight - canvas.clientHeight) * 0.45)
  }, SCROLL_SELECTOR)

  await settle(page)

  const before = await readMetrics(page)
  expect(before.anchorId, 'an anchor block should be resolved').toBeTruthy()
  expect(before.scrollTop, 'should be scrolled mid-document').toBeGreaterThan(100)
  expect(before.nodeCount, 'virtualized').toBeLessThan(250)

  // The rendered block immediately above the anchor: greatest top still strictly above the anchor's top.
  const target = await page.evaluate(
    ({ scrollSel, anchorId }) => {
      const canvas = document.querySelector(scrollSel) as HTMLElement
      const anchorTop = canvas
        .querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorId)}"]`)!
        .getBoundingClientRect().top
      let bestId = ''
      let bestTop = -Infinity
      let bestH = 0
      canvas.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
        const t = el.getBoundingClientRect().top
        if (t < anchorTop - 1 && t > bestTop) {
          bestTop = t
          bestId = el.dataset.blockId!
          bestH = el.offsetHeight
        }
      })
      return { id: bestId, height: bestH }
    },
    { scrollSel: SCROLL_SELECTOR, anchorId: before.anchorId },
  )
  expect(target.id, 'a rendered block exists above the camera').toBeTruthy()

  await page.evaluate(
    ({ id, words }) => {
      const w = window as unknown as {
        __scroll: {
          doc: unknown
          insertBlockText: (doc: unknown, id: string, offset: number, text: string, at?: number) => void
        }
      }
      const chunk = ' ' + 'lorem ipsum dolor sit amet '.repeat(words).trim()
      w.__scroll.insertBlockText(w.__scroll.doc, id, 0, chunk)
    },
    { id: target.id, words: GROW_WORDS },
  )

  await settle(page)

  // Non-vacuous: the target actually grew taller in the DOM.
  const grownHeight = await page.evaluate(
    ({ scrollSel, id }) => {
      const canvas = document.querySelector(scrollSel) as HTMLElement
      const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
      return el ? el.offsetHeight : 0
    },
    { scrollSel: SCROLL_SELECTOR, id: target.id },
  )
  expect(grownHeight, 'the above-camera target grew taller').toBeGreaterThan(target.height + 20)

  const after = await readMetrics(page)
  expect(after.anchorId, 'anchor block identity unchanged').toBe(before.anchorId)
  expect(
    Math.abs(after.relTop - before.relTop),
    'anchor stays at the same on-screen offset despite the grow above it',
  ).toBeLessThanOrEqual(1.5)
  expect(
    after.scrollTop,
    'scrollTop grows to absorb the height added above the camera',
  ).toBeGreaterThan(before.scrollTop)
  expect(after.nodeCount, 'still virtualized').toBeLessThan(250)
})
