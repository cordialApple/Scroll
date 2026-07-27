import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { DEFAULT_GRACE_MS, guardedBlocks, type GuardCamera, type GuardConfig } from '../../src/agent/spatialGuard'
import { trackCameras, type ObservedCamera } from '../../src/agent/guardTracker'
import { blockAuthor, blockOrder, blocks, blockId, blockText, blockType, createDoc, redirectSource } from '../../src/doc/model'
import { resolveRedirect } from '../../src/doc/redirects'
import type { Anchor } from '../../src/layout/layout'
import type { GuardResult, ProposalGuard } from '../db/proposeCommit'

export interface SpatialGuardOptions {
  graceMs?: number
  config?: Partial<Pick<GuardConfig, 'visibleBlocks' | 'buffer'>>
  pinned?: (document: Y.Doc) => Iterable<string>
}

function isAnchor(v: unknown): v is Anchor {
  return !!v && typeof v === 'object' && typeof (v as Anchor).blockId === 'string' && typeof (v as Anchor).offset === 'number'
}

// Resolve a peer camera to a block that places in the current order, following the authoritative redirect
// table (a merged-away anchor -> its successor). Unlike the layout resolver (resolveEffectiveAnchor), an
// unresolvable id is returned AS-IS, never laundered to order[0]: a reader whose block was hard-deleted with
// no redirect must stay unplaceable so guardedBlocks fails closed (guards the whole doc) rather than
// silently guarding the top and leaving the reader's true region cold.
function liveCameras(document: Y.Doc, awareness: Awareness): ObservedCamera[] {
  const order = blockOrder(document)
  const inOrder = new Set(order)
  const redirects = redirectSource(document)
  const out: ObservedCamera[] = []
  awareness.getStates().forEach((state, clientId) => {
    const cam = (state as { camera?: unknown }).camera
    if (!isAnchor(cam)) return
    let id = cam.blockId
    if (!inOrder.has(id)) {
      const r = resolveRedirect(redirects, id, cam.offset)
      if (inOrder.has(r.blockId)) id = r.blockId
    }
    out.push({ clientId, blockId: id })
  })
  return out
}

interface GuardView {
  id: string
  type: string
  delta: string
  author: string
}

// Block identity for the guard: id + type + text DELTA (JSON) + lastAuthor. The delta captures formatting
// marks/embeds a plain-text signature would miss; lastAuthor is included so an author-only stamp (the agent's
// provenance write, #72) into a guarded band is refused too — a marker change under a live reader is still an
// uncoordinated write the guard exists to prevent.
function guardViews(document: Y.Doc): GuardView[] {
  return blocks(document).map((m) => ({
    id: blockId(m),
    type: blockType(m),
    delta: JSON.stringify(blockText(m).toDelta()),
    author: blockAuthor(m) ?? '',
  }))
}

function forkWith(document: Y.Doc, update: Uint8Array): Y.Doc {
  const fork = createDoc()
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(document))
  Y.applyUpdate(fork, update)
  return fork
}

// Every maximal run of guarded blocks in `before` must reappear in `after` — same length, same
// per-block id/type/delta, in order. A structural field-by-field compare (no string join, no delimiter),
// so nothing inserted, removed, reordered, or re-formatted inside a run slips through. Edits confined to
// cold blocks — and inserts/deletes ABOVE or BELOW a run, which relative anchoring absorbs — leave every
// run intact and commit.
function guardedSpansIntact(before: GuardView[], after: GuardView[], guarded: Set<string>): boolean {
  const afterIndex = new Map(after.map((v, i) => [v.id, i]))
  let k = 0
  while (k < before.length) {
    if (!guarded.has(before[k].id)) {
      k++
      continue
    }
    let j = k
    while (j + 1 < before.length && guarded.has(before[j + 1].id)) j++
    const fi = afterIndex.get(before[k].id)
    const li = afterIndex.get(before[j].id)
    if (fi === undefined || li === undefined || li - fi !== j - k) return false
    for (let d = 0; d <= j - k; d++) {
      const a = before[k + d]
      const b = after[fi + d]
      if (a.id !== b.id || a.type !== b.type || a.delta !== b.delta || a.author !== b.author) return false
    }
    k = j + 1
  }
  return true
}

// The concrete P6 spatial ProposalGuard: refuse any proposal that would alter a block inside the residency
// band of a live (or recently-dropped, within grace) camera, evaluated at commit against the authoritative
// document. Holds one grace tracker per room (keyed by the doc; GC'd with it), folded at each proposal so a
// dropped reader's band stays guarded across a network blip. One `graceMs` drives both the tracker and the
// predicate (F-05).
export function createSpatialProposalGuard(opts: SpatialGuardOptions = {}): ProposalGuard {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const trackers = new WeakMap<Y.Doc, Map<number, GuardCamera>>()

  return (update, ctx): GuardResult => {
    const { document, awareness, now } = ctx
    const live = awareness ? liveCameras(document, awareness) : []
    const cameras = trackCameras(trackers.get(document) ?? new Map(), live, now, graceMs)
    trackers.set(document, cameras)

    const guarded = guardedBlocks({
      order: blockOrder(document),
      cameras: [...cameras.values()],
      pinned: opts.pinned?.(document),
      // The authority always holds its room's awareness; a null awareness means the peer set is unknown,
      // so fail closed (guardedBlocks guards the whole document).
      awarenessKnown: awareness != null,
      now,
      config: { ...opts.config, graceMs },
    })
    if (guarded.size === 0) return { ok: true }

    return guardedSpansIntact(guardViews(document), guardViews(forkWith(document, update)), guarded)
      ? { ok: true }
      : { ok: false, reason: 'spatial guard: proposal alters a block inside a live camera band' }
  }
}
