import net from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../server/hocuspocus'

const SCROLL_SELECTOR = '.canvas'
const SEED_COUNT = 120

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

async function scrollToFraction(page: Page, frac: number): Promise<void> {
  await page.evaluate(
    ({ scrollSel, f }) => {
      const canvas = document.querySelector(scrollSel) as HTMLElement
      canvas.scrollTop = Math.round((canvas.scrollHeight - canvas.clientHeight) * f)
    },
    { scrollSel: SCROLL_SELECTOR, f: frac },
  )
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(300)
}

async function anchorId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __scroll: { api: { current: { anchorId(): string } } } }
    return w.__scroll.api.current.anchorId()
  })
}

// The presence wire, end to end: B must render A's live camera resolved to the block A is parked on.
test('a peer sees the other peer camera resolved to the right block', async ({ browser }) => {
  const room = `pr-${Date.now()}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  try {
    await boot(a, room)
    await boot(b, room)

    await a.evaluate((count) => {
      const w = window as unknown as {
        __scroll: { doc: unknown; appendBlock: (d: unknown, t: string, text: string) => string }
      }
      for (let i = 0; i < count; i++) {
        w.__scroll.appendBlock(w.__scroll.doc, 'paragraph', `Paragraph ${i} ${'lorem ipsum '.repeat(8)}`)
      }
    }, SEED_COUNT)

    await waitForCount(a, SEED_COUNT)
    await waitForCount(b, SEED_COUNT)
    await b.waitForTimeout(500) // let B's awareness channel attach before A publishes

    await scrollToFraction(a, 0.5)
    const aAnchor = await anchorId(a)
    expect(aAnchor).toBeTruthy()

    // B resolves A's live camera to the exact block A parked on — the full socket→awareness→resolve wire.
    await b.waitForFunction(
      (want) => {
        const w = window as unknown as {
          __scroll: { presence: { remotes(): { anchor: { blockId: string } }[] } | null }
        }
        const r = w.__scroll.presence?.remotes() ?? []
        return r.length === 1 && r[0].anchor.blockId === want
      },
      aAnchor,
      { timeout: 10_000 },
    )

    // …and renders it as B's single collaborator chip.
    const chip = b.locator('.presence-chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute('title', `at ${aAnchor}`)
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
