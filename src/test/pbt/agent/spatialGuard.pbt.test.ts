import { describe, it } from 'vitest'
import fc from 'fast-check'
import { guardedBlocks, coldBlocks, residencyBand, type GuardCamera } from '../../../agent/spatialGuard'
import { pbtAssert } from '../harness'

const orderOf = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`)

const rawCam = fc.record({
  clientId: fc.integer({ min: 1, max: 9 }),
  idxSel: fc.nat(),
  lastSeenMs: fc.integer({ min: 0, max: 300_000 }),
})
const rawCams = fc.array(rawCam, { maxLength: 6 })
type RawCam = { clientId: number; idxSel: number; lastSeenMs: number }
const place = (order: string[], c: RawCam): GuardCamera => ({
  clientId: c.clientId,
  blockId: order[c.idxSel % order.length],
  lastSeenMs: c.lastSeenMs,
})

describe('PBT: spatial guard (P6.2 correctness core)', () => {
  it('guards exactly the clamped ±radius window of a single live camera', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.nat(), fc.integer({ min: 0, max: 8 }), (n, sel, radius) => {
        const order = orderOf(n)
        const blockId = order[sel % n]
        const g = guardedBlocks({
          order,
          cameras: [{ clientId: 1, blockId, lastSeenMs: 100 }],
          awarenessKnown: true,
          now: 100,
          config: { radius, graceMs: 1000 },
        })
        const expected = new Set(residencyBand(order, blockId, radius))
        if (g.size !== expected.size) return false
        for (const id of expected) if (!g.has(id)) return false
        return true
      }),
    )
  })

  it('is monotonic: adding a camera never releases a guarded block', () => {
    pbtAssert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        rawCams,
        rawCam,
        (n, cams, extra) => {
          const order = orderOf(n)
          const base = cams.map((c) => place(order, c))
          const now = 300_000
          const g0 = guardedBlocks({ order, cameras: base, awarenessKnown: true, now })
          const g1 = guardedBlocks({ order, cameras: [...base, place(order, extra)], awarenessKnown: true, now })
          for (const id of g0) if (!g1.has(id)) return false
          return true
        },
      ),
    )
  })

  it('fails closed to the whole document on awareness outage, regardless of cameras', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 0, max: 60 }), rawCams, (n, cams) => {
        const order = orderOf(n)
        const cameras = n === 0 ? [] : cams.map((c) => place(order, c))
        return guardedBlocks({ order, cameras, awarenessKnown: false, now: 300_000 }).size === n
      }),
    )
  })

  it('fails closed to the whole document for an unplaceable known camera', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), rawCams, (n, cams) => {
        const order = orderOf(n)
        const cameras = [...cams.map((c) => place(order, c)), { clientId: 99, blockId: 'ghost-not-in-order', lastSeenMs: 100 }]
        return guardedBlocks({ order, cameras, awarenessKnown: true, now: 100 }).size === n
      }),
    )
  })

  it('always guards pinned blocks that exist in the order', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), rawCams, fc.array(fc.nat(), { maxLength: 5 }), fc.boolean(), (n, cams, pinSel, known) => {
        const order = orderOf(n)
        const pinned = pinSel.map((s) => order[s % n])
        const g = guardedBlocks({ order, cameras: cams.map((c) => place(order, c)), pinned, awarenessKnown: known, now: 300_000 })
        for (const p of pinned) if (!g.has(p)) return false
        return true
      }),
    )
  })

  it('counts a dropped camera exactly while now - lastSeen ≤ graceMs', () => {
    pbtAssert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.nat(),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 200_000 }),
        fc.integer({ min: 0, max: 400_000 }),
        (n, sel, lastSeen, grace, delta) => {
          const order = orderOf(n)
          const blockId = order[sel % n]
          const g = guardedBlocks({
            order,
            cameras: [{ clientId: 1, blockId, lastSeenMs: lastSeen }],
            awarenessKnown: true,
            now: lastSeen + delta,
            config: { radius: 4, graceMs: grace },
          })
          return g.has(blockId) === (delta <= grace)
        },
      ),
    )
  })

  it('guardedBlocks and coldBlocks partition the order', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), rawCams, fc.array(fc.nat(), { maxLength: 5 }), fc.boolean(), (n, cams, pinSel, known) => {
        const order = orderOf(n)
        const inp = {
          order,
          cameras: cams.map((c) => place(order, c)),
          pinned: pinSel.map((s) => order[s % n]),
          awarenessKnown: known,
          now: 200_000,
        }
        const g = guardedBlocks(inp)
        const cold = coldBlocks(inp)
        if (g.size + cold.length !== n) return false
        for (const id of cold) if (g.has(id)) return false
        return true
      }),
    )
  })
})
