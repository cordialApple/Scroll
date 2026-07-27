import { describe, it } from 'vitest'
import fc from 'fast-check'
import { observe } from '../../../agent/observer'
import { guardedBlocks, resolveGraceMs, type GuardCamera, type GuardConfig } from '../../../agent/spatialGuard'
import { trackCameras } from '../../../agent/guardTracker'
import type { RemoteCamera } from '../../../doc/awareness'
import { pbtAssert } from '../harness'

const POOL = Array.from({ length: 40 }, (_, i) => `b${i}`)

const makeRemote = (clientId: number, blockId: string): RemoteCamera => ({
  clientId,
  raw: { blockId, offset: 0 },
  anchor: { blockId, offset: 0 },
})

// Independent expected guarded set: recomputed from RAW inputs, resolving cameras the NON-laundering way the
// authority does (raw id kept as-is; an unplaceable raw fails closed inside guardedBlocks). It never consumes
// observe()'s own `tracked` output, so a bug in observe's fold OR its config/grace/pinned forwarding surfaces
// as a mismatch rather than being masked — the P6.4 gate's F-01 (the old oracle recomputed from o.tracked, so
// "target is cold" held by algebra no matter how wrong the resolution was).
function expectedGuarded(a: {
  order: string[]
  remotes: RemoteCamera[]
  prevTracked: ReadonlyMap<number, GuardCamera>
  now: number
  awarenessKnown: boolean
  pinned?: Iterable<string>
  config?: Partial<GuardConfig>
}): Set<string> {
  const live = a.remotes.map((r) => ({ clientId: r.clientId, blockId: r.raw.blockId }))
  const tracked = trackCameras(a.prevTracked, live, a.now, resolveGraceMs(a.config))
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
    remotes: fc.array(fc.record({ clientId: clientArb, blockId: idArb }), { maxLength: 3 }),
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
        const remotes = s.remotes.map((c) => makeRemote(c.clientId, c.blockId))
        const prevTracked = new Map<number, GuardCamera>(
          s.prevTracked.map((c) => [c.clientId, { clientId: c.clientId, blockId: c.blockId, lastSeenMs: c.lastSeenMs }]),
        )
        const shared = { order: s.order, remotes, prevTracked, now: s.now, awarenessKnown: s.awarenessKnown, pinned: s.pinned, config: s.config }
        const o = observe({ ...shared, lru: { lastWorked: new Map(s.lruEntries) } })
        const guarded = expectedGuarded(shared)
        if (o.targetId !== null && guarded.has(o.targetId)) return false
        return (o.targetId === null) === s.order.every((id) => guarded.has(id))
      }),
    )
  })
})
