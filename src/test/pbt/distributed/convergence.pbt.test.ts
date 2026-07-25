import { describe, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import {
  createDoc,
  appendBlock,
  blocks,
  blockId,
  blockText,
  blockViews,
  blockOrder,
  makeBlock,
  indexOfBlock,
  redirects,
  redirectSource,
  setBlockText,
  mergeIntoPrevious,
} from '../../../doc/model'
import { resolveEffectiveAnchor } from '../../../doc/anchor'
import { pbtAssert } from '../harness'

const REMOTE = 'remote'
const NONE: ReadonlySet<string> = new Set()

// U+2693 marker frames every seed block's text. fast-check string()/nat text is printable ASCII, so
// no generated insert/edit can ever forge a marker — an assertion that a block's text still contains
// `⚓j⚓` is proof the seed block j's content survived, not a coincidental collision.
const MARK = (i: number) => `⚓${i}⚓`

// Set while a local op runs so the 'update' observer tags the emitted update with its author and
// enqueues it; a REMOTE applyUpdate carries origin REMOTE and is never re-enqueued (no feedback).
let currentLocal: number | null = null

type Produced = { from: number; update: Uint8Array }

interface Net {
  docs: Y.Doc[]
  base: Uint8Array
  produced: Produced[]
  blocked: Set<string>
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

function makeReplicas(n: number, initialBlocks: number): Net {
  const seed = createDoc()
  for (let i = 0; i < initialBlocks; i++) appendBlock(seed, 'paragraph', MARK(i))
  const base = Y.encodeStateAsUpdate(seed)

  const produced: Produced[] = []
  const docs: Y.Doc[] = []
  for (let k = 0; k < n; k++) {
    const d = createDoc()
    Y.applyUpdate(d, base)
    d.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && currentLocal !== null) produced.push({ from: currentLocal, update })
    })
    docs.push(d)
  }
  return { docs, base, produced, blocked: new Set() }
}

// Run a mutation on one replica outside the generated schedule (the injected anchor merge). Captured
// by the observer because currentLocal is set, so it propagates like any local op.
function asLocal<T>(from: number, fn: () => T): T {
  currentLocal = from
  try {
    return fn()
  } finally {
    currentLocal = null
  }
}

type Op =
  | { k: 'insert'; pos: number; text: string }
  | { k: 'edit'; pos: number; text: string }
  | { k: 'delete'; pos: number }
  | { k: 'merge'; pos: number }

// A local op mutates one replica; model.ts mutators transact with the default origin, which the
// observer captures because currentLocal is set. Ids in `protectedIds` are exempt from edit/delete/
// merge-away so the anchor-under-concurrency property can pin content that no replica may disturb.
function doLocalOp(net: Net, from: number, protectedIds: ReadonlySet<string>, op: Op): void {
  const doc = net.docs[from]
  const arr = blocks(doc)
  const len = arr.length
  currentLocal = from
  try {
    if (op.k === 'insert') {
      const at = Math.min(op.pos % (len + 1), len)
      doc.transact(() => arr.insert(at, [makeBlock('paragraph', op.text)]))
      return
    }
    if (len === 0) return
    const i = op.pos % len
    const id = blockId(arr.get(i))
    if (protectedIds.has(id)) return
    if (op.k === 'edit') setBlockText(doc, id, op.text)
    else if (op.k === 'delete') doc.transact(() => arr.delete(i, 1))
    else if (op.k === 'merge' && i > 0) mergeIntoPrevious(doc, id)
  } finally {
    currentLocal = null
  }
}

function deliver(net: Net, to: number, sel: number): void {
  if (net.produced.length === 0) return
  const p = net.produced[sel % net.produced.length]
  if (p.from === to) return
  if (net.blocked.has(pairKey(p.from, to))) return
  Y.applyUpdate(net.docs[to], p.update, REMOTE)
}

function resync(net: Net, from: number, to: number): void {
  if (from === to || net.blocked.has(pairKey(from, to))) return
  const diff = Y.encodeStateAsUpdate(net.docs[from], Y.encodeStateVector(net.docs[to]))
  Y.applyUpdate(net.docs[to], diff, REMOTE)
}

type NetEvent =
  | { t: 'op'; r: number; op: Op }
  | { t: 'deliver'; to: number; sel: number }
  | { t: 'dup'; to: number; sel: number }
  | { t: 'drop' }
  | { t: 'resync'; from: number; to: number }
  | { t: 'partition'; a: number; b: number; heal: boolean }

function runEvent(net: Net, protectedIds: ReadonlySet<string>, e: NetEvent): void {
  const n = net.docs.length
  switch (e.t) {
    case 'op':
      doLocalOp(net, e.r % n, protectedIds, e.op)
      break
    case 'deliver':
    case 'dup':
      deliver(net, e.to % n, e.sel)
      break
    case 'drop':
      break
    case 'resync':
      resync(net, e.from % n, e.to % n)
      break
    case 'partition': {
      const key = pairKey(e.a % n, e.b % n)
      if (e.heal) net.blocked.delete(key)
      else net.blocked.add(key)
      break
    }
  }
}

