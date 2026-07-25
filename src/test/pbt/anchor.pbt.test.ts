import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import {
  createDoc,
  appendBlock,
  blocks,
  blockId,
  blockText,
  makeBlock,
  blockOrder,
  indexOfBlock,
  redirectSource,
  setBlockText,
  mergeIntoPrevious,
} from '../../doc/model'
import { resolveEffectiveAnchor } from '../../doc/anchor'
import {
  computeLayout,
  computeLayoutIndexed,
  deriveAnchor,
  windowFor,
  windowForIndexed,
  sumHeights,
  type Anchor,
  type HeightModel,
} from '../../layout/layout'
import { buildOrderIndex } from '../../layout/orderIndex'
import { pbtAssert, withDeterminism } from './harness'

function trueHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return 50 + (h % 71)
}

function measuredAll(order: string[]): HeightModel {
  const measured = new Map<string, number>()
  for (const id of order) measured.set(id, trueHeight(id))
  return { measured, estimate: () => 40 }
}

// anti-jump: heights above camera UNKNOWN (bad estimate) — only anchor measured; re-derive from anchor must still pin camera
function measuredAnchorOnly(anchorId: string): HeightModel {
  return { measured: new Map([[anchorId, trueHeight(anchorId)]]), estimate: () => 30 }
}

// text-length estimate (live from doc) — editOther actually moves height, not a no-op
function textLenAnchorOnly(doc: Y.Doc, anchorId: string): HeightModel {
  return {
    measured: new Map([[anchorId, trueHeight(anchorId)]]),
    estimate: (id: string) => {
      const i = indexOfBlock(doc, id)
      return i < 0 ? 30 : 30 + blockText(blocks(doc).get(i)).toString().length
    },
  }
}

function buildDoc(n: number): Y.Doc {
  const doc = createDoc()
  for (let i = 0; i < n; i++) appendBlock(doc, 'paragraph', `block ${i}`)
  return doc
}

type Op =
  | { k: 'insertAbove'; n: number }
  | { k: 'insertBelow'; n: number }
  | { k: 'deleteAbove'; n: number }
  | { k: 'deleteBelow'; n: number }
  | { k: 'editOther'; rel: number; text: string }

// ops anchor-relative, never touch anchor block itself
function applyOp(doc: Y.Doc, anchorId: string, op: Op): void {
  const idx = indexOfBlock(doc, anchorId)
  if (idx < 0) return
  const arr = blocks(doc)
  switch (op.k) {
    case 'insertAbove': {
      const items = Array.from({ length: op.n }, (_, i) => makeBlock('paragraph', `above ${i}`))
      doc.transact(() => arr.insert(idx, items))
      break
    }
    case 'insertBelow': {
      const items = Array.from({ length: op.n }, (_, i) => makeBlock('paragraph', `below ${i}`))
      doc.transact(() => arr.insert(idx + 1, items))
      break
    }
    case 'deleteAbove': {
      const n = Math.min(op.n, idx)
      if (n > 0) doc.transact(() => arr.delete(idx - n, n))
      break
    }
    case 'deleteBelow': {
      const n = Math.min(op.n, arr.length - idx - 1)
      if (n > 0) doc.transact(() => arr.delete(idx + 1, n))
      break
    }
    case 'editOther': {
      if (arr.length <= 1) break
      let t = op.rel % arr.length
      if (t === idx) t = (idx + 1) % arr.length
      setBlockText(doc, blockId(arr.get(t)), op.text)
      break
    }
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant('insertAbove' as const), n: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constant('insertBelow' as const), n: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constant('deleteAbove' as const), n: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constant('deleteBelow' as const), n: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constant('editOther' as const), rel: fc.nat(), text: fc.string({ maxLength: 24 }) }),
)

const opsArb = fc.array(opArb, { minLength: 1, maxLength: 30 })
const sizeArb = fc.integer({ min: 2, max: 40 })

const structOpArb = fc.oneof(
  fc.record({ k: fc.constant('ins' as const), sel: fc.nat(), hv: fc.nat() }),
  fc.record({ k: fc.constant('rem' as const), sel: fc.nat() }),
  fc.record({ k: fc.constant('set' as const), sel: fc.nat(), hv: fc.nat() }),
)
const probeArb = fc.record({
  missing: fc.boolean(),
  aSel: fc.nat(),
  negOff: fc.boolean(),
  offMag: fc.nat(),
  wsSel: fc.nat(),
  weSel: fc.nat(),
  vp: fc.nat(),
})

