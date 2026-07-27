import { describe, it, expect } from 'vitest'
import {
  guardedBlocks,
  coldBlocks,
  isGuarded,
  residencyBand,
  DEFAULT_GRACE_MS,
  type GuardCamera,
  type GuardInput,
} from './spatialGuard'

const order = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`)
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, k) => `b${lo + k}`)
const cam = (blockId: string, lastSeenMs = 0, clientId = 1): GuardCamera => ({ clientId, blockId, lastSeenMs })
const bySuffix = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))

function input(over: Partial<GuardInput> & Pick<GuardInput, 'order'>): GuardInput {
  return { cameras: [], awarenessKnown: true, now: 0, ...over }
}

describe('residencyBand', () => {
  it('returns the asymmetric top-anchor band (4 above, 4 visible, 4 below) around a mid block', () => {
    expect(residencyBand(order(30), 'b10')).toEqual(range(6, 17))
  })
  it('clamps at the document start and end', () => {
    expect(residencyBand(order(30), 'b1')).toEqual(range(0, 8))
    expect(residencyBand(order(6), 'b5')).toEqual(range(1, 5))
  })
  it('is empty for an unknown block', () => {
    expect(residencyBand(order(5), 'ghost')).toEqual([])
  })
})

describe('guardedBlocks', () => {
  it('guards exactly the asymmetric top-anchor band of a single live camera; the rest is cold', () => {
    const inp = input({ order: order(30), cameras: [cam('b10')] })
    expect([...guardedBlocks(inp)].sort(bySuffix)).toEqual(range(6, 17))
    expect(coldBlocks(inp)).not.toContain('b10')
    expect(coldBlocks(inp)).toContain('b0')
    expect(coldBlocks(inp)).toContain('b18')
  })

  it('extends the band downward past the anchor (visible span) more than upward (buffer only)', () => {
    const g = guardedBlocks(input({ order: order(30), cameras: [cam('b10')] }))
    expect(g.has('b6')).toBe(true) // 4-block buffer above the top anchor
    expect(g.has('b5')).toBe(false)
    expect(g.has('b17')).toBe(true) // visible span + buffer below
    expect(g.has('b18')).toBe(false)
  })

  it('unions overlapping camera bands', () => {
    const inp = input({ order: order(20), cameras: [cam('b5', 0, 1), cam('b8', 0, 2)] })
    expect([...guardedBlocks(inp)].sort(bySuffix)).toEqual(range(1, 15))
  })

  it('always guards pinned blocks, even far from any camera', () => {
    const inp = input({ order: order(30), cameras: [cam('b1')], pinned: ['b29'] })
    expect(isGuarded(inp, 'b29')).toBe(true)
  })

  it('silently skips a pinned id absent from the order (nothing to guard), unlike an unplaceable camera', () => {
    const inp = input({ order: order(10), pinned: ['ghost'] })
    expect(guardedBlocks(inp).size).toBe(0)
  })

  it('protects the whole document when the peer set is unknown (awareness outage)', () => {
    expect(guardedBlocks(input({ order: order(10), awarenessKnown: false })).size).toBe(10)
  })

  it('leaves the document cold when awareness is known but no camera is present', () => {
    const inp = input({ order: order(10), awarenessKnown: true })
    expect(guardedBlocks(inp).size).toBe(0)
    expect(coldBlocks(inp)).toHaveLength(10)
  })

  it('keeps a dropped camera guarded within grace and releases it after', () => {
    const base = input({ order: order(30), cameras: [cam('b10', 0)] })
    expect(isGuarded({ ...base, now: DEFAULT_GRACE_MS }, 'b10')).toBe(true)
    expect(isGuarded({ ...base, now: DEFAULT_GRACE_MS + 1 }, 'b10')).toBe(false)
  })

  it('fails closed to the whole document when a known camera cannot be placed', () => {
    expect(guardedBlocks(input({ order: order(10), cameras: [cam('ghost')] })).size).toBe(10)
  })

  it('clamps a negative buffer to a still-closed band that includes the camera block', () => {
    const g = guardedBlocks(input({ order: order(10), cameras: [cam('b5')], config: { buffer: -3, visibleBlocks: -2 } }))
    expect(g.has('b5')).toBe(true)
  })

  it('empty order guards and cools to nothing', () => {
    const inp = input({ order: [], cameras: [cam('anything')] })
    expect(guardedBlocks(inp).size).toBe(0)
    expect(coldBlocks(inp)).toEqual([])
  })

  it('partitions the order into guarded and cold', () => {
    const inp = input({ order: order(20), cameras: [cam('b10'), cam('b3', 0, 2)], pinned: ['b18'] })
    const g = guardedBlocks(inp)
    const cold = coldBlocks(inp)
    expect(new Set([...g, ...cold]).size).toBe(20)
    for (const id of cold) expect(g.has(id)).toBe(false)
  })
})
