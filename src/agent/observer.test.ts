import { describe, it, expect } from 'vitest'
import { observe } from './observer'
import { emptyLru, markWorked } from './coldScheduler'
import { trackCameras } from './guardTracker'
import { guardedBlocks, type GuardCamera } from './spatialGuard'
import type { RemoteCamera } from '../doc/awareness'

const order = Array.from({ length: 30 }, (_, i) => `b${i}`)
const cam = (clientId: number, blockId: string): RemoteCamera => ({
  clientId,
  raw: { blockId, offset: 0 },
  anchor: { blockId, offset: 0 },
})

describe('observe — pure agent observation tick (P6.4)', () => {
  it('selects a cold block, never one inside a live camera band', () => {
    const o = observe({ order, remotes: [cam(1, 'b15')], prevTracked: new Map(), lru: emptyLru, now: 1000, awarenessKnown: true })
    expect(o.targetId).not.toBeNull()
    const guarded = guardedBlocks({ order, cameras: [...o.tracked.values()], awarenessKnown: true, now: 1000 })
    expect(guarded.has(o.targetId!)).toBe(false)
  })

  it('fails closed: unknown awareness yields no target and an empty cold set', () => {
    const o = observe({ order, remotes: [], prevTracked: new Map(), lru: emptyLru, now: 0, awarenessKnown: false })
    expect(o.targetId).toBeNull()
    expect(o.cold).toEqual([])
  })

  it('keeps a just-dropped camera guarded within grace, releasing its band past grace', () => {
    const prev = trackCameras(new Map<number, GuardCamera>(), [{ clientId: 1, blockId: 'b15' }], 0, 1000)
    const near = observe({ order, remotes: [], prevTracked: prev, lru: emptyLru, now: 500, awarenessKnown: true, config: { graceMs: 1000 } })
    expect(near.cold).not.toContain('b15')
    const past = observe({ order, remotes: [], prevTracked: prev, lru: emptyLru, now: 2000, awarenessKnown: true, config: { graceMs: 1000 } })
    expect(past.cold).toContain('b15')
  })

  it('threads the LRU so a later tick moves past an already-worked target', () => {
    const remotes = [cam(1, 'b25')]
    const first = observe({ order, remotes, prevTracked: new Map(), lru: emptyLru, now: 10, awarenessKnown: true })
    const lru2 = markWorked(emptyLru, first.targetId!, 10, order)
    const second = observe({ order, remotes, prevTracked: new Map(), lru: lru2, now: 20, awarenessKnown: true })
    expect(second.targetId).not.toBe(first.targetId)
  })
})
