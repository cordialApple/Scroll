import 'fake-indexeddb/auto'
import net from 'node:net'
import fc from 'fast-check'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { startScrollServer } from '../../../../server/hocuspocus'
import { createPostgresStore } from '../../../../server/db/store'
import { openDoc, type DocHandle } from '../../../doc/persistence'
import {
  createDoc,
  blocks,
  blockId,
  blockOrder,
  blockText,
  blockViews,
  indexOfBlock,
  makeBlock,
  mergeIntoPrevious,
  redirects,
  redirectSource,
  setBlockText,
} from '../../../doc/model'
import { resolveEffectiveAnchor } from '../../../doc/anchor'
import { ChaosController } from './chaos'

// Real transport, so the sync-only entropy-freezing PBT harness (withDeterminism bans timers/awaits) does
// NOT apply here — sockets need real time. fast-check still gives us reproducible SCHEDULES via a fixed
// seed; the asserted invariant (eventual convergence / durability) is timing-independent, so nondetermin-
// istic delivery timing can't make a correct system fail, only a broken one.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'
const SEED = Number(process.env.PBT_SEED ?? 0x5c0011)
const RUNS = Number(process.env.PBT_PROVIDER_RUNS ?? 10)
// The restart/reload and anchor properties do more per run; halve their count (floor 4) so a full pass
// stays inside the suite's time budget without starving coverage.
const HEAVY_RUNS = Math.max(4, RUNS >> 1)

const pool = new Pool({ connectionString: DATABASE_URL })
afterAll(async () => {
  await pool.end()
})

// ⚓ frames seed text so an assertion "pred contains MARK(j)" can't be satisfied by generated ASCII noise.
const MARK = (i: number) => `⚓${i}⚓`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false
    await tick(20)
  }
  return true
}

// Fast reconnect so a schedule full of cuts doesn't spend seconds in backoff — we test convergence, not
// the retry curve.
function chaosSocket(url: string, ctrl: ChaosController): HocuspocusProviderWebsocket {
  return new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: ctrl.polyfill(),
    minDelay: 50,
    maxDelay: 200,
    delay: 50,
    factor: 1,
    messageReconnectTimeout: 5000,
  })
}

interface Peer {
  handle: DocHandle
  ctrl: ChaosController
  socket: HocuspocusProviderWebsocket
}

type Op =
  | { k: 'insert'; pos: number; text: string }
  | { k: 'edit'; pos: number; text: string }
  | { k: 'delete'; pos: number }
  | { k: 'merge'; pos: number }

function applyOp(doc: Y.Doc, op: Op, guarded: ReadonlySet<string>): void {
  const arr = blocks(doc)
  const len = arr.length
  if (op.k === 'insert') {
    const at = Math.min(op.pos % (len + 1), len)
    doc.transact(() => arr.insert(at, [makeBlock('paragraph', op.text)]))
    return
  }
  if (len === 0) return
  const i = op.pos % len
  const id = blockId(arr.get(i))
  if (guarded.has(id)) return
  if (op.k === 'edit') setBlockText(doc, id, op.text)
  else if (op.k === 'delete') doc.transact(() => arr.delete(i, 1))
  else if (op.k === 'merge' && i > 0) mergeIntoPrevious(doc, id)
}

type Event =
  | { t: 'op'; r: number; op: Op }
  | { t: 'cut'; r: number }
  | { t: 'drop'; r: number; on: boolean }
  | { t: 'dupe'; r: number; on: boolean }
  | { t: 'settle' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant('insert' as const), pos: fc.nat(), text: fc.string({ maxLength: 8 }) }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant('edit' as const), pos: fc.nat(), text: fc.string({ maxLength: 8 }) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant('delete' as const), pos: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('merge' as const), pos: fc.nat() }), weight: 2 },
)

