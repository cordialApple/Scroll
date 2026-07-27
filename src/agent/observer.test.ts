import { describe, it, expect } from 'vitest'
import { observe } from './observer'
import { emptyLru, markWorked } from './coldScheduler'
import type { RemoteCamera } from '../doc/awareness'

const order = Array.from({ length: 30 }, (_, i) => `b${i}`)
const cam = (clientId: number, blockId: string): RemoteCamera => ({
  clientId,
  raw: { blockId, offset: 0 },
  anchor: { blockId, offset: 0 },
})

describe('observe — pure agent observation tick (P6.4)', () => {
  it('selects a cold block, never one inside a live camera band (independently-computed band)', () => {
    const o = observe({ order, remotes: [cam(1, 'b15')], prevTracked: new Map(), lru: emptyLru, now: 1000, awarenessKnown: true })
    expect(o.targetId).not.toBeNull()
    const band = new Set(order.slice(11, 23)) // b15 index 15, default band [15-4, 15+(4-1)+4] = [11, 22]
    expect(band.has(o.targetId!)).toBe(false)
  })

  it('fails closed: unknown awareness yields no target and an empty cold set', () => {
    const o = observe({ order, remotes: [], prevTracked: new Map(), lru: emptyLru, now: 0, awarenessKnown: false })
    expect(o.targetId).toBeNull()
    expect(o.cold).toEqual([])
  })

  it('forwards pinned to the guard: a pinned block is never cold, even far from any camera', () => {
    const o = observe({ order, remotes: [cam(1, 'b2')], prevTracked: new Map(), lru: emptyLru, now: 0, awarenessKnown: true, pinned: ['b25'] })
    expect(o.cold).not.toContain('b25')
    expect(o.targetId).not.toBe('b25')
  })

  it('threads tracked across ticks: a chained dropped camera stays guarded within grace, releases past it', () => {
    const config = { graceMs: 1000 }
    const t1 = observe({ order, remotes: [cam(1, 'b15')], prevTracked: new Map(), lru: emptyLru, now: 0, awarenessKnown: true, config })
    expect(t1.cold).not.toContain('b15')
    const t2 = observe({ order, remotes: [], prevTracked: t1.tracked, lru: emptyLru, now: 500, awarenessKnown: true, config })
    expect(t2.cold).not.toContain('b15') // dropped, but chained grace still guards it
    const t3 = observe({ order, remotes: [], prevTracked: t2.tracked, lru: emptyLru, now: 1500, awarenessKnown: true, config })
    expect(t3.cold).toContain('b15') // past grace, released
  })

  it('threads the LRU so a later tick moves past an already-worked target', () => {
    const remotes = [cam(1, 'b25')]
    const first = observe({ order, remotes, prevTracked: new Map(), lru: emptyLru, now: 10, awarenessKnown: true })
    const lru2 = markWorked(emptyLru, first.targetId!, 10, order)
    const second = observe({ order, remotes, prevTracked: new Map(), lru: lru2, now: 20, awarenessKnown: true })
    expect(second.targetId).not.toBe(first.targetId)
  })

  // F-02 (carry-forward #66): the agent folds cameras via the laundered RemoteCamera.anchor (→ order[0] for a
  // vanished block), so a reader whose block was hard-deleted with no redirect is NOT treated as unplaceable
  // — guardedBlocks' fail-closed branch never fires and the agent under-guards that reader's true region. The
  // authority's non-laundering liveCameras (spatialProposalGuard.ts) handles this; the agent needs the P6.5
  // driver's redirect table to match. SKIP: asserts the fail-closed intent; un-skipped it FAILS today
  // (observe guards only the band around order[0] and picks a cold target elsewhere).
  it.skip('P6.5 (#66): fails closed when a reader block was hard-deleted with no redirect (laundered camera)', () => {
    const laundered: RemoteCamera = { clientId: 1, raw: { blockId: 'ghost', offset: 0 }, anchor: { blockId: order[0], offset: 0 } }
    const o = observe({ order, remotes: [laundered], prevTracked: new Map(), lru: emptyLru, now: 0, awarenessKnown: true })
    expect(o.targetId).toBeNull()
  })
})
