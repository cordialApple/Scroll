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
const cam = (blockId: string, lastSeenMs = 0, clientId = 1): GuardCamera => ({ clientId, blockId, lastSeenMs })
const bySuffix = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1))

function input(over: Partial<GuardInput> & Pick<GuardInput, 'order'>): GuardInput {
  return { cameras: [], awarenessKnown: true, now: 0, ...over }
}

describe('residencyBand', () => {
  it('returns the ±radius window around a mid-document block', () => {
    expect(residencyBand(order(20), 'b10', 4)).toEqual(['b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12', 'b13', 'b14'])
  })
  it('clamps at the document start and end', () => {
    expect(residencyBand(order(20), 'b1', 4)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'])
    expect(residencyBand(order(6), 'b5', 4)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
  })
  it('is empty for an unknown block', () => {
    expect(residencyBand(order(5), 'ghost', 4)).toEqual([])
  })
})

describe('guardedBlocks', () => {
  it('guards exactly the ±radius band of a single live camera; the rest is cold', () => {
    const inp = input({ order: order(20), cameras: [cam('b10')] })
    expect([...guardedBlocks(inp)].sort(bySuffix)).toEqual(residencyBand(order(20), 'b10', 4))
    expect(coldBlocks(inp)).not.toContain('b10')
    expect(coldBlocks(inp)).toContain('b0')
  })

  it('unions overlapping camera bands', () => {
    const inp = input({ order: order(20), cameras: [cam('b5', 0, 1), cam('b8', 0, 2)] })
    expect([...guardedBlocks(inp)].sort(bySuffix)).toEqual(order(20).slice(1, 13))
  })

  it('always guards pinned blocks, even far from any camera', () => {
    const inp = input({ order: order(20), cameras: [cam('b1')], pinned: ['b19'] })
    expect(isGuarded(inp, 'b19')).toBe(true)
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
    const base = input({ order: order(20), cameras: [cam('b10', 0)] })
    expect(isGuarded({ ...base, now: DEFAULT_GRACE_MS }, 'b10')).toBe(true)
    expect(isGuarded({ ...base, now: DEFAULT_GRACE_MS + 1 }, 'b10')).toBe(false)
  })

  it('fails closed to the whole document when a known camera cannot be placed', () => {
    expect(guardedBlocks(input({ order: order(10), cameras: [cam('ghost')] })).size).toBe(10)
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
