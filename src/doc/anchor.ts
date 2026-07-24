import type { Anchor } from '../layout/layout'
import { resolveRedirect, type RedirectSource } from './redirects'

export function resolveEffectiveAnchor(
  order: string[],
  redirects: RedirectSource,
  anchor: Anchor,
): Anchor {
  if (order.length === 0) return { blockId: '', offset: 0 }
  if (order.includes(anchor.blockId)) return anchor
  const r = resolveRedirect(redirects, anchor.blockId, anchor.offset)
  if (order.includes(r.blockId)) return { blockId: r.blockId, offset: r.offset }
  return { blockId: order[0], offset: 0 }
}
