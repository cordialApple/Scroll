import { describe, it } from 'vitest'
import fc from 'fast-check'
import { trackCameras } from '../../../agent/guardTracker'
import type { GuardCamera } from '../../../agent/spatialGuard'
import { pbtAssert } from '../harness'

const blockIds = fc.constantFrom('b0', 'b1', 'b2', 'b3')
const prevArb = fc.array(
  fc.record({ clientId: fc.integer({ min: 1, max: 6 }), blockId: blockIds, lastSeenMs: fc.integer({ min: 0, max: 400_000 }) }),
  { maxLength: 6 },
)
const liveArb = fc.array(fc.record({ clientId: fc.integer({ min: 1, max: 6 }), blockId: blockIds }), { maxLength: 6 })

describe('PBT: trackCameras grace reducer (P6.2 fail-closed)', () => {
  it('records every live camera at now, retains a dropped one iff within grace, and invents nothing', () => {
    pbtAssert(
      fc.property(prevArb, liveArb, fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 1, max: 200_000 }), (prevArr, liveArr, now, grace) => {
        const prev = new Map<number, GuardCamera>(prevArr.map((c) => [c.clientId, c]))
        const next = trackCameras(prev, liveArr, now, grace)
        // trackCameras is last-write-wins over live, so compare against the deduped live set.
        const liveLast = new Map(liveArr.map((c) => [c.clientId, c]))
        const liveIds = new Set(liveLast.keys())

        for (const [id, c] of liveLast) {
          const e = next.get(id)
          if (!e || e.blockId !== c.blockId || e.lastSeenMs !== now) return false
        }
        for (const [id, camNode] of next) {
          if (!liveIds.has(id) && !prev.has(id)) return false // never invents an entry
          if (!liveIds.has(id) && now - camNode.lastSeenMs > grace) return false // never keeps a past-grace drop
        }
        // A remembered, in-grace, not-currently-live camera must survive.
        for (const [id, camNode] of prev) {
          if (!liveIds.has(id) && now - camNode.lastSeenMs <= grace && !next.has(id)) return false
        }
        return true
      }),
    )
  })
})
