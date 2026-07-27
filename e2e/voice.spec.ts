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

  // Scroll mid-document so the camera anchors on-screen with rendered content off-screen above it.
  await page.evaluate((scrollSel) => {
    const canvas = document.querySelector(scrollSel) as HTMLElement
    canvas.scrollTop = Math.round((canvas.scrollHeight - canvas.clientHeight) * 0.4)
  }, SCROLL_SELECTOR)
  await settle(page)

  // Select (via a Range, NOT focus() — which would scroll-into-view) the end of a block that sits fully
  // below the viewport: off-screen, yet rendered/measured so its growth is real. Growth below the camera
  // must not move the on-screen anchor — the relative-anchoring guarantee for edits happening elsewhere.
  const setup = await page.evaluate((scrollSel) => {
    const w = window as unknown as {
      __scroll: { doc: unknown; blockTextString: (d: unknown, id: string) => string | null }
    }
    const canvas = document.querySelector(scrollSel) as HTMLElement
    const contBottom = canvas.getBoundingClientRect().top + canvas.clientHeight
    const below = [...canvas.querySelectorAll<HTMLElement>('[data-block-id]')].filter(
      (el) => el.getBoundingClientRect().top >= contBottom - 0.5,
    )
    const el = below[0]
    const targetId = el.dataset.blockId!
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    return {
      targetId,
      baseline: w.__scroll.blockTextString(w.__scroll.doc, targetId) ?? '',
      height: Math.round(el.getBoundingClientRect().height),
    }
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

  // Selecting inside the contentEditable focused it; blur so the commit re-renders the block into the
  // DOM (Block skips innerText sync while focused). The caret target persists in the editor after blur.
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && active.dataset.blockId) active.blur()
  })
  await settle(page)

  // Baseline camera state captured immediately before dictation isolates the commit's effect.
  const before = await readMetrics(page)
  expect(before.anchorId, 'a mid-doc anchor is resolved').toBeTruthy()
  expect(before.scrollTop, 'scrolled off the top').toBeGreaterThan(100)
  expect(before.nodeCount, 'still virtualized').toBeLessThan(200)
  expect(before.anchorId, 'caret target is off-screen below, camera anchored above it').not.toBe(targetId)

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

  // Commit a final long enough to wrap several lines — it lands at the caret AND grows the off-screen
  // block's real height, so the anti-jump assertion below is exercising genuine compensation, not a no-op.
  const FINAL = `quick brown fox ${'jumps over the lazy dog '.repeat(12)}`.trim()
  await page.evaluate((text) => {
    const w = window as unknown as {
      __scroll: { voice: { transcriber: { emitFinal(t: string): void } } }
    }
    w.__scroll.voice.transcriber.emitFinal(text)
  }, FINAL)
  await settle(page)

  const result = await page.evaluate(
    ({ scrollSel, anchorId }) => {
      const w = window as unknown as {
        __scroll: { doc: unknown; blockTextString: (d: unknown, id: string) => string | null }
      }
      const canvas = document.querySelector(scrollSel) as HTMLElement
      const el = canvas.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchorId)}"]`)
      return {
        text: w.__scroll.blockTextString(w.__scroll.doc, anchorId) ?? '',
        height: el ? Math.round(el.getBoundingClientRect().height) : -1,
      }
    },
    { scrollSel: SCROLL_SELECTOR, anchorId: targetId },
  )
  expect(result.text, 'final text landed at the caret').toContain(FINAL)
  expect(result.text.startsWith(baseline), 'inserted at end, preserving prior text').toBe(true)
  expect(
    result.height,
    'the off-screen edited block actually grew (anti-jump assertion is non-vacuous)',
  ).toBeGreaterThan(setup.height)

  // Editing an off-screen block that demonstrably grew must not move the on-screen camera (P0/P4 anti-jump).
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