const R = fc.integer({ min: 0, max: 2 })
const eventArb: fc.Arbitrary<Event> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('op' as const), r: R, op: opArb }), weight: 5 },
  { arbitrary: fc.record({ t: fc.constant('cut' as const), r: R }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('drop' as const), r: R, on: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('dupe' as const), r: R, on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('settle' as const) }), weight: 2 },
)
const scheduleArb = fc.array(eventArb, { minLength: 4, maxLength: 16 })
const nArb = fc.integer({ min: 2, max: 3 })
const initArb = fc.integer({ min: 2, max: 5 })

function viewsKey(doc: Y.Doc): string {
  return JSON.stringify(blockViews(doc))
}
function redirectsKey(doc: Y.Doc): string {
  return JSON.stringify([...redirects(doc).entries()].sort())
}

async function makePeers(n: number, room: string, url: string, seed: boolean): Promise<Peer[]> {
  const peers: Peer[] = []
  for (let k = 0; k < n; k++) {
    const ctrl = new ChaosController()
    const socket = chaosSocket(url, ctrl)
    // Only peer 0 seeds; the rest boot empty and pull the seed over the wire (as real late joiners do).
    const handle = openDoc(`peer${k}-${room}`, { room, seed: seed && k === 0, websocketProvider: socket })
    peers.push({ handle, ctrl, socket })
  }
  await Promise.all(peers.map((p) => p.handle.whenSynced))
  return peers
}

function destroyPeers(peers: Peer[]): void {
  for (const p of peers) {
    p.handle.destroy()
    p.socket.destroy()
  }
}

// Drive a schedule, then HEAL: clear all chaos, force one clean reconnect on every peer, and wait for the
// live peers to converge. Returns whether convergence was reached within budget.
async function runSchedule(peers: Peer[], events: Event[], guarded: ReadonlySet<string>): Promise<boolean> {
  for (const e of events) {
    if (e.t === 'op') applyOp(peers[e.r % peers.length].handle.doc, e.op, guarded)
    else if (e.t === 'cut') peers[e.r % peers.length].ctrl.cut()
    else if (e.t === 'drop') peers[e.r % peers.length].ctrl.drop = e.on
    else if (e.t === 'dupe') peers[e.r % peers.length].ctrl.dupe = e.on
    await tick(e.t === 'cut' ? 60 : 15)
  }
  // Ordering here is load-bearing, not stylistic: EVERY peer's drop/dupe must be cleared before ANY cut
  // fires. ChaosSocket.send reads ctrl.drop live, including on the fresh socket a reconnect creates — so
  // a peer still in drop at the moment of its own reconnect would silently swallow its own resync
  // (SyncStep1), losing its pending edits. Do not merge these two loops into one per-peer pass.
  for (const p of peers) {
    p.ctrl.drop = false
    p.ctrl.dupe = false
  }
  for (const p of peers) p.ctrl.cut()
  return waitFor(() => {
    const vk = viewsKey(peers[0].handle.doc)
    const rk = redirectsKey(peers[0].handle.doc)
    return peers.every((p) => viewsKey(p.handle.doc) === vk && redirectsKey(p.handle.doc) === rk)
  })
}

const NONE: ReadonlySet<string> = new Set()

describe('PBT: provider-chaos over real transport', () => {
  let server: Hocuspocus | null = null
  let url = ''

  beforeAll(async () => {
    const port = await freePort()
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL })
    url = `ws://127.0.0.1:${port}`
  })
  afterAll(async () => {
    if (server) await server.destroy()
    server = null
  })

  const openPeers: Peer[][] = []
  afterEach(() => {
    for (const peers of openPeers.splice(0)) destroyPeers(peers)
  })

  it('[SEC] all peers converge to identical blockViews + redirects after any lossy/reconnect schedule', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(nArb, initArb, scheduleArb, async (n, init, events) => {
        const room = `sec-${run++}-${process.pid}`
        const peers = await makePeers(n, room, url, true)
        openPeers.push(peers)
        for (let i = 0; i < init; i++) applyOp(peers[0].handle.doc, { k: 'insert', pos: i, text: `m${i}` }, NONE)

        const converged = await runSchedule(peers, events, NONE)
        expect(converged, `peers did not converge for room ${room}`).toBe(true)

        destroyPeers(peers)
        openPeers.splice(openPeers.indexOf(peers), 1)
        return true
      }),
      { seed: SEED, numRuns: RUNS },
    )
  }, 300000)
})