describe('PBT: relative-anchoring invariants (generalized P0 anti-jump, in-memory)', () => {
  it('anchor identity + content survive arbitrary non-anchor mutations', () => {
    pbtAssert(
      fc.property(sizeArb, fc.nat(), opsArb, fc.nat(), (base, anchorSel, ops, offSel) => {
        const doc = buildDoc(base)
        const order0 = blockOrder(doc)
        const anchorId = order0[anchorSel % base]
        const anchorText0 = blockText(blocks(doc).get(anchorSel % base)).toString()
        const off = offSel % Math.floor(trueHeight(anchorId))

        for (const op of ops) applyOp(doc, anchorId, op)

        const order1 = blockOrder(doc)
        if (!order1.includes(anchorId)) return false

        const eff = resolveEffectiveAnchor(order1, redirectSource(doc), { blockId: anchorId, offset: off })
        if (eff.blockId !== anchorId || eff.offset !== off) return false

        const idx1 = indexOfBlock(doc, anchorId)
        return blockText(blocks(doc).get(idx1)).toString() === anchorText0
      }),
    )
  })

  it('camera content is invariant under mutation even with wrong heights above (anti-jump)', () => {
    pbtAssert(
      fc.property(sizeArb, fc.nat(), opsArb, fc.nat(), (base, anchorSel, ops, offSel) => {
        const doc = buildDoc(base)
        const anchorId = blockOrder(doc)[anchorSel % base]
        const off = offSel % trueHeight(anchorId)

        for (const op of ops) applyOp(doc, anchorId, op)

        const order1 = blockOrder(doc)
        if (!order1.includes(anchorId)) return false
        const hm = measuredAnchorOnly(anchorId)
        const anchor: Anchor = { blockId: anchorId, offset: off }
        const window = { start: 0, end: order1.length }

        const scrollTop = computeLayout(order1, hm, window, anchor).scrollTop
        const camera = deriveAnchor(scrollTop, order1, hm)
        return camera.blockId === anchorId && camera.offset === off
      }),
    )
  })

  // cross-order: apply PRE-mutation scrollTop to POST-mutation deriveAnchor (real remote-edit case) — camera must stay
  // in-doc, offset>=0 (naive-derive bug), fixed pt of compute∘derive; editOther needs text-len heights
  it('a scrollTop persisted across a mutation derives a well-formed, non-negative, idempotent camera', () => {
    pbtAssert(
      fc.property(sizeArb, fc.nat(), opsArb, fc.nat(), (base, anchorSel, ops, offSel) => {
        const doc = buildDoc(base)
        const anchorId = blockOrder(doc)[anchorSel % base]
        const off = offSel % trueHeight(anchorId)
        const hm = textLenAnchorOnly(doc, anchorId)
        const fullWin = () => ({ start: 0, end: blockOrder(doc).length })

        const scrollTop0 = computeLayout(blockOrder(doc), hm, fullWin(), { blockId: anchorId, offset: off }).scrollTop

        for (const op of ops) applyOp(doc, anchorId, op)
        const order1 = blockOrder(doc)
        if (!order1.includes(anchorId)) return true

        const naive = deriveAnchor(scrollTop0, order1, hm)
        if (naive.offset < 0) return false
        if (!order1.includes(naive.blockId)) return false

        const st = computeLayout(order1, hm, fullWin(), naive).scrollTop
        const again = deriveAnchor(st, order1, hm)
        return again.blockId === naive.blockId && again.offset === naive.offset
      }),
    )
  })

  it('merged-away anchor redirects to its successor, never a document-top jump', () => {
    pbtAssert(
      fc.property(sizeArb, fc.nat(), (base, sel) => {
        const doc = buildDoc(base)
        const order0 = blockOrder(doc)
        const anchorIdx = 1 + (sel % (base - 1))
        const anchorId = order0[anchorIdx]
        const predId = order0[anchorIdx - 1]

        if (mergeIntoPrevious(doc, anchorId) !== predId) return false

        const order1 = blockOrder(doc)
        const eff = resolveEffectiveAnchor(order1, redirectSource(doc), { blockId: anchorId, offset: 5 })
        return eff.blockId === predId && order1.includes(eff.blockId) && eff.offset === 0
      }),
    )
  })

  // indexed must match array not just fresh-built index but one driven via insertAfter/remove/setHeight (perf path),
  // incl edge cases: missing anchor, oob/neg window, neg offset, n=0/1
  it('indexed layout twins equal array layout across structural mutations + edge probes (perf S2)', () => {
    pbtAssert(
      fc.property(sizeArb, fc.array(structOpArb, { maxLength: 30 }), fc.array(probeArb, { minLength: 1, maxLength: 6 }), (base, ops, probes) => {
        const order: string[] = Array.from({ length: base }, (_, i) => `b${i}`)
        const h = new Map<string, number>(order.map((id) => [id, trueHeight(id)]))
        const ix = buildOrderIndex(order, (id) => h.get(id) ?? 40)
        let ctr = 0

        for (const op of ops) {
          if (op.k === 'ins') {
            const at = order.length === 0 ? -1 : op.sel % order.length
            const id = `n${ctr++}`
            const height = 50 + (op.hv % 71)
            order.splice(at + 1, 0, id)
            h.set(id, height)
            ix.insertAfter(at < 0 ? null : order[at], id, height)
          } else if (order.length > 0 && op.k === 'rem') {
            const id = order[op.sel % order.length]
            order.splice(order.indexOf(id), 1)
            h.delete(id)
            ix.remove(id)
          } else if (op.k === 'set' && order.length > 0) {
            const id = order[op.sel % order.length]
            const height = 50 + (op.hv % 71)
            h.set(id, height)
            ix.setHeight(id, height)
          }
        }

        const hm: HeightModel = { measured: h, estimate: () => 40 }
        const n = order.length

        for (const p of probes) {
          const anchorId = p.missing || n === 0 ? '__absent__' : order[p.aSel % n]
          const anchor: Anchor = { blockId: anchorId, offset: p.negOff ? -(p.offMag % 50) : p.offMag % 50 }
          const window = { start: (p.wsSel % (n + 3)) - 1, end: (p.weSel % (n + 3)) - 1 }

          if (JSON.stringify(computeLayout(order, hm, window, anchor)) !== JSON.stringify(computeLayoutIndexed(ix, window, anchor)))
            return false

          const vp = 200 + (p.vp % 1400)
          const w1 = windowFor(order, hm, anchor, vp, 1200)
          const w2 = windowForIndexed(ix, anchor, vp, 1200)
          if (w1.start !== w2.start || w1.end !== w2.end) return false
        }
        return true
      }),
    )
  })

  it('windowFor brackets the anchor and computeLayout partitions the full content height', () => {
    pbtAssert(
      fc.property(sizeArb, fc.nat(), fc.integer({ min: 200, max: 1600 }), (base, sel, viewportH) => {
        const doc = buildDoc(base)
        const order = blockOrder(doc)
        const anchorId = order[sel % base]
        const anchorIdx = order.indexOf(anchorId)
        const hm = measuredAll(order)
        const anchor: Anchor = { blockId: anchorId, offset: 0 }

        const overscan = 1200
        const win = windowFor(order, hm, anchor, viewportH, overscan)
        if (!(win.start >= 0 && win.start <= anchorIdx && anchorIdx < win.end && win.end <= order.length))
          return false

        // tight bounds: overscan must not hide off-by-one. above band=viewportH+overscan, below=2*viewportH+overscan.
        // assert coverage AND minimality (one block narrower falls short) — bracket-only assert misses minimality
        const aboveBand = viewportH + overscan
        const belowBand = viewportH * 2 + overscan
        const aboveSum = sumHeights(order, hm, win.start, anchorIdx)
        if (!(win.start === 0 || aboveSum >= aboveBand)) return false
        if (anchorIdx > 0 && sumHeights(order, hm, win.start + 1, anchorIdx) >= aboveBand) return false
        const belowSum = sumHeights(order, hm, anchorIdx + 1, win.end)
        if (!(win.end === order.length || belowSum >= belowBand)) return false
        if (win.end > anchorIdx + 1 && sumHeights(order, hm, anchorIdx + 1, win.end - 1) >= belowBand)
          return false

        const layout = computeLayout(order, hm, win, anchor)
        const total = sumHeights(order, hm, 0, order.length)
        const windowHeight = sumHeights(order, hm, win.start, win.end)
        return (
          layout.contentHeight === total &&
          layout.topSpacer + windowHeight + layout.bottomSpacer === total &&
          layout.topSpacer === sumHeights(order, hm, 0, win.start)
        )
      }),
    )
  })
})

describe('PBT: determinism harness (R1)', () => {
  it('double-run canary: generation is reproducible at a fixed seed', () => {
    const a = fc.sample(opsArb, { seed: 424242, numRuns: 8 })
    const b = fc.sample(opsArb, { seed: 424242, numRuns: 8 })
    expect(a).toEqual(b)
  })

  it('double-run canary: a build+mutate run is byte-identical under determinism (ids neutralized)', () => {
    const run = () =>
      withDeterminism(() => {
        const doc = buildDoc(10)
        const anchorId = blockOrder(doc)[5]
        applyOp(doc, anchorId, { k: 'insertAbove', n: 3 })
        applyOp(doc, anchorId, { k: 'insertBelow', n: 2 })
        return blockOrder(doc)
      })
    expect(run()).toEqual(run())
  })
})
