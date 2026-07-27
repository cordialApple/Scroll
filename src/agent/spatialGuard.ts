export interface GuardCamera {
  clientId: number
  blockId: string
  lastSeenMs: number
}

export interface GuardConfig {
  radius: number
  graceMs: number
}

export const DEFAULT_RADIUS = 4
export const DEFAULT_GRACE_MS = 120_000

function resolveConfig(c?: Partial<GuardConfig>): GuardConfig {
  return { radius: c?.radius ?? DEFAULT_RADIUS, graceMs: c?.graceMs ?? DEFAULT_GRACE_MS }
}

export function residencyBand(order: string[], blockId: string, radius = DEFAULT_RADIUS): string[] {
  const i = order.indexOf(blockId)
  if (i < 0) return []
  return order.slice(Math.max(0, i - radius), Math.min(order.length, i + radius + 1))
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
  const { radius, graceMs } = resolveConfig(input.config)

  // Unknown peer set (awareness outage / room rebooting): a reader we cannot see may exist. Absence of
  // presence is never absence of a reader, so guard the whole document until the peer set is known again.
  if (!awarenessKnown) return new Set(order)

  const index = new Map<string, number>()
  for (let i = 0; i < order.length; i++) index.set(order[i], i)

  const guarded = new Set<string>()
  if (input.pinned) for (const id of input.pinned) if (index.has(id)) guarded.add(id)

  for (const cam of cameras) {
    if (now - cam.lastSeenMs > graceMs) continue
    const i = index.get(cam.blockId)
    // A known reader whose last-known block cannot be placed in the current order (it vanished and the
    // caller could not resolve it): we cannot bound its band, so fail closed and guard everything.
    if (i === undefined) return new Set(order)
    const hi = Math.min(order.length - 1, i + radius)
    for (let k = Math.max(0, i - radius); k <= hi; k++) guarded.add(order[k])
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
