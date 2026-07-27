export interface LruState {
  lastWorked: ReadonlyMap<string, number>
}

export const emptyLru: LruState = { lastWorked: new Map() }

// Pick the next cold block to work: a never-worked block (treated as -Infinity) before any worked one, then
// least-recently-worked, ties broken by the order `cold` is given in (the caller passes it in document
// order; strict `<` keeps the earliest). `best` seeds from cold[0], so a non-empty `cold` always yields a
// member even if every stored timestamp is non-finite — the "null only when nothing is cold" contract holds
// regardless of clock hygiene. Assumes the `now` values markWorked recorded are monotonic non-decreasing
// (the driver supplies a monotonic clock); a clock that runs backward can misorder recency.
export function selectNext(state: LruState, cold: string[]): string | null {
  if (cold.length === 0) return null
  let best = cold[0]
  let bestTs = state.lastWorked.get(cold[0]) ?? -Infinity
  for (let i = 1; i < cold.length; i++) {
    const ts = state.lastWorked.get(cold[i]) ?? -Infinity
    if (ts < bestTs) {
      best = cold[i]
      bestTs = ts
    }
  }
  return best
}

// Record that `id` was worked at `now`, pruning any tracked block no longer `present` so the map stays
// bounded by the live document as the agent reorganizes it over a long session. The just-worked `id` is
// always recorded (even if a concurrent delete already dropped it from `present`); such a stale entry is
// inert for selectNext and removed by the next prune. `now` is expected monotonic non-decreasing.
export function markWorked(state: LruState, id: string, now: number, present: Iterable<string>): LruState {
  const keep = new Set(present)
  const next = new Map<string, number>()
  for (const [b, ts] of state.lastWorked) if (keep.has(b)) next.set(b, ts)
  next.set(id, now)
  return { lastWorked: next }
}