// Quiescence drain: heal all partitions, then full-mesh state-vector resync to a fixpoint so the
// convergence assertions have a well-defined final state regardless of what the lossy phase did.
// Loops until every replica agrees (bounded by n+1 rounds) rather than a fixed 2 — robust for any n.
function drain(net: Net): void {
  net.blocked.clear()
  const n = net.docs.length
  for (let round = 0; round <= n; round++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) resync(net, i, j)
      }
    }
    if (allEqual(net.docs, viewsKey) && allEqual(net.docs, redirectsKey)) break
  }
}

function viewsKey(doc: Y.Doc): string {
  return JSON.stringify(blockViews(doc))
}
function redirectsKey(doc: Y.Doc): string {
  return JSON.stringify([...redirects(doc).entries()].sort())
}
function allEqual(docs: Y.Doc[], key: (d: Y.Doc) => string): boolean {
  const ref = key(docs[0])
  return docs.every((d) => key(d) === ref)
}

// Weighted toward local ops (and, within ops, toward merge) so a schedule reliably exercises the
// model.ts mutators + redirect path, not just network shuffling of an unchanged seed.
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant('insert' as const), pos: fc.nat(), text: fc.string({ maxLength: 12 }) }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant('edit' as const), pos: fc.nat(), text: fc.string({ maxLength: 12 }) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant('delete' as const), pos: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant('merge' as const), pos: fc.nat() }), weight: 3 },
)

const R = fc.integer({ min: 0, max: 3 })
const eventArb: fc.Arbitrary<NetEvent> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('op' as const), r: R, op: opArb }), weight: 5 },
  { arbitrary: fc.record({ t: fc.constant('deliver' as const), to: R, sel: fc.nat() }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('dup' as const), to: R, sel: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('drop' as const) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('resync' as const), from: R, to: R }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('partition' as const), a: R, b: R, heal: fc.boolean() }), weight: 1 },
)
const scheduleArb = fc.array(eventArb, { maxLength: 50 })
const nArb = fc.integer({ min: 2, max: 4 })

describe('PBT: distributed convergence + anchor-under-concurrency [in-memory, no provider]', () => {
  // Asserts Scroll's TWO parallel CRDT structures — the block array AND the redirect Y.Map — converge
  // in lockstep across replicas. Nothing about Yjs alone guarantees a consumer's separate structures
  // stay mutually consistent; this pins that they do for any lossy/reordered schedule.
  it('[SEC] all replicas converge to identical blockViews and redirects after any schedule', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 1, max: 6 }), scheduleArb, (n, init, events) => {
        const net = makeReplicas(n, init)
        for (const e of events) runEvent(net, NONE, e)
        drain(net)
        return allEqual(net.docs, viewsKey) && allEqual(net.docs, redirectsKey)
      }),
    )
  })

  // Stronger than [SEC]: compares the converged state to an INDEPENDENT once-each replay of the
  // produced updates. An order-dependent bug in model.ts would make converged ≠ ref even though the
  // replicas agree with each other. Every replica must match the canonical replay, not just docs[0].
  it('[commutativity] adversarial reorder+dup converges to the canonical once-each replay', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 1, max: 6 }), scheduleArb, (n, init, events) => {
        const net = makeReplicas(n, init)
        for (const e of events) runEvent(net, NONE, e)
        drain(net)

        const ref = createDoc()
        Y.applyUpdate(ref, net.base)
        for (const p of net.produced) Y.applyUpdate(ref, p.update, REMOTE)

        const refKey = viewsKey(ref)
        return net.docs.every((d) => viewsKey(d) === refKey)
      }),
    )
  })

  // The DS thesis with teeth: replica 0 merges the anchor away (creating a redirect), while other
  // replicas concurrently mutate a doc where the anchor still exists. After convergence, on EVERY
  // replica the redirect must have propagated and resolveEffectiveAnchor must chase it to the
  // predecessor — exercising anchor.ts:11-12 (the redirect branch), never the top-of-doc fallback.
  // Anchor + predecessor are protected so their content is stable and the successor never leaves.
  it('[anchor-under-concurrency] a merged-away anchor resolves to its successor on all replicas', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 3, max: 8 }), fc.nat(), scheduleArb, (n, init, aSel, events) => {
        const net = makeReplicas(n, init)
        const order0 = blockOrder(net.docs[0])
        // j>=2 keeps predId off index 0, so eff.blockId===predId strictly distinguishes the redirect
        // branch from the top-of-doc fallback (which also returns order[0]) in every run.
        const j = 2 + (aSel % (init - 2))
        const anchorId = order0[j]
        const predId = order0[j - 1]
        const guarded: ReadonlySet<string> = new Set([anchorId, predId])

        if (asLocal(0, () => mergeIntoPrevious(net.docs[0], anchorId)) !== predId) return false

        for (const e of events) runEvent(net, guarded, e)
        drain(net)

        return net.docs.every((doc) => {
          const order = blockOrder(doc)
          if (order.includes(anchorId)) return false
          const eff = resolveEffectiveAnchor(order, redirectSource(doc), { blockId: anchorId, offset: 7 })
          if (eff.blockId !== predId || eff.offset !== 0) return false
          const idx = indexOfBlock(doc, predId)
          if (idx < 0) return false
          const text = blockText(blocks(doc).get(idx)).toString()
          return text.includes(MARK(j)) && text.includes(MARK(j - 1))
        })
      }),
    )
  })
})
