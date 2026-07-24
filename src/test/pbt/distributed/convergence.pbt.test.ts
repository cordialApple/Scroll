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
  for (let i = 0; i < initialBlocks; i++) appendBlock(seed, 'paragraph', `init ${i}`)
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

type Op =
  | { k: 'insert'; pos: number; text: string }
  | { k: 'edit'; pos: number; text: string }
  | { k: 'delete'; pos: number }
  | { k: 'merge'; pos: number }

// A local op mutates one replica; model.ts mutators transact with the default origin, which the
// observer captures because currentLocal is set. protectedId is exempt from edit/delete/merge (the
// anchor-under-concurrency property holds a block that no replica is allowed to disturb).
function doLocalOp(net: Net, from: number, protectedId: string, op: Op): void {
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
    if (id === protectedId) return
    if (op.k === 'edit') setBlockText(doc, id, op.text)
    else if (op.k === 'delete') doc.transact(() => arr.delete(i, 1))
    else if (op.k === 'merge' && i > 0) mergeIntoPrevious(doc, id)
  } finally {
    currentLocal = null
  }
}

function deliver(net: Net, to: number, sel: number, allowRedeliver: boolean): void {
  if (net.produced.length === 0) return
  const p = net.produced[sel % net.produced.length]
  if (p.from === to) return
  if (net.blocked.has(pairKey(p.from, to))) return
  void allowRedeliver
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

function runEvent(net: Net, protectedId: string, e: NetEvent): void {
  const n = net.docs.length
  switch (e.t) {
    case 'op':
      doLocalOp(net, e.r % n, protectedId, e.op)
      break
    case 'deliver':
      deliver(net, e.to % n, e.sel, false)
      break
    case 'dup':
      deliver(net, e.to % n, e.sel, true)
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
function drain(net: Net): void {
  net.blocked.clear()
  const n = net.docs.length
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) resync(net, i, j)
      }
    }
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

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant('insert' as const), pos: fc.nat(), text: fc.string({ maxLength: 12 }) }),
  fc.record({ k: fc.constant('edit' as const), pos: fc.nat(), text: fc.string({ maxLength: 12 }) }),
  fc.record({ k: fc.constant('delete' as const), pos: fc.nat() }),
  fc.record({ k: fc.constant('merge' as const), pos: fc.nat() }),
)

const R = fc.integer({ min: 0, max: 3 })
const eventArb: fc.Arbitrary<NetEvent> = fc.oneof(
  fc.record({ t: fc.constant('op' as const), r: R, op: opArb }),
  fc.record({ t: fc.constant('deliver' as const), to: R, sel: fc.nat() }),
  fc.record({ t: fc.constant('dup' as const), to: R, sel: fc.nat() }),
  fc.record({ t: fc.constant('drop' as const) }),
  fc.record({ t: fc.constant('resync' as const), from: R, to: R }),
  fc.record({ t: fc.constant('partition' as const), a: R, b: R, heal: fc.boolean() }),
)
const scheduleArb = fc.array(eventArb, { maxLength: 50 })
const nArb = fc.integer({ min: 2, max: 4 })

describe('PBT: distributed convergence + anchor-under-concurrency [in-memory, no provider]', () => {
  it('[SEC] all replicas converge to identical blockViews and redirects after any schedule', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 1, max: 6 }), scheduleArb, (n, init, events) => {
        const net = makeReplicas(n, init)
        for (const e of events) runEvent(net, '', e)
        drain(net)
        return allEqual(net.docs, viewsKey) && allEqual(net.docs, redirectsKey)
      }),
    )
  })

  it('[commutativity] adversarial reorder+dup converges to the canonical once-each replay', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 1, max: 6 }), scheduleArb, (n, init, events) => {
        const net = makeReplicas(n, init)
        for (const e of events) runEvent(net, '', e)
        drain(net)

        const ref = createDoc()
        Y.applyUpdate(ref, net.base)
        for (const p of net.produced) Y.applyUpdate(ref, p.update, REMOTE)

        return viewsKey(net.docs[0]) === viewsKey(ref)
      }),
    )
  })

  it('[anchor-under-concurrency] A stays anchored while B/C mutate; never teleports to top', () => {
    pbtAssert(
      fc.property(nArb, fc.integer({ min: 2, max: 8 }), fc.nat(), scheduleArb, (n, init, aSel, events) => {
        const net = makeReplicas(n, init)
        const j = aSel % init
        const anchorId = blockOrder(net.docs[0])[j]

        for (const e of events) runEvent(net, anchorId, e)
        drain(net)

        const doc = net.docs[0]
        const order = blockOrder(doc)
        const eff = resolveEffectiveAnchor(order, redirectSource(doc), { blockId: anchorId, offset: 7 })
        if (eff.blockId !== anchorId || eff.offset !== 7) return false
        const idx = indexOfBlock(doc, anchorId)
        // Other replicas may merge blocks INTO the anchor, appending text; its original content
        // survives as a prefix and the user is still looking at the same logical location.
        return idx >= 0 && blockText(blocks(doc).get(idx)).toString().startsWith(`init ${j}`)
      }),
    )
  })
})
