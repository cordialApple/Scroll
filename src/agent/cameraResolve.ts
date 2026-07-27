import { resolveRedirect, type RedirectSource } from '../doc/redirects'
import type { RemoteCamera } from '../doc/awareness'
import type { ObservedCamera } from './guardTracker'

// Resolve peer cameras to placeable block ids the SAME non-laundering way the room authority does
// (server/agent/spatialProposalGuard.ts `liveCameras`): the raw published anchor if it is in the current
// order, else its redirect successor if THAT is in order, else the raw id AS-IS — NEVER laundered to
// order[0] the way the layout resolver (`RemoteCamera.anchor`) is. Keeping an unresolvable reader
// unplaceable is what makes guardedBlocks fail closed (guard the whole doc) for a reader whose block
// vanished, instead of the agent silently treating most of the doc as cold (#66 F-02). Reads `.raw` — the
// published anchor — not the laundered `.anchor`.
export function resolveCameras(remotes: RemoteCamera[], order: string[], redirects: RedirectSource): ObservedCamera[] {
  const inOrder = new Set(order)
  return remotes.map((r) => {
    let blockId = r.raw.blockId
    if (!inOrder.has(blockId)) {
      const red = resolveRedirect(redirects, blockId, r.raw.offset)
      if (inOrder.has(red.blockId)) blockId = red.blockId
    }
    return { clientId: r.clientId, blockId }
  })
}
