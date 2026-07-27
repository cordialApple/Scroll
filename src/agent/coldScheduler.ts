export interface LruState {
  lastWorked: ReadonlyMap<string, number>
}

export const emptyLru: LruState = { lastWorked: new Map() }

// Pick the next cold block to work: a never-worked block (treated as -Infinity) before any worked one, then
// least-recently-worked, ties broken by the order `cold` is given in (the caller passes it in document
// order, and the strict `<` keeps the earliest). Returns null only when nothing is cold.
export function selectNext(state: LruState, cold: string[]): string | null {
  let best: string | null = null
  let bestTs = Infinity
  for (const id of cold) {
    const ts = state.lastWorked.get(id) ?? -Infinity
    if (ts < bestTs) {
      best = id
      bestTs = ts
    }
  }
  return best
}

// Record that `id` was worked at `now`, pruning any tracked block no longer `present` so the map stays
// bounded by the live document as the agent reorganizes it over a long session.
export function markWorked(state: LruState, id: string, now: number, present: Iterable<string>): LruState {
  const keep = new Set(present)
  const next = new Map<string, number>()
  for (const [b, ts] of state.lastWorked) if (keep.has(b)) next.set(b, ts)
  next.set(id, now)
  return { lastWorked: next }
}