// Persist-before-broadcast under chaos. The server's compaction debounce is pushed past the whole test,
// so no snapshot is ever written — the ONLY durable record is the append log. Reconstructing the exact
// converged state from that log alone proves every op the peers agreed on was persisted before it was
// broadcast, even across drops and reconnects. Sabotage (skip/reorder the append) empties the log →
// reconstruction diverges → RED. The null-snapshot assertion is what forecloses "a memory snapshot
// carried it" as an alternative explanation.
describe('PBT: provider-chaos durability (persist-before-broadcast over the wire)', () => {
  let server: Hocuspocus | null = null
  let url = ''
  const store = createPostgresStore(pool)

  beforeAll(async () => {
    const port = await freePort()
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, debounce: 600000, maxDebounce: 600000 })
    url = `ws://127.0.0.1:${port}`
  })
  afterAll(async () => {
    if (server) await server.destroy()
    server = null
  })

  const openPeers: Peer[][] = []
  const keepers: DocHandle[] = []
  const keeperSockets: HocuspocusProviderWebsocket[] = []
  afterEach(() => {
    for (const peers of openPeers.splice(0)) destroyPeers(peers)
    for (const h of keepers.splice(0)) h.destroy()
    for (const s of keeperSockets.splice(0)) s.destroy()
  })

  it('[durability] the converged state reconstructs from the append log alone (snapshot never written)', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(nArb, initArb, scheduleArb, async (n, init, events) => {
        const room = `dur-${run++}-${process.pid}`
        const peers = await makePeers(n, room, url, true)
        openPeers.push(peers)

        // A keeper holds the room resident so the connection count never hits 0: without it the heal
        // cut (which drops every chaos peer at once) would momentarily leave the server with 0
        // connections, and Hocuspocus's unloadImmediately forces a compaction on unload — writing the
        // very snapshot this property must NOT see. It runs on a plain socket with a huge
        // messageReconnectTimeout so its own watchdog never fires mid-run, and — critically — we await
        // network `synced`, not just whenSynced (local-only), so the server-side Connection is actually
        // registered before the first cut. whenSynced alone gates on IndexedDB and could leave a
        // 0-connection window.
        const keeperSocket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket, messageReconnectTimeout: 600000 })
        keeperSockets.push(keeperSocket)
        const keep = openDoc(`keeper-${room}`, { room, seed: false, websocketProvider: keeperSocket })
        keepers.push(keep)
        await keep.whenSynced
        const keeperConnected = await waitFor(() => keep.network?.synced === true)
        expect(keeperConnected, `keeper never reached the server for ${room}`).toBe(true)

        // A guarded sentinel that no op can delete/merge/edit guarantees the doc is never emptied to
        // "[]" — otherwise a schedule that drains every block makes the reconstruction assertion below
        // "[]" === "[]", true even against a fully-empty (sabotaged) append log. The sentinel keeps the
        // equality load-bearing on every run.
        const sentinel = makeBlock('paragraph', `sentinel-${room}`)
        peers[0].handle.doc.transact(() => blocks(peers[0].handle.doc).insert(0, [sentinel]))
        const guarded: ReadonlySet<string> = new Set([blockId(sentinel)])
        for (let i = 0; i < init; i++) applyOp(peers[0].handle.doc, { k: 'insert', pos: i, text: `d${i}` }, guarded)

        const converged = await runSchedule(peers, events, guarded)
        expect(converged, `peers did not converge for room ${room}`).toBe(true)
        const finalViews = viewsKey(peers[0].handle.doc)
        const finalRedirects = redirectsKey(peers[0].handle.doc)
        expect(finalViews).not.toBe('[]')

        // Peers stay connected and the debounce is huge, so nothing has compacted: durable state is the
        // raw append log. Fold it onto a fresh doc and it must equal what the peers converged on — both
        // the block array AND the redirects map, so the proof is full-doc, not blocks-only.
        const loaded = await store.loadDocument(room)
        expect(loaded.snapshot, `no compaction should have run for ${room}`).toBeNull()
        const replay = createDoc()
        for (const u of loaded.updates) Y.applyUpdate(replay, u)
        expect(viewsKey(replay), `append-log block reconstruction diverged for ${room}`).toBe(finalViews)
        expect(redirectsKey(replay), `append-log redirect reconstruction diverged for ${room}`).toBe(finalRedirects)

        destroyPeers(peers)
        openPeers.splice(openPeers.indexOf(peers), 1)
        keep.destroy()
        keepers.splice(keepers.indexOf(keep), 1)
        keeperSocket.destroy()
        keeperSockets.splice(keeperSockets.indexOf(keeperSocket), 1)
        return true
      }),
      { seed: SEED, numRuns: HEAVY_RUNS },
    )
  }, 300000)
})

