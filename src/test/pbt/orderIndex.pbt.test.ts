import { describe, it } from 'vitest'
import fc from 'fast-check'
import { buildOrderIndex } from '../../layout/orderIndex'
import { deriveAnchor, sumHeights, type HeightModel } from '../../layout/layout'
import { pbtAssert } from './harness'

type Mut =
  | { k: 'insert'; sel: number; h: number }
  | { k: 'remove'; sel: number }
  | { k: 'setHeight'; sel: number; h: number }

const mutArb: fc.Arbitrary<Mut> = fc.oneof(
  fc.record({ k: fc.constant('insert' as const), sel: fc.nat(), h: fc.integer({ min: 1, max: 300 }) }),
  fc.record({ k: fc.constant('remove' as const), sel: fc.nat() }),
  fc.record({ k: fc.constant('setHeight' as const), sel: fc.nat(), h: fc.integer({ min: 1, max: 300 }) }),
)

describe('PBT: OrderIndex is behavior-identical to the naive layout functions', () => {
  it('indexOf / prefixHeight / totalHeight / findByOffset match after random mutations', () => {
    pbtAssert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 300 }), { maxLength: 30 }),
        fc.array(mutArb, { maxLength: 30 }),
        fc.array(fc.integer({ min: -200, max: 30000 }), { maxLength: 8 }),
        (baseHeights, muts, pxs) => {
          const order = baseHeights.map((_, i) => `b${i}`)
          const hmap = new Map<string, number>(order.map((id, i) => [id, baseHeights[i]]))
          const ix = buildOrderIndex(order, (id) => hmap.get(id) ?? 0)

          for (let mi = 0; mi < muts.length; mi++) {
            const m = muts[mi]
            if (m.k === 'insert') {
              const id = `x${mi}`
              const at = order.length === 0 ? 0 : m.sel % (order.length + 1)
              const afterId = at === 0 ? null : order[at - 1]
              order.splice(at, 0, id)
              hmap.set(id, m.h)
              ix.insertAfter(afterId, id, m.h)
            } else if (order.length > 0 && m.k === 'remove') {
              const i = m.sel % order.length
              const id = order[i]
              order.splice(i, 1)
              ix.remove(id)
            } else if (order.length > 0 && m.k === 'setHeight') {
              const id = order[m.sel % order.length]
              hmap.set(id, m.h)
              ix.setHeight(id, m.h)
            }
            // per-mutation invariant (plan spec): index order tracks naive array exactly
            if (JSON.stringify(ix.order()) !== JSON.stringify(order)) return false
          }

          const hm: HeightModel = { measured: hmap, estimate: () => 0 }
          for (let k = 0; k <= order.length; k++) {
            if (ix.prefixHeight(k) !== sumHeights(order, hm, 0, k)) return false
          }
          if (ix.totalHeight() !== sumHeights(order, hm, 0, order.length)) return false
          for (const id of order) {
            if (ix.indexOf(id) !== order.indexOf(id)) return false
            if (ix.heightBefore(id) !== sumHeights(order, hm, 0, order.indexOf(id))) return false
          }
          // random px + every prefix-sum boundary ±1 (where >/>= off-by-one surfaces)
          const boundaries: number[] = []
          for (let k = 0; k <= order.length; k++) {
            const p = sumHeights(order, hm, 0, k)
            boundaries.push(p - 1, p, p + 1)
          }
          for (const px of [...pxs, ...boundaries]) {
            const a = ix.findByOffset(px)
            const b = deriveAnchor(px, order, hm)
            if (a.id !== b.blockId || a.offset !== b.offset) return false
          }
          return true
        },
      ),
    )
  })
})
