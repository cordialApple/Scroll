import net from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../server/hocuspocus'

const SCROLL_SELECTOR = '.canvas'
const SEED_COUNT = 400
const INSERT_COUNT = 50

interface Metrics {
  anchorId: string
  relTop: number
  scrollTop: number
  blockCount: number
}

let server: Hocuspocus
let port: number

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

test.beforeAll(async () => {
  port = await freePort()
  server = await startScrollServer({ port })
})

test.afterAll(async () => {
  await server.destroy()
})

async function boot(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${room}&ws=ws://127.0.0.1:${port}`)
  await page.waitForFunction(() => {
    const w = window as unknown as { __scroll?: { api?: { current?: unknown } } }
    return !document.querySelector('.boot-label') && !!w.__scroll?.api?.current
  })
}

async function blockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (d: unknown) => string[] } }
    return w.__scroll.blockOrder(w.__scroll.doc).length
  })
}

async function waitForCount(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (d: unknown) => string[] } }
      return w.__scroll.blockOrder(w.__scroll.doc).length >= n
    },
    atLeast,
    { timeout: 15_000 },
  )
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(300)
}

async function scrollToFraction(page: Page, frac: number): Promise<void> {
  await page.evaluate(
    ({ scrollSel, f }) => {
      const canvas = document.querySelector(scrollSel) as HTMLElement
      canvas.scrollTop = Math.round((canvas.scrollHeight - canvas.clientHeight) * f)
    },
    { scrollSel: SCROLL_SELECTOR, f: frac },
  )
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate((scrollSel) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; api: { current: { anchorId(): string } }; blockOrder: (d: unknown) => string[] }
    }
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const anchorId = w.__scroll.api.current.anchorId()
    const contTop = canvas.getBoundingClientRect().top
    const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorId)}"]`)
    return {
      anchorId,
      relTop: el ? el.getBoundingClientRect().top - contTop : NaN,
      scrollTop: canvas.scrollTop,
      blockCount: w.__scroll.blockOrder(w.__scroll.doc).length,
    }
  }, SCROLL_SELECTOR)
}

async function insertAbove(page: Page, anchorId: string, n: number): Promise<void> {
  await page.evaluate(
    ({ anchorId, n }) => {
      const w = window as unknown as {
        __scroll: { doc: unknown; insertAbove: (d: unknown, beforeId: string, n: number) => string[] }
      }
      w.__scroll.insertAbove(w.__scroll.doc, anchorId, n)
    },
    { anchorId, n },
  )
}

// The P3 milestone: two browsers, an insert above one peer's camera, neither screen jumps.
test('a remote insert above each viewport moves neither peer (P3 anti-jump across real peers)', async ({
  browser,
}) => {
  const room = `mu-${Date.now()}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  try {
    await boot(a, room)
    await boot(b, room)

    // Seed the shared doc from A only; B receives it over the socket.
    await a.evaluate((count) => {
      const w = window as unknown as {
        __scroll: { doc: unknown; appendBlock: (d: unknown, t: string, text: string) => string }
      }
      for (let i = 0; i < count; i++) {
        const words = 4 + (i % 40)
        w.__scroll.appendBlock(w.__scroll.doc, 'paragraph', `Paragraph ${i} ${'lorem ipsum '.repeat(words).trim()}`)
      }
    }, SEED_COUNT)

    const target = SEED_COUNT // ignore the handful of top seed blocks; both converge to the same total
    await waitForCount(a, target)
    await waitForCount(b, target)

    // Park the two peers at DIFFERENT depths.
    await scrollToFraction(a, 0.45)
    await scrollToFraction(b, 0.7)
    await settle(a)
    await settle(b)

    const beforeA = await readMetrics(a)
    const beforeB = await readMetrics(b)
    expect(beforeA.anchorId).toBeTruthy()
    expect(beforeB.anchorId).toBeTruthy()
    expect(beforeA.scrollTop).toBeGreaterThan(100)
    expect(beforeB.scrollTop).toBeGreaterThan(100)

    // --- A inserts above A's own camera. Neither peer's screen may move. ---
    const totalAfter1 = beforeA.blockCount + INSERT_COUNT
    await insertAbove(a, beforeA.anchorId, INSERT_COUNT)
    await waitForCount(b, totalAfter1)
    await settle(a)
    await settle(b)

    const afterA1 = await readMetrics(a)
    const afterB1 = await readMetrics(b)
    expect(afterA1.anchorId, 'A: local anchor identity holds').toBe(beforeA.anchorId)
    expect(Math.abs(afterA1.relTop - beforeA.relTop), 'A: own viewport stays put').toBeLessThanOrEqual(1.5)
    expect(afterB1.anchorId, 'B: anchor identity holds under a remote insert').toBe(beforeB.anchorId)
    expect(Math.abs(afterB1.relTop - beforeB.relTop), 'B: viewport does not jump on remote insert').toBeLessThanOrEqual(1.5)

    // --- Symmetric: B inserts above B's own camera. ---
    const totalAfter2 = afterB1.blockCount + INSERT_COUNT
    await insertAbove(b, afterB1.anchorId, INSERT_COUNT)
    await waitForCount(a, totalAfter2)
    await settle(a)
    await settle(b)

    const afterA2 = await readMetrics(a)
    const afterB2 = await readMetrics(b)
    expect(afterB2.anchorId, 'B: local anchor identity holds').toBe(afterB1.anchorId)
    expect(Math.abs(afterB2.relTop - afterB1.relTop), 'B: own viewport stays put').toBeLessThanOrEqual(1.5)
    expect(afterA2.anchorId, 'A: anchor identity holds under a remote insert').toBe(afterA1.anchorId)
    expect(Math.abs(afterA2.relTop - afterA1.relTop), 'A: viewport does not jump on remote insert').toBeLessThanOrEqual(1.5)
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
