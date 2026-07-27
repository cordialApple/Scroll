import { describe, it, expect } from 'vitest'
import { resolveCameras } from './cameraResolve'
import { guardedBlocks } from './spatialGuard'
import type { RedirectSource } from '../doc/redirects'
import type { RemoteCamera } from '../doc/awareness'

const order = Array.from({ length: 10 }, (_, i) => `b${i}`)
const redirs = (m: Record<string, string>): RedirectSource => ({ get: (id) => m[id] })

// A camera whose LAUNDERED anchor (what the layout resolver hands the UI) points at order[0], but whose raw
// published anchor is `rawId`. resolveCameras must ignore .anchor and read .raw — that split is the whole point.
const cam = (clientId: number, rawId: string, offset = 0): RemoteCamera => ({
  clientId,
  raw: { blockId: rawId, offset },
  anchor: { blockId: order[0], offset: 0 },
})

describe('resolveCameras — non-laundering camera resolution (P6.5, #66 F-02)', () => {
  it('keeps a raw anchor that is already in order, ignoring the laundered anchor', () => {
    expect(resolveCameras([cam(1, 'b4')], order, redirs({}))).toEqual([{ clientId: 1, blockId: 'b4' }])
  })

  it('follows a redirect to a surviving successor when the raw block is gone', () => {
    expect(resolveCameras([cam(1, 'ghost')], order, redirs({ ghost: 'b6' }))).toEqual([{ clientId: 1, blockId: 'b6' }])
  })

  // The #66 pin (ported from the old observer.test.ts skip): a reader whose block was hard-deleted with NO
  // redirect stays unplaceable — resolveCameras returns the raw id AS-IS, NEVER laundered to order[0]. Keeping
  // it unplaceable is exactly what makes guardedBlocks fail closed for that reader instead of under-guarding.
  it('keeps an unresolvable raw anchor as-is (never launders to order[0])', () => {
    expect(resolveCameras([cam(1, 'ghost')], order, redirs({}))).toEqual([{ clientId: 1, blockId: 'ghost' }])
  })

  it('keeps the raw id when the redirect target is also gone (chain dead-ends off-order)', () => {
    expect(resolveCameras([cam(1, 'ghost')], order, redirs({ ghost: 'alsoGone' }))).toEqual([{ clientId: 1, blockId: 'ghost' }])
  })

  it('end to end: an unplaceable resolved camera makes guardedBlocks guard the whole doc (fail closed)', () => {
    const cameras = resolveCameras([cam(1, 'ghost')], order, redirs({})).map((c) => ({ ...c, lastSeenMs: 0 }))
    const guarded = guardedBlocks({ order, cameras, awarenessKnown: true, now: 0 })
    expect(guarded).toEqual(new Set(order))
  })
})
