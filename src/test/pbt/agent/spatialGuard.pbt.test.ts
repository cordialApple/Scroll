import { describe, it } from 'vitest'
import fc from 'fast-check'
import { guardedBlocks, coldBlocks, type GuardCamera } from '../../../agent/spatialGuard'
import { pbtAssert } from '../harness'

const orderOf = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`)

// Cameras generated in-grace at now = NOW (lastSeen ≥ NOW - DEFAULT_GRACE_MS = 180_000), so bands are
// non-empty and the union / partition / pinned properties exercise real guarded sets, not vacuous ones.
const NOW = 300_000
const rawCam = fc.record({
  clientId: fc.integer({ min: 1, max: 9 }),
  idxSel: fc.nat(),
  lastSeenMs: fc.integer({ min: 180_000, max: NOW }),
})
const rawCams = fc.array(rawCam, { maxLength: 6 })
type RawCam = { clientId: number; idxSel: number; lastSeenMs: number }
const place = (order: string[], c: RawCam): GuardCamera => ({
  clientId: c.clientId,
  blockId: order[c.idxSel % order.length],
  lastSeenMs: c.lastSeenMs,
})

describe('PBT: spatial guard (P6.2 correctness core)', () => {
  it('guards exactly the asymmetric top-anchor band of a single live camera', () => {
    pbtAssert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.nat(),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        (n, sel, buffer, visibleBlocks) => {
          const order = orderOf(n)
          const camIdx = sel % n
          const g = guardedBlocks({
            order,
            cameras: [{ clientId: 1, blockId: order[camIdx], lastSeenMs: 100 }],
            awarenessKnown: true,
            now: 100,
            config: { buffer, visibleBlocks, graceMs: 1000 },
          })
          // Independent oracle: a block index j is guarded iff it lies in the asymmetric window
          // [camIdx - buffer, camIdx + (visibleBlocks - 1) + buffer], computed here as a per-index
          // predicate (not the implementation's slice/clamp), so a shared off-by-one cannot hide.
          let expectedSize = 0
          for (let j = 0; j < n; j++) {
            const inBand = j >= camIdx - buffer && j <= camIdx + (visibleBlocks - 1) + buffer
            if (inBand) expectedSize++
            if (g.has(order[j]) !== inBand) return false
          }
          return g.size === expectedSize
        },
      ),
    )
  })

  it('is monotonic: adding an in-grace camera never releases a guarded block', () => {
    pbtAssert(
      fc.property(rawCams, rawCam, (cams, extra) => {
        const order = orderOf(60)
        const base = cams.map((c) => place(order, c))
        const g0 = guardedBlocks({ order, cameras: base, awarenessKnown: true, now: NOW })
        const g1 = guardedBlocks({ order, cameras: [...base, place(order, extra)], awarenessKnown: true, now: NOW })
        for (const id of g0) if (!g1.has(id)) return false
        return true
      }),
    )
  })

  it('fails closed to the whole document on awareness outage, regardless of cameras', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 0, max: 60 }), rawCams, (n, cams) => {
        const order = orderOf(n)
        const cameras = n === 0 ? [] : cams.map((c) => place(order, c))
        return guardedBlocks({ order, cameras, awarenessKnown: false, now: NOW }).size === n
      }),
    )
  })

  it('fails closed to the whole document for an unplaceable known camera', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), rawCams, (n, cams) => {
        const order = orderOf(n)
        const cameras = [...cams.map((c) => place(order, c)), { clientId: 99, blockId: 'ghost-not-in-order', lastSeenMs: NOW }]
        return guardedBlocks({ order, cameras, awarenessKnown: true, now: NOW }).size === n
      }),
    )
  })

  it('always guards existing pinned blocks under awarenessKnown:true', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 60 }), rawCams, fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), (n, cams, pinSel) => {
        const order = orderOf(n)
        const pinned = pinSel.map((s) => order[s % n])
        const g = guardedBlocks({ order, cameras: cams.map((c) => place(order, c)), pinned, awarenessKnown: true, now: NOW })
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
            config: { graceMs: grace },
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
          now: NOW,
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
