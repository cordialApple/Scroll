import { coldBlocks, resolveGraceMs, type GuardCamera, type GuardConfig } from './spatialGuard'
import { trackCameras, type ObservedCamera } from './guardTracker'
import { emptyLru, selectNext, type LruState } from './coldScheduler'

// The agent's threaded state: the grace memory folded across ticks + the LRU of worked cold blocks. Bundled
// so the driver threads ONE value, not two independently-lifecycled ones (#66 F-06) — observe folds
// `tracked` forward; `lru` advances only when the driver actually acts (markWorked), never on an idle tick.
export interface ObserverState {
  tracked: ReadonlyMap<number, GuardCamera>
  lru: LruState
}

export const emptyObserverState: ObserverState = { tracked: new Map(), lru: emptyLru }

export interface ObserveInput {
  order: string[]
  // Cameras resolved NON-launderingly by the driver (cameraResolve.ts) BEFORE this call, so an unplaceable
  // reader fails closed here exactly as the authority's guardedBlocks does. Not raw RemoteCameras.
  cameras: ObservedCamera[]
  state: ObserverState
  now: number
  awarenessKnown: boolean
  pinned?: Iterable<string>
  config?: Partial<GuardConfig>
}

export interface Observation {
  targetId: string | null
  cold: string[]
  state: ObserverState
}

// One pure observation tick for the attention-anchored agent: fold this instant's cameras into the grace
// memory, derive the cold set the authority would allow (fail closed when the peer set is unknown), and pick
// the next cold block to work by LRU. The target is only ever a cold block; the authority still re-checks at
// commit for the race where a reader moved into it after this read (the agent-side belt to that suspenders).
export function observe(input: ObserveInput): Observation {
  const graceMs = resolveGraceMs(input.config)
  const tracked = trackCameras(input.state.tracked, input.cameras, input.now, graceMs)
  const cold = coldBlocks({
    order: input.order,
    cameras: [...tracked.values()],
    pinned: input.pinned,
    awarenessKnown: input.awarenessKnown,
    now: input.now,
    config: input.config,
  })
  return { targetId: selectNext(input.state.lru, cold), cold, state: { tracked, lru: input.state.lru } }
}
