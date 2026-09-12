import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { performance } from 'node:perf_hooks'
import { DEFAULT_GRACE_MS, guardedBlocks, type GuardCamera, type GuardConfig } from '../../src/agent/spatialGuard'
import { trackCameras, type ObservedCamera } from '../../src/agent/guardTracker'
import { allBlockOrder, blockAuthor, blockKeys, blocks, blockId, blockHasText, blockText, blockType, createDoc, imageOf, listTabs, redirectSource } from '../../src/doc/model'
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

function observedCameras(awareness: Awareness): ObservedCamera[] {
  const out: ObservedCamera[] = []
  awareness.getStates().forEach((state, clientId) => {
    const cam = (state as { camera?: unknown }).camera
    if (!isAnchor(cam)) return
    out.push({ clientId, blockId: cam.blockId })
  })
  return out
}

// Resolve a peer camera to a block that places in the current order, following the authoritative redirect
// table (a merged-away anchor -> its successor). Unlike the layout resolver (resolveEffectiveAnchor), an
// unresolvable id is returned AS-IS, never laundered to order[0]: a reader whose block was hard-deleted with
// no redirect must stay unplaceable so guardedBlocks fails closed (guards the whole doc) rather than
// silently guarding the top and leaving the reader's true region cold.
function liveCameras(document: Y.Doc, awareness: Awareness): ObservedCamera[] {
  const order = allBlockOrder(document)
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

interface TrackedAwareness {
  room: string
  detach(): void
}

interface GuardView {
  id: string
  type: string
  delta: string
  author: string
  image: string
}

// Block identity for the guard: id + type + text DELTA (JSON) + lastAuthor. The delta captures formatting
// marks/embeds a plain-text signature would miss; lastAuthor is included so an author-only stamp (the agent's
// provenance write, #72) into a guarded band is refused too — a marker change under a live reader is still an
// uncoordinated write the guard exists to prevent.
function guardViews(document: Y.Doc): GuardView[] {
  return blockKeys(document).flatMap((key) =>
    blocks(document, key).map((m) => ({
      id: blockId(m),
      type: blockType(m),
      delta: JSON.stringify(blockHasText(m) ? blockText(m).toDelta() : []),
      author: blockAuthor(m) ?? '',
      image: JSON.stringify(blockType(m) === 'image' ? imageOf(m) : null),
    })),
  )
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
      if (a.id !== b.id || a.type !== b.type || a.delta !== b.delta || a.author !== b.author || a.image !== b.image) return false
    }
    k = j + 1
  }
  return true
}

// The concrete P6 spatial ProposalGuard: refuse any proposal that would alter a block inside the residency
// band of a live (or recently-dropped, within grace) camera, evaluated at commit against the authoritative
// document. Holds one grace tracker per room name, folded at each proposal and while awareness updates stream
// in, so a dropped reader's band stays guarded across a network blip. One `graceMs` drives both the tracker
// and the predicate (F-05).
export function createSpatialProposalGuard(opts: SpatialGuardOptions = {}): ProposalGuard {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const trackers = new Map<string, Map<number, GuardCamera>>()
  const trackedAwareness = new WeakMap<Awareness, TrackedAwareness>()

  const ensureAwarenessTracker = (awareness: Awareness, room: string) => {
    const state = trackedAwareness.get(awareness)
    if (state?.room === room) return

    const detach = () => {
      awareness.off('update', onUpdate)
      trackedAwareness.delete(awareness)
    }
    const onUpdate = () => {
      const prev = trackers.get(room) ?? new Map()
      trackers.set(room, trackCameras(prev, observedCameras(awareness), performance.now(), graceMs))
    }
    awareness.on('update', onUpdate)
    trackedAwareness.set(awareness, { room, detach })
    if (state && state.room !== room) {
      state.detach()
    }
  }

  return (update, ctx): GuardResult => {
    const { document, awareness, now, peer, sourceClientId } = ctx
    const room = peer?.room
    const live = awareness ? liveCameras(document, awareness) : []
    if (awareness && room) {
      ensureAwarenessTracker(awareness, room)
    }
    const all = room ? trackers.get(room) ?? new Map() : new Map()
    const cameras = trackCameras(all, live, now, graceMs)
    if (room) trackers.set(room, cameras)
    const guardCameras = sourceClientId == null ? [...cameras.values()] : [...cameras.values()].filter((c) => c.clientId !== sourceClientId)

    const guarded = guardedBlocks({
      order: allBlockOrder(document),
      cameras: guardCameras,
      pinned: opts.pinned?.(document),
      // The authority always holds its room's awareness; a null awareness means the peer set is unknown,
      // so fail closed (guardedBlocks guards the whole document).
      awarenessKnown: awareness != null,
      now,
      config: { ...opts.config, graceMs },
    })
    if (guarded.size === 0) return { ok: true }

    const fork = forkWith(document, update)
    try {
      return JSON.stringify(listTabs(document)) === JSON.stringify(listTabs(fork)) &&
        guardedSpansIntact(guardViews(document), guardViews(fork), guarded)
        ? { ok: true }
        : { ok: false, reason: 'spatial guard: proposal alters a block inside a live camera band' }
    } finally {
      fork.destroy()
    }
  }
}
