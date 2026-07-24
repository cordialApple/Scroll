import { describe, it, expect } from 'vitest'
import { createDoc, appendBlock, blockOrder, redirectSource, indexOfBlock } from '../doc/model'
import { insertAbove, deleteAbove, mergeIntoPrevious } from '../dev/synthetic'
import { resolveRedirect } from '../doc/redirects'
import {
  computeLayout,
  deriveAnchor,
  type Anchor,
  type HeightModel,
  type Window,
} from '../layout/layout'

function trueHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return 50 + (h % 71)
}

const WRONG_ESTIMATE = () => 30

function buildDoc(n: number) {
  const doc = createDoc()
  for (let i = 0; i < n; i++) appendBlock(doc, 'paragraph', `block ${i}`)
  return doc
}

function measuredWindow(order: string[], w: Window): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = w.start; i < w.end; i++) m.set(order[i], trueHeight(order[i]))
  return m
}

describe('P0 milestone: viewport does not move under above-camera edits (virtualized)', () => {
  it('inserting variable-height content above the camera leaves camera content invariant', () => {
    const doc = buildDoc(1000)
    const order0 = blockOrder(doc)
    const window0: Window = { start: 490, end: 515 }
    const anchor: Anchor = { blockId: order0[500], offset: 15 }
    const hm: HeightModel = { measured: measuredWindow(order0, window0), estimate: WRONG_ESTIMATE }

    const scrollTop0 = computeLayout(order0, hm, window0, anchor).scrollTop
    const cameraContent0 = deriveAnchor(scrollTop0, order0, hm)
    expect(cameraContent0).toEqual(anchor)

    insertAbove(doc, order0[300], 50, 7)
    const order1 = blockOrder(doc)
    const window1: Window = { start: 540, end: 565 }
    expect(order1[window1.start]).toBe(order0[window0.start])

    const scrollTop1 = computeLayout(order1, hm, window1, anchor).scrollTop
    const cameraContent1 = deriveAnchor(scrollTop1, order1, hm)

    expect(cameraContent1).toEqual(cameraContent0)
    expect(scrollTop1).toBeGreaterThan(scrollTop0)

    const naive = deriveAnchor(scrollTop0, order1, hm)
    expect(naive).not.toEqual(anchor)
  })

  it('deleting variable-height content above the camera leaves camera content invariant', () => {
    const doc = buildDoc(1000)
    const order0 = blockOrder(doc)
    const window0: Window = { start: 490, end: 515 }
    const anchor: Anchor = { blockId: order0[500], offset: 42 }
    const hm: HeightModel = { measured: measuredWindow(order0, window0), estimate: WRONG_ESTIMATE }

    const scrollTop0 = computeLayout(order0, hm, window0, anchor).scrollTop
    const before = deriveAnchor(scrollTop0, order0, hm)

    deleteAbove(doc, order0[300], 40)
    const order1 = blockOrder(doc)
    const window1: Window = { start: 450, end: 475 }
    expect(order1[window1.start]).toBe(order0[window0.start])

    const scrollTop1 = computeLayout(order1, hm, window1, anchor).scrollTop
    const after = deriveAnchor(scrollTop1, order1, hm)

    expect(after).toEqual(before)
    expect(scrollTop1).toBeLessThan(scrollTop0)
  })

  it('anchor block merged away: redirect resolves to the successor, no document-top jump', () => {
    const doc = buildDoc(20)
    const order = blockOrder(doc)
    const idA = order[9]
    const idB = order[10]
    const anchor: Anchor = { blockId: idB, offset: 12 }

    const prevId = mergeIntoPrevious(doc, idB)
    expect(prevId).toBe(idA)

    const resolved = resolveRedirect(redirectSource(doc), anchor.blockId, anchor.offset)
    expect(resolved.blockId).toBe(idA)
    expect(resolved.hops).toBe(1)
    expect(indexOfBlock(doc, resolved.blockId)).toBeGreaterThanOrEqual(0)
    expect(indexOfBlock(doc, idB)).toBe(-1)
  })

  it('reload: camera {blockId, offset} restores the same content with only estimates available', () => {
    const doc = buildDoc(1000)
    const order = blockOrder(doc)
    const window: Window = { start: 490, end: 515 }
    const anchor: Anchor = { blockId: order[500], offset: 30 }

    const live: HeightModel = { measured: measuredWindow(order, window), estimate: WRONG_ESTIMATE }
    const persistedScrollTop = computeLayout(order, live, window, anchor).scrollTop
    const contentBefore = deriveAnchor(persistedScrollTop, order, live)

    const fresh: HeightModel = { measured: measuredWindow(order, window), estimate: () => 55 }
    const restoredScrollTop = computeLayout(order, fresh, window, anchor).scrollTop
    const contentAfter = deriveAnchor(restoredScrollTop, order, fresh)

    expect(contentAfter).toEqual(anchor)
    expect(contentBefore).toEqual(anchor)
  })
})
