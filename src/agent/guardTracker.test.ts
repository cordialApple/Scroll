import { describe, it, expect } from 'vitest'
import { trackCameras, type ObservedCamera } from './guardTracker'
import { DEFAULT_GRACE_MS, type GuardCamera } from './spatialGuard'

const obs = (clientId: number, blockId: string): ObservedCamera => ({ clientId, blockId })
const remembered = (blockId: string, lastSeenMs: number, clientId = 1): Map<number, GuardCamera> =>
  new Map([[clientId, { clientId, blockId, lastSeenMs }]])

describe('trackCameras', () => {
  it('records live cameras with the current timestamp', () => {
    const next = trackCameras(new Map(), [obs(1, 'b3'), obs(2, 'b7')], 1000)
    expect(next.get(1)).toEqual({ clientId: 1, blockId: 'b3', lastSeenMs: 1000 })
    expect(next.get(2)?.lastSeenMs).toBe(1000)
  })

  it('retains a dropped camera within grace, then evicts it past grace', () => {
    const prev = remembered('b3', 0)
    expect(trackCameras(prev, [], DEFAULT_GRACE_MS).get(1)?.blockId).toBe('b3')
    expect(trackCameras(prev, [], DEFAULT_GRACE_MS + 1).has(1)).toBe(false)
  })

  it('refreshes position and lastSeen when a remembered camera reappears', () => {
    const next = trackCameras(remembered('b3', 0), [obs(1, 'b9')], 500)
    expect(next.get(1)).toEqual({ clientId: 1, blockId: 'b9', lastSeenMs: 500 })
  })
})
