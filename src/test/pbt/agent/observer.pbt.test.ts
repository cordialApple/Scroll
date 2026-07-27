import { describe, it } from 'vitest'
import fc from 'fast-check'
import { observe, type ObserverState } from '../../../agent/observer'
import { guardedBlocks, resolveGraceMs, type GuardCamera, type GuardConfig } from '../../../agent/spatialGuard'
import { trackCameras, type ObservedCamera } from '../../../agent/guardTracker'
import { pbtAssert } from '../harness'

const POOL = Array.from({ length: 40 }, (_, i) => `b${i}`)

// Independent expected guarded set: recomputed straight from the observe() inputs (cameras + prevTracked +
// config), never from observe()'s own `state.tracked` output. A bug in observe's fold OR its config/grace/
// pinned/awareness forwarding surfaces as a mismatch rather than being masked — the P6.4 gate's F-01 (the old
// oracle recomputed from o.tracked, so "target is cold" held by algebra no matter how wrong the fold was).
function expectedGuarded(a: {
  order: string[]
  cameras: ObservedCamera[]
  prevTracked: ReadonlyMap<number, GuardCamera>
  now: number
  awarenessKnown: boolean
  pinned?: Iterable<string>
  config?: Partial<GuardConfig>
}): Set<string> {
  const tracked = trackCameras(a.prevTracked, a.cameras, a.now, resolveGraceMs(a.config))
  return guardedBlocks({
    order: a.order,
    cameras: [...tracked.values()],
    pinned: a.pinned,
    awarenessKnown: a.awarenessKnown,
    now: a.now,
    config: a.config,
  })
}

// order length > any generated band (max 2*buffer+visibleBlocks = 2*3+4 = 10) so partial guarded/cold splits
// dominate — the regime where selectNext's ranking among several cold candidates is actually exercised.
// Cameras are drawn from `order` (always placeable) so bands leave cold regions instead of failing closed.
const scenarioArb = fc.integer({ min: 18, max: 40 }).chain((len) => {
  const order = POOL.slice(0, len)
  const idArb = fc.constantFrom(...order)
  const clientArb = fc.integer({ min: 1, max: 6 })
  return fc.record({
    order: fc.constant(order),
    cameras: fc.array(fc.record({ clientId: clientArb, blockId: idArb }), { maxLength: 3 }),
    prevTracked: fc.array(
      fc.record({ clientId: clientArb, blockId: idArb, lastSeenMs: fc.integer({ min: 0, max: 200_000 }) }),
      { maxLength: 3 },
    ),
    lruEntries: fc.array(fc.tuple(idArb, fc.integer({ min: 0, max: 300_000 })), { maxLength: 12 }),
    now: fc.integer({ min: 0, max: 300_000 }),
    awarenessKnown: fc.boolean(),
    pinned: fc.subarray(order, { maxLength: 3 }),
    config: fc.record({
      visibleBlocks: fc.integer({ min: 1, max: 4 }),
      buffer: fc.integer({ min: 0, max: 3 }),
      graceMs: fc.integer({ min: 1, max: 150_000 }),
    }),
  })
})

describe('PBT: observe never selects a guarded block — independent oracle (P6.4)', () => {
  it('target is never in the independently-recomputed guarded set, and null iff all guarded', () => {
    pbtAssert(
      fc.property(scenarioArb, (s) => {
        const prevTracked = new Map<number, GuardCamera>(
          s.prevTracked.map((c) => [c.clientId, { clientId: c.clientId, blockId: c.blockId, lastSeenMs: c.lastSeenMs }]),
        )
        const base = { order: s.order, cameras: s.cameras, now: s.now, awarenessKnown: s.awarenessKnown, pinned: s.pinned, config: s.config }
        const state: ObserverState = { tracked: prevTracked, lru: { lastWorked: new Map(s.lruEntries) } }
        const o = observe({ ...base, state })
        const guarded = expectedGuarded({ ...base, prevTracked })
        if (o.targetId !== null && guarded.has(o.targetId)) return false
        return (o.targetId === null) === s.order.every((id) => guarded.has(id))
      }),
    )
  })
})
