import { test, expect, type Page } from '@playwright/test'

const SCROLL_SELECTOR = '.canvas'
const SEED_COUNT = 200

interface Metrics {
  anchorId: string
  relTop: number
  scrollTop: number
  nodeCount: number
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?voice=fake')
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __scroll?: { api?: { current?: unknown }; voice?: unknown }
    }
    return !document.querySelector('.boot-label') && !!w.__scroll?.api?.current && !!w.__scroll.voice
  })
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await page.waitForTimeout(400)
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate((scrollSel) => {
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
  }, SCROLL_SELECTOR)
}

test('P5 milestone — dictated final lands at the caret while the anchored camera holds', async ({
  page,
}) => {
  await boot(page)

  await page.evaluate((count) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; appendBlock: (doc: unknown, type: string, text: string) => string }
    }
    for (let i = 0; i < count; i++) {
      const words = 4 + (i % 30)
      const text = `Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(words).trim()}`
      w.__scroll.appendBlock(w.__scroll.doc, 'paragraph', text)
    }
  }, SEED_COUNT)

  await settle(page)

  // Put the caret at the end of an early block (visible at the top) — the dictation target.
  const setup = await page.evaluate((scrollSel) => {
    const w = window as unknown as {
      __scroll: {
        doc: unknown
        blockOrder: (d: unknown) => string[]
        blockTextString: (d: unknown, id: string) => string | null
      }
    }
    const targetId = w.__scroll.blockOrder(w.__scroll.doc)[3]
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(targetId)}"]`)!
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    return { targetId, baseline: w.__scroll.blockTextString(w.__scroll.doc, targetId) ?? '' }
  }, SCROLL_SELECTOR)
  const { targetId, baseline } = setup
  await settle(page)

  // The editor captured the caret target from the live selection.
  await page.waitForFunction(
    (anchorId) => {
      const w = window as unknown as {
        __scroll: { api: { current: { dictationTarget(): { blockId: string } | null } } }
      }
      return w.__scroll.api.current.dictationTarget()?.blockId === anchorId
    },
    targetId,
  )

  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && active.dataset.blockId) active.blur()
  })

  // Scroll a few blocks down so the caret's block sits just above the fold — off-screen but still in
  // the measured band, so its growth adds real height the camera must absorb (a meaningful anti-jump).
  await page.evaluate((scrollSel) => {
    const w = window as unknown as { __scroll: { doc: unknown; blockOrder: (d: unknown) => string[] } }
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const anchorTop = w.__scroll.blockOrder(w.__scroll.doc)[7]
    const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorTop)}"]`)
    if (el) canvas.scrollTop += el.getBoundingClientRect().top - canvas.getBoundingClientRect().top
  }, SCROLL_SELECTOR)
  await settle(page)

  // Baseline camera state captured immediately before dictation isolates the commit's effect.
  const before = await readMetrics(page)
  expect(before.anchorId, 'a mid-doc anchor is resolved').toBeTruthy()
  expect(before.scrollTop, 'scrolled off the top').toBeGreaterThan(100)
  expect(before.nodeCount, 'still virtualized').toBeLessThan(200)
  expect(before.anchorId, 'caret target is off-screen, camera anchored elsewhere').not.toBe(targetId)

  // Start dictation and stream an interim tail — the preview overlay must show it, unpersisted.
  await page.evaluate(() => {
    const w = window as unknown as {
      __scroll: { voice: { transcriber: { start(): void; emitInterim(t: string): void } } }
    }
    w.__scroll.voice.transcriber.start()
    w.__scroll.voice.transcriber.emitInterim('quick brown')
  })

  const interim = page.locator('[data-mic-interim] .mic-interim-text')
  await expect(interim).toBeVisible()
  await expect(interim).toHaveText('quick brown')

  // Interim is preview-only: the document is untouched until a final arrives.
  const midDoc = await page.evaluate((anchorId) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; blockTextString: (d: unknown, id: string) => string | null }
    }
    return w.__scroll.blockTextString(w.__scroll.doc, anchorId) ?? ''
  }, targetId)
  expect(midDoc, 'interim never mutates the doc').toBe(baseline)

  // Commit a final — it must land at the caret in the off-screen target block.
  const FINAL = 'quick brown fox jumps over the lazy dog'
  await page.evaluate((text) => {
    const w = window as unknown as {
      __scroll: { voice: { transcriber: { emitFinal(t: string): void } } }
    }
    w.__scroll.voice.transcriber.emitFinal(text)
  }, FINAL)
  await settle(page)

  const afterDoc = await page.evaluate((anchorId) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; blockTextString: (d: unknown, id: string) => string | null }
    }
    return w.__scroll.blockTextString(w.__scroll.doc, anchorId) ?? ''
  }, targetId)
  expect(afterDoc, 'final text landed at the caret').toContain(FINAL)
  expect(afterDoc.startsWith(baseline), 'inserted at end, preserving prior text').toBe(true)

  // Editing an off-screen block must not move the on-screen anchored camera (P0/P4 anti-jump discipline).
  const after = await readMetrics(page)
  expect(after.anchorId, 'anchor identity unchanged').toBe(before.anchorId)
  expect(
    Math.abs(after.relTop - before.relTop),
    'anchored block holds its on-screen offset — camera does not jump',
  ).toBeLessThanOrEqual(1.5)

  await page.evaluate(() => {
    const w = window as unknown as { __scroll: { voice: { transcriber: { stop(): void } } } }
    w.__scroll.voice.transcriber.stop()
  })
  await expect(page.locator('[data-mic-interim]')).toHaveCount(0)
})
