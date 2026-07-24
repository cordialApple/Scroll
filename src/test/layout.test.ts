import { describe, it, expect } from 'vitest'
import { computeLayout, deriveAnchor, windowFor, type HeightModel, type Window } from '../layout/layout'

const order = Array.from({ length: 100 }, (_, i) => `b${i}`)

function hm(estimate = 30): HeightModel {
  const measured = new Map<string, number>()
  for (let i = 40; i < 60; i++) measured.set(`b${i}`, 50 + (i % 7) * 3)
  return { measured, estimate: () => estimate }
}

describe('layout math', () => {
  it('deriveAnchor is the exact inverse of computeLayout scrollTop', () => {
    const h = hm()
    const window: Window = { start: 40, end: 60 }
    for (const offset of [0, 10, 25]) {
      const anchor = { blockId: 'b50', offset }
      const { scrollTop } = computeLayout(order, h, window, anchor)
      expect(deriveAnchor(scrollTop, order, h)).toEqual(anchor)
    }
  })

  it('anchorOffsetTop equals the cumulative height before the anchor', () => {
    const h = hm()
    const window: Window = { start: 40, end: 60 }
    const r = computeLayout(order, h, window, { blockId: 'b50', offset: 0 })
    let expected = 0
    for (let i = 0; i < 50; i++) expected += h.measured.get(`b${i}`) ?? 30
    expect(r.anchorOffsetTop).toBe(expected)
  })

  it('windowFor keeps the anchor inside the returned window', () => {
    const h = hm()
    const anchor = { blockId: 'b50', offset: 0 }
    const w = windowFor(order, h, anchor, 800, 400)
    const idx = order.indexOf(anchor.blockId)
    expect(idx).toBeGreaterThanOrEqual(w.start)
    expect(idx).toBeLessThan(w.end)
  })

  it('contentHeight covers the whole document', () => {
    const h = hm()
    const window: Window = { start: 40, end: 60 }
    const r = computeLayout(order, h, window, { blockId: 'b50', offset: 0 })
    let total = 0
    for (const id of order) total += h.measured.get(id) ?? 30
    expect(r.contentHeight).toBe(total)
  })
})
