export interface RedirectSource {
  get(id: string): string | undefined
}

export interface ResolvedAnchor {
  blockId: string
  offset: number
  hops: number
}

export function resolveRedirect(
  redirects: RedirectSource,
  blockId: string,
  offset: number,
): ResolvedAnchor {
  const seen = new Set<string>([blockId])
  let id = blockId
  let hops = 0
  for (;;) {
    const next = redirects.get(id)
    if (next === undefined) break
    if (seen.has(next)) break
    seen.add(next)
    id = next
    hops++
  }
  return { blockId: id, offset: hops > 0 ? 0 : offset, hops }
}

export function mapAsRedirectSource(map: Map<string, string>): RedirectSource {
  return { get: (id) => map.get(id) }
}
