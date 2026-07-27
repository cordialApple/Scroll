import { describe, it, expect } from 'vitest'
import { observe, emptyObserverState, type ObserverState } from './observer'
import { emptyLru, markWorked } from './coldScheduler'
import type { ObservedCamera } from './guardTracker'

const order = Array.from({ length: 30 }, (_, i) => `b${i}`)
const cam = (clientId: number, blockId: string): ObservedCamera => ({ clientId, blockId })
const withLru = (s: ObserverState, lru: ObserverState['lru']): ObserverState => ({ tracked: s.tracked, lru })

describe('observe — pure agent observation tick (P6.4)', () => {
  it('selects a cold block, never one inside a live camera band (independently-computed band)', () => {
    const o = observe({ order, cameras: [cam(1, 'b15')], state: emptyObserverState, now: 1000, awarenessKnown: true })
    expect(o.targetId).not.toBeNull()
    const band = new Set(order.slice(11, 23)) // b15 index 15, default band [15-4, 15+(4-1)+4] = [11, 22]
    expect(band.has(o.targetId!)).toBe(false)
  })

  it('fails closed: unknown awareness yields no target and an empty cold set', () => {
    const o = observe({ order, cameras: [], state: emptyObserverState, now: 0, awarenessKnown: false })
    expect(o.targetId).toBeNull()
    expect(o.cold).toEqual([])
  })

  it('forwards pinned to the guard: a pinned block is never cold, even far from any camera', () => {
    const o = observe({ order, cameras: [cam(1, 'b2')], state: emptyObserverState, now: 0, awarenessKnown: true, pinned: ['b25'] })
    expect(o.cold).not.toContain('b25')
    expect(o.targetId).not.toBe('b25')
  })

  it('threads tracked across ticks: a chained dropped camera stays guarded within grace, releases past it', () => {
    const config = { graceMs: 1000 }
    const t1 = observe({ order, cameras: [cam(1, 'b15')], state: emptyObserverState, now: 0, awarenessKnown: true, config })
    expect(t1.cold).not.toContain('b15')
    const t2 = observe({ order, cameras: [], state: t1.state, now: 500, awarenessKnown: true, config })
    expect(t2.cold).not.toContain('b15') // dropped, but chained grace still guards it
    const t3 = observe({ order, cameras: [], state: t2.state, now: 1500, awarenessKnown: true, config })
    expect(t3.cold).toContain('b15') // past grace, released
  })

  it('threads the LRU so a later tick moves past an already-worked target', () => {
    const cameras = [cam(1, 'b25')]
    const first = observe({ order, cameras, state: emptyObserverState, now: 10, awarenessKnown: true })
    const state2 = withLru(first.state, markWorked(emptyLru, first.targetId!, 10, order))
    const second = observe({ order, cameras, state: state2, now: 20, awarenessKnown: true })
    expect(second.targetId).not.toBe(first.targetId)
  })

  // F-02 (#66), now landed: an unplaceable camera — a reader whose block was hard-deleted with no redirect, so
  // the driver's resolveCameras keeps the raw id, which is NOT in `order` — makes observe guard the WHOLE doc,
  // matching the authority's guardedBlocks. Before P6.5 observe laundered via RemoteCamera.anchor→order[0] and
  // under-guarded; the driver now resolves non-launderingly (see cameraResolve.test.ts) and observe just sees ids.
  it('fails closed when a reader camera is unplaceable (block gone, no redirect)', () => {
    const o = observe({ order, cameras: [cam(1, 'ghost')], state: emptyObserverState, now: 0, awarenessKnown: true })
    expect(o.targetId).toBeNull()
    expect(o.cold).toEqual([])
  })
})
