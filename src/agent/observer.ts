import { coldBlocks, DEFAULT_GRACE_MS, type GuardCamera, type GuardConfig } from './spatialGuard'
import { guardCamerasFromRemotes, trackCameras } from './guardTracker'
import { selectNext, type LruState } from './coldScheduler'
import type { RemoteCamera } from '../doc/awareness'

export interface ObserveInput {
  order: string[]
  remotes: RemoteCamera[]
  prevTracked: ReadonlyMap<number, GuardCamera>
  lru: LruState
  now: number
  awarenessKnown: boolean
  pinned?: Iterable<string>
  config?: Partial<GuardConfig>
}

export interface Observation {
  targetId: string | null
  cold: string[]
  tracked: Map<number, GuardCamera>
}

// One pure observation tick for the attention-anchored agent: fold this instant's cameras into the grace
// memory, derive the cold set the authority would allow (fail closed when the peer set is unknown), and
// pick the next cold block to work by LRU. Returns the new grace map so the driver threads it into the next
// tick. The target is only ever a cold block; the authority still re-checks at commit for the race where a
// reader moved into it after this read (this is the agent-side belt to that suspenders).
export function observe(input: ObserveInput): Observation {
  const graceMs = Math.max(0, input.config?.graceMs ?? DEFAULT_GRACE_MS)
  const tracked = trackCameras(input.prevTracked, guardCamerasFromRemotes(input.remotes), input.now, graceMs)
  const cold = coldBlocks({
    order: input.order,
    cameras: [...tracked.values()],
    pinned: input.pinned,
    awarenessKnown: input.awarenessKnown,
    now: input.now,
    config: input.config,
  })
  return { targetId: selectNext(input.lru, cold), cold, tracked }
}
