import { describe, it } from 'vitest'
import fc from 'fast-check'
import { buildOrderIndex } from '../../layout/orderIndex'
import { evictHeightsOutsideBand } from '../../editor/docModel'
import { pbtAssert } from './harness'

function trueHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return 50 + (h % 71)
}

describe('PBT: heightsRef band eviction (perf S5)', () => {
  it('keeps in-band + anchor, drops out-of-band/absent, and leaves ix identical', () => {
    pbtAssert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 0, max: 20 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        (n, winStartSel, winSpanSel, anchorSel, margin, measuredSel) => {
          const order = Array.from({ length: n }, (_, i) => `b${i}`)
          const ix = buildOrderIndex(order, trueHeight)

          const start = winStartSel % (n + 1)
          const end = start + (winSpanSel % (n + 1 - start))
          const window = { start, end }
          const anchorId = order[anchorSel % n]

          // Measured set: a subset of real ids plus some stale ids no longer in the doc.
          const heights = new Map<string, number>()
          for (const s of measuredSel) heights.set(order[s % n], trueHeight(order[s % n]))
          heights.set(anchorId, trueHeight(anchorId))
          heights.set('__gone__', 999)

          const before = new Set(heights.keys())
          const ixOrderBefore = JSON.stringify(ix.order())
          const ixTotalBefore = ix.totalHeight()
          // Camera-derivation probes: findByOffset is the spacer geometry the anchor is derived from
          // on a fling. It must be eviction-independent — the property that guards the onScroll path.
          const pxProbes = [0, Math.floor(ixTotalBefore / 2), ixTotalBefore - 1, ixTotalBefore + 200]
          const camBefore = pxProbes.map((px) => JSON.stringify(ix.findByOffset(px)))

          const lo = start - margin
          const hi = end + margin
          evictHeightsOutsideBand(heights, ix, window, anchorId, margin)

          // ix must be untouched — this is the jump-freedom guarantee.
          if (JSON.stringify(ix.order()) !== ixOrderBefore) return false
          if (ix.totalHeight() !== ixTotalBefore) return false
          for (let i = 0; i < pxProbes.length; i++) {
            if (JSON.stringify(ix.findByOffset(pxProbes[i])) !== camBefore[i]) return false
          }

          // Anchor is never evicted.
          if (!heights.has(anchorId)) return false
          // Absent-from-doc entry is always evicted.
          if (heights.has('__gone__')) return false

          for (const id of before) {
            if (id === anchorId || id === '__gone__') continue
            const idx = ix.indexOf(id)
            const inBand = idx >= lo && idx < hi
            // In-band survivors kept; out-of-band evicted. No spurious add/keep.
            if (inBand && !heights.has(id)) return false
            if (!inBand && heights.has(id)) return false
          }
          return true
        },
      ),
    )
  })
})
