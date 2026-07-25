import { test, expect, type Page } from '@playwright/test'

const SCROLL_SELECTOR = '.canvas'
const SEED_COUNT = 500
const EVICT_TRIGGER = 60
const EVICT_MARGIN = 30
const BAND_CEIL = 200

interface Metrics {
  anchorId: string
  relTop: number
  scrollTop: number
  nodeCount: number
  heightsSize: number
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate(({ scrollSel }) => {
    const w = window as unknown as {
      __scroll: { api: { current: { anchorId(): string; heightsSize(): number } } }
    }
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const anchorId = w.__scroll.api.current.anchorId()
    const contTop = canvas.getBoundingClientRect().top
    const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorId)}"]`)
    return {
      anchorId,
      relTop: el ? el.getBoundingClientRect().top - contTop : NaN,
      scrollTop: canvas.scrollTop,
      nodeCount: canvas.querySelectorAll('[data-block-id]').length,
      heightsSize: w.__scroll.api.current.heightsSize(),
    }
  }, { scrollSel: SCROLL_SELECTOR })
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(350)
}

test('heightsRef eviction bounds memory and the camera survives scroll-away-and-return', async ({ page }) => {
  const driftErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('docModel drift')) driftErrors.push(m.text())
  })

  await page.goto('/')
  await page.waitForFunction(() => {
    const w = window as unknown as { __scroll?: { api?: { current?: unknown } } }
    return !document.querySelector('.boot-label') && !!w.__scroll?.api?.current
  })

  await page.evaluate(
    ({ count, trigger, margin }) => {
      const w = window as unknown as {
        __scroll: { doc: unknown; appendBlock: (d: unknown, t: string, x: string) => string }
        __scrollEvictTrigger?: number
        __scrollEvictMargin?: number
      }
      w.__scrollEvictTrigger = trigger
      w.__scrollEvictMargin = margin
      for (let i = 0; i < count; i++) {
        const words = 4 + (i % 40)
        w.__scroll.appendBlock(w.__scroll.doc, 'paragraph', `Paragraph ${i} ${'lorem ipsum '.repeat(words).trim()}`)
      }
    },
    { count: SEED_COUNT, trigger: EVICT_TRIGGER, margin: EVICT_MARGIN },
  )
  await settle(page)

  const top0 = await readMetrics(page)
  expect(top0.anchorId, 'anchor resolves at top').toBeTruthy()

  // scroll down contiguously so long run of blocks gets measured (past trigger), early blocks fall outside band + evicted
  for (let step = 1; step <= 10; step++) {
    await page.evaluate(
      ({ scrollSel, frac }) => {
        const c = document.querySelector(scrollSel) as HTMLElement
        c.scrollTop = Math.round((c.scrollHeight - c.clientHeight) * frac)
      },
      { scrollSel: SCROLL_SELECTOR, frac: step * 0.06 },
    )
    await settle(page)
  }

  const mid = await readMetrics(page)
  expect(mid.scrollTop, 'scrolled into the document').toBeGreaterThan(1000)
  // eviction fired: heightsRef bounded to ~band. non-vacuous threshold — same scroll w/ eviction off leaves ~320
  // measured (swept prefix), so <SEED_COUNT would pass even w/o eviction; BAND_CEIL sits between ~80-entry band and ~320 no-evict
  expect(mid.heightsSize, 'heightsRef bounded to ~band, not blocks-ever-rendered').toBeLessThan(BAND_CEIL)
  expect(mid.nodeCount, 'still virtualized mid-doc').toBeLessThan(300)

  // fling to top: viewport lands in old-spacer territory, forces onScroll findByOffset fallback (no block straddles
  // top mid-fling) — regression for eviction/geometry hole, must resolve via ix not evicted heightsRef
  await page.evaluate((scrollSel) => {
    ;(document.querySelector(scrollSel) as HTMLElement).scrollTop = 0
  }, SCROLL_SELECTOR)
  await settle(page)

  const back = await readMetrics(page)
  expect(back.anchorId, 'top anchor resolves after fling-back (no blank spacer)').toBeTruthy()
  expect(back.scrollTop, 'landed at the top').toBeLessThan(50)
  expect(back.nodeCount, 'window covers the viewport after return').toBeGreaterThan(3)
  expect(back.nodeCount).toBeLessThan(300)
  // resolved top block near doc start, not stale far-down index (hole would teleport camera by Σ(measured−estimate) over evicted blocks)
  const backIdx = await page.evaluate(
    ({ id }) => {
      const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (d: unknown) => string[] } }
      return w.__scroll.blockOrder(w.__scroll.doc).indexOf(id)
    },
    { id: back.anchorId },
  )
  expect(backIdx, 'camera returned near the document start').toBeGreaterThanOrEqual(0)
  expect(backIdx, 'camera did not teleport to a far index').toBeLessThan(30)

  expect(driftErrors, 'no docModel drift errors across the whole run').toEqual([])
})
