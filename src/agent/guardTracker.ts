import { DEFAULT_GRACE_MS, type GuardCamera } from './spatialGuard'

export interface ObservedCamera {
  clientId: number
  blockId: string
}

// Fold this instant's live cameras into the remembered set. A camera that stopped reporting keeps its
// last-known position and lastSeen until grace expires — a reader whose wifi dropped for 45s is still
// looking at the screen — so its band stays guarded across the blip rather than opening the moment
// awareness clears on disconnect.
export function trackCameras(
  prev: ReadonlyMap<number, GuardCamera>,
  live: ObservedCamera[],
  now: number,
  graceMs = DEFAULT_GRACE_MS,
): Map<number, GuardCamera> {
  const next = new Map<number, GuardCamera>()
  for (const [id, cam] of prev) if (now - cam.lastSeenMs <= graceMs) next.set(id, cam)
  for (const c of live) next.set(c.clientId, { clientId: c.clientId, blockId: c.blockId, lastSeenMs: now })
  return next
}
