import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { buildOrderIndex, buildArrayOrderIndex, TreapOrderIndex, type OrderIndex } from '../../layout/orderIndex'
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

// Differential oracle: the treap (buildOrderIndex) must be byte-identical to the array/Fenwick backing
// on EVERY method after any op sequence — including idAt and size, which the naive-oracle PBT skips.
function assertEqual(treap: OrderIndex, array: OrderIndex): boolean {
  if (treap.size() !== array.size()) return false
  if (JSON.stringify(treap.order()) !== JSON.stringify(array.order())) return false
  const n = array.size()
  for (let i = -1; i <= n; i++) if (treap.idAt(i) !== array.idAt(i)) return false
  for (let k = 0; k <= n; k++) if (treap.prefixHeight(k) !== array.prefixHeight(k)) return false
  if (treap.totalHeight() !== array.totalHeight()) return false
  for (const id of array.order()) {
    if (treap.indexOf(id) !== array.indexOf(id)) return false
    if (treap.heightBefore(id) !== array.heightBefore(id)) return false
  }
  const boundaries: number[] = [-5, 0]
  for (let k = 0; k <= n; k++) {
    const p = array.prefixHeight(k)
    boundaries.push(p - 1, p, p + 1)
  }
  boundaries.push(array.totalHeight() + 500)
  for (const px of boundaries) {
    const a = treap.findByOffset(px)
    const b = array.findByOffset(px)
    if (a.id !== b.id || a.offset !== b.offset) return false
  }
  return true
}

describe('PBT: TreapOrderIndex is behavior-identical to the array/Fenwick backing', () => {
  it('every method matches after random insert/remove/setHeight sequences', () => {
    pbtAssert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 300 }), { maxLength: 25 }),
        fc.array(mutArb, { maxLength: 40 }),
        (baseHeights, muts) => {
          const order = baseHeights.map((_, i) => `b${i}`)
          const hmap = new Map<string, number>(order.map((id, i) => [id, baseHeights[i]]))
          const heightOf = (id: string) => hmap.get(id) ?? 0
          const treap = buildOrderIndex([...order], heightOf)
          const array = buildArrayOrderIndex([...order], heightOf)

          for (let mi = 0; mi < muts.length; mi++) {
            const m = muts[mi]
            if (m.k === 'insert') {
              const id = `x${mi}`
              const at = order.length === 0 ? 0 : m.sel % (order.length + 1)
              const afterId = at === 0 ? null : order[at - 1]
              order.splice(at, 0, id)
              hmap.set(id, m.h)
              treap.insertAfter(afterId, id, m.h)
              array.insertAfter(afterId, id, m.h)
            } else if (order.length > 0 && m.k === 'remove') {
              const id = order[m.sel % order.length]
              order.splice(order.indexOf(id), 1)
              treap.remove(id)
              array.remove(id)
            } else if (order.length > 0 && m.k === 'setHeight') {
              const id = order[m.sel % order.length]
              hmap.set(id, m.h)
              treap.setHeight(id, m.h)
              array.setHeight(id, m.h)
            }
            if (!assertEqual(treap, array)) return false
          }
          return true
        },
      ),
    )
  })
})

describe('perf: the treap stays balanced (structural ops are O(log n), not O(n))', () => {
  it('depth after N inserts is within a small constant of log2(N)', () => {
    const N = 8000
    const ix = TreapOrderIndex.build([], () => 0)
    // Interleave appends and mid-inserts so the shape is not accidentally sorted.
    let prev: string | null = null
    for (let i = 0; i < N; i++) {
      const id = `n${i}`
      const afterId = i > 3 && i % 3 === 0 ? `n${(i * 7) % i}` : prev
      ix.insertAfter(afterId, id, 1 + (i % 50))
      prev = id
    }
    expect(ix.size()).toBe(N)
    // A path (broken balancing) would be depth N; a balanced random treap height is ~2.4*log2(N) here.
    // 4*log2 leaves margin above that yet stays far below N, so a balance regression still goes RED.
    const cap = Math.ceil(4 * Math.log2(N))
    expect(ix.depth(), `depth ${ix.depth()} must be <= ${cap} (~log2(${N}))`).toBeLessThanOrEqual(cap)
  })
})