// The §5A anchor-under-concurrency thesis lifted onto real transport: one peer merges an anchor block
// away (leaving a redirect) while the others concurrently edit under a lossy/reconnect schedule. After
// convergence, every peer's redirect must have propagated and resolveEffectiveAnchor must chase the
// merged-away anchor to its predecessor — the redirect branch, not the top-of-doc fallback.
describe('PBT: provider-chaos anchor-under-concurrency (over the wire)', () => {
  let server: Hocuspocus | null = null
  let url = ''

  beforeAll(async () => {
    const port = await freePort()
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL })
    url = `ws://127.0.0.1:${port}`
  })
  afterAll(async () => {
    if (server) await server.destroy()
    server = null
  })

  const openPeers: Peer[][] = []
  afterEach(() => {
    for (const peers of openPeers.splice(0)) destroyPeers(peers)
  })

  it('[anchor] a merged-away anchor resolves to its predecessor on every peer after a chaos schedule', async () => {
    let run = 0
    await fc.assert(
      fc.asyncProperty(nArb, fc.integer({ min: 4, max: 7 }), fc.nat(), scheduleArb, async (n, init, aSel, events) => {
        const room = `anchor-${run++}-${process.pid}`
        // No seed on any peer: build a known MARK-only spine on peer 0 so anchor/predecessor ids are
        // unambiguous, then let it replicate before choosing the anchor.
        const peers = await makePeers(n, room, url, false)
        openPeers.push(peers)

        const spine = peers[0].handle.doc
        for (let i = 0; i < init; i++) spine.transact(() => blocks(spine).insert(i, [makeBlock('paragraph', MARK(i))]))
        const spread = await waitFor(() => peers.every((p) => blockOrder(p.handle.doc).length === init))
        expect(spread, `spine did not replicate for ${room}`).toBe(true)

        // j>=2 keeps the predecessor off index 0, so resolving to predId strictly proves the redirect
        // branch (top-of-doc fallback would also return order[0]).
        const order0 = blockOrder(spine)
        const j = 2 + (aSel % (init - 2))
        const anchorId = order0[j]
        const predId = order0[j - 1]
        const guarded: ReadonlySet<string> = new Set([anchorId, predId])

        expect(mergeIntoPrevious(spine, anchorId)).toBe(predId)

        const converged = await runSchedule(peers, events, guarded)
        expect(converged, `peers did not converge for ${room}`).toBe(true)

        const ok = peers.every((p) => {
          const doc = p.handle.doc
          const order = blockOrder(doc)
          if (order.includes(anchorId)) return false
          const eff = resolveEffectiveAnchor(order, redirectSource(doc), { blockId: anchorId, offset: 7 })
          if (eff.blockId !== predId || eff.offset !== 0) return false
          const idx = indexOfBlock(doc, predId)
          if (idx < 0) return false
          const text = blockText(blocks(doc).get(idx)).toString()
          return text.includes(MARK(j)) && text.includes(MARK(j - 1))
        })
        expect(ok, `anchor did not resolve to predecessor on all peers for ${room}`).toBe(true)

        destroyPeers(peers)
        openPeers.splice(openPeers.indexOf(peers), 1)
        return true
      }),
      { seed: SEED, numRuns: HEAVY_RUNS },
    )
  }, 300000)
})
