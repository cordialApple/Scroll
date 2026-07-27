export interface GuardCamera {
  clientId: number
  blockId: string
  lastSeenMs: number
}

export interface GuardConfig {
  visibleBlocks: number
  buffer: number
  graceMs: number
}

export const DEFAULT_VISIBLE_BLOCKS = 4
export const DEFAULT_BUFFER = 4
export const DEFAULT_GRACE_MS = 120_000

function resolveConfig(c?: Partial<GuardConfig>): GuardConfig {
  return {
    visibleBlocks: Math.max(1, Math.floor(c?.visibleBlocks ?? DEFAULT_VISIBLE_BLOCKS)),
    buffer: Math.max(0, Math.floor(c?.buffer ?? DEFAULT_BUFFER)),
    graceMs: Math.max(0, c?.graceMs ?? DEFAULT_GRACE_MS),
  }
}

// The single resolved grace source. The agent observer folds cameras with trackCameras BEFORE guardedBlocks
// re-derives its own config, so both must read one formula — a divergence would prune a still-guarded camera
// early. Exported so the observer never re-implements the clamp inline.
export function resolveGraceMs(config?: Partial<GuardConfig>): number {
  return resolveConfig(config).graceMs
}

// The camera anchor is the viewport TOP (layout: scrollTop = anchorOffsetTop + offset), so the visible
// span runs DOWNWARD from it. The guarded band is therefore asymmetric — `buffer` blocks of scroll
// headroom above, then the `visibleBlocks` on screen, then `buffer` blocks below — not ±buffer about a
// point. A symmetric band would leave on-screen content below the anchor cold, breaking "nothing changes
// beneath you." Returned inclusive [lo, hi] index range, clamped to the document.
function bandRange(i: number, n: number, cfg: GuardConfig): [number, number] {
  return [Math.max(0, i - cfg.buffer), Math.min(n - 1, i + (cfg.visibleBlocks - 1) + cfg.buffer)]
}

export function residencyBand(order: string[], blockId: string, config?: Partial<GuardConfig>): string[] {
  const i = order.indexOf(blockId)
  if (i < 0) return []
  const [lo, hi] = bandRange(i, order.length, resolveConfig(config))
  return order.slice(lo, hi + 1)
}

export interface GuardInput {
  order: string[]
  cameras: GuardCamera[]
  pinned?: Iterable<string>
  awarenessKnown: boolean
  now: number
  config?: Partial<GuardConfig>
}

export function guardedBlocks(input: GuardInput): Set<string> {
  const { order, cameras, awarenessKnown, now } = input
  const cfg = resolveConfig(input.config)

  // Unknown peer set (awareness outage / room rebooting): a reader we cannot see may exist. Absence of
  // presence is never absence of a reader, so guard the whole document until the peer set is known again.
  if (!awarenessKnown) return new Set(order)

  const index = new Map<string, number>()
  for (let i = 0; i < order.length; i++) index.set(order[i], i)

  const guarded = new Set<string>()
  if (input.pinned) for (const id of input.pinned) if (index.has(id)) guarded.add(id)

  for (const cam of cameras) {
    if (now - cam.lastSeenMs > cfg.graceMs) continue
    const i = index.get(cam.blockId)
    // A known reader whose last-known block cannot be placed in the current order (it vanished and the
    // caller could not resolve it): we cannot bound its band, so fail closed and guard everything.
    if (i === undefined) return new Set(order)
    const [lo, hi] = bandRange(i, order.length, cfg)
    for (let k = lo; k <= hi; k++) guarded.add(order[k])
  }
  return guarded
}

export function coldBlocks(input: GuardInput): string[] {
  const guarded = guardedBlocks(input)
  return input.order.filter((id) => !guarded.has(id))
}

export function isGuarded(input: GuardInput, blockId: string): boolean {
  return guardedBlocks(input).has(blockId)
}
