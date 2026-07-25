import { describe, it, expect } from 'vitest'
import { buildOrderIndex } from '../layout/orderIndex'

const H: Record<string, number> = { a: 50, b: 70, c: 30, d: 90 }

function ix() {
  return buildOrderIndex(['a', 'b', 'c', 'd'], (id) => H[id])
}

describe('OrderIndex', () => {
  it('reports positions and prefix heights', () => {
    const i = ix()
    expect(i.size()).toBe(4)
    expect(i.indexOf('c')).toBe(2)
    expect(i.indexOf('missing')).toBe(-1)
    expect(i.prefixHeight(0)).toBe(0)
    expect(i.prefixHeight(2)).toBe(120)
    expect(i.heightBefore('c')).toBe(120)
    expect(i.totalHeight()).toBe(240)
  })

  it('findByOffset matches deriveAnchor boundary behavior', () => {
    const i = ix()
    expect(i.findByOffset(-10)).toEqual({ id: 'a', offset: 0 })
    expect(i.findByOffset(0)).toEqual({ id: 'a', offset: 0 })
    expect(i.findByOffset(130)).toEqual({ id: 'c', offset: 10 })
    expect(i.findByOffset(240)).toEqual({ id: 'd', offset: 90 })
    expect(i.findByOffset(999)).toEqual({ id: 'd', offset: 849 })
  })

  it('insertAfter / remove / setHeight keep order and sums consistent', () => {
    const i = ix()
    i.insertAfter('b', 'x', 20)
    expect(i.order()).toEqual(['a', 'b', 'x', 'c', 'd'])
    expect(i.prefixHeight(3)).toBe(140)
    i.remove('a')
    expect(i.order()).toEqual(['b', 'x', 'c', 'd'])
    expect(i.totalHeight()).toBe(210)
    i.setHeight('x', 25)
    expect(i.prefixHeight(2)).toBe(95)
  })

  it('insertAfter null prepends; empty index is inert', () => {
    const i = buildOrderIndex([], () => 0)
    expect(i.findByOffset(5)).toEqual({ id: '', offset: 0 })
    i.insertAfter(null, 'first', 40)
    i.insertAfter(null, 'zero', 10)
    expect(i.order()).toEqual(['zero', 'first'])
    expect(i.prefixHeight(1)).toBe(10)
  })

  it('insertAfter with an unknown afterId appends (matches model.ts idx<0 -> push)', () => {
    const i = ix()
    i.insertAfter('ghost', 'z', 15)
    expect(i.order()).toEqual(['a', 'b', 'c', 'd', 'z'])
  })

  it('absent-id ops are safe no-ops, no NaN into the Fenwick', () => {
    const i = ix()
    i.remove('ghost')
    i.setHeight('ghost', 999)
    expect(i.order()).toEqual(['a', 'b', 'c', 'd'])
    expect(i.totalHeight()).toBe(240)
    expect(i.heightBefore('ghost')).toBe(0)
    expect(i.prefixHeight(99)).toBe(240)
  })
})
