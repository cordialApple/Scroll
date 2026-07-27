import { describe, it } from 'vitest'
import fc from 'fast-check'
import { observe } from '../../../agent/observer'
import { guardedBlocks } from '../../../agent/spatialGuard'
import type { RemoteCamera } from '../../../doc/awareness'
import { pbtAssert } from '../harness'

const pool = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']
const orderArb = fc.subarray(pool, { minLength: 1 })
const camArb = fc.record({ clientId: fc.integer({ min: 1, max: 6 }), blockId: fc.constantFrom(...pool) })
const remotesArb = fc.array(camArb, { maxLength: 6 })
const lruArb = fc.array(fc.tuple(fc.constantFrom(...pool), fc.integer({ min: 0, max: 100_000 })), { maxLength: 10 })
const nowArb = fc.integer({ min: 0, max: 500_000 })

const toRemote = (c: { clientId: number; blockId: string }): RemoteCamera => ({
  clientId: c.clientId,
  raw: { blockId: c.blockId, offset: 0 },
  anchor: { blockId: c.blockId, offset: 0 },
})

describe('PBT: observe never selects a guarded block (P6.4 agent-side safety)', () => {
  it('the selected target is always cold, and null iff every block is guarded', () => {
    pbtAssert(
      fc.property(orderArb, remotesArb, lruArb, nowArb, fc.boolean(), (order, rawRemotes, lruEntries, now, awarenessKnown) => {
        const remotes = rawRemotes.map(toRemote)
        const o = observe({ order, remotes, prevTracked: new Map(), lru: { lastWorked: new Map(lruEntries) }, now, awarenessKnown })
        const guarded = guardedBlocks({ order, cameras: [...o.tracked.values()], awarenessKnown, now })
        if (o.targetId !== null && guarded.has(o.targetId)) return false
        const everythingGuarded = order.every((id) => guarded.has(id))
        return (o.targetId === null) === everythingGuarded
      }),
    )
  })
})
