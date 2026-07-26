import 'fake-indexeddb/auto'
import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { openDoc, type DocHandle } from './persistence'
import { appendBlock, blockViews } from './model'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'

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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const sockets: HocuspocusProviderWebsocket[] = []
function wsPeer(url: string): HocuspocusProviderWebsocket {
  const s = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket })
  sockets.push(s)
  return s
}

const pool = new Pool({ connectionString: DATABASE_URL })
afterAll(async () => {
  await pool.end()
})

async function updateCount(docId: string): Promise<number> {
  const res = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM document_updates WHERE doc_id = $1', [docId])
  return res.rows[0].n
}

let server: Hocuspocus | null = null
const handles: DocHandle[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) h.destroy()
  for (const s of sockets.splice(0)) s.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

describe('P3.4 persist-before-broadcast durability', () => {
  it('the ingress append is synchronous, not routed through the debounced compaction path', async () => {
    const port1 = await freePort()
    const docId = `sync-${port1}`
    server = await startScrollServer({ port: port1, databaseUrl: DATABASE_URL })

    const a = openDoc(`peerA-${docId}`, { room: docId, seed: true, websocketProvider: wsPeer(`ws://127.0.0.1:${port1}`) })
    handles.push(a)
    await a.whenSynced

    appendBlock(a.doc, 'paragraph', 'durable before crash')

    // 300ms is well under Hocuspocus's default onStoreDocument debounce (2000ms) — a regression that
    // routed the append through that debounced path instead of the synchronous beforeHandleMessage
    // hook would still land the row eventually, but not within this budget. Catches exactly the class
    // of regression a longer, more forgiving timeout would silently let slide.
    await waitFor(async () => (await updateCount(docId)) > 0, 300)
  })

  it('a full server restart recovers an update that was durably logged before the crash', async () => {
    const port1 = await freePort()
    const docId = `crash-${port1}`
    server = await startScrollServer({ port: port1, databaseUrl: DATABASE_URL })

    const a = openDoc(`peerA-${docId}`, { room: docId, seed: true, websocketProvider: wsPeer(`ws://127.0.0.1:${port1}`) })
    handles.push(a)
    await a.whenSynced

    appendBlock(a.doc, 'paragraph', 'durable before crash')
    await waitFor(async () => (await updateCount(docId)) > 0)

    // Kill the server. destroy() only (leave `a`'s client dangling, same as a real crash) so there's a
    // single unload path to race, not a client-close and a server-close both firing at once. Under
    // Hocuspocus's defaults this always flushes a compaction on unload before the pool closes — so this
    // test exercises restart-recovers-via-snapshot, not raw log-tail replay in isolation (that path is
    // covered directly, without fighting Hocuspocus's unload/debounce behavior, by the
    // "log-tail replay alone" store-level test below).
    await server.destroy()
    server = null

    const port2 = await freePort()
    server = await startScrollServer({ port: port2, databaseUrl: DATABASE_URL })
    const b = openDoc(`peerB-${docId}`, { room: docId, seed: false, websocketProvider: wsPeer(`ws://127.0.0.1:${port2}`) })
    handles.push(b)
    await b.whenSynced

    // whenSynced only gates on b's own (empty) local indexeddb — the network round-trip to server2 is
    // still in flight, so the recovered content must be awaited explicitly.
    await waitFor(() => blockViews(b.doc).some((v) => v.text === 'durable before crash'))
    expect(blockViews(b.doc).some((v) => v.text === 'durable before crash')).toBe(true)
  })

  it('log-tail replay alone (no snapshot ever written) reconstructs the document', async () => {
    // Store-level, deliberately bypassing Hocuspocus/server.destroy() entirely — its unload flow always
    // flushes a compaction (see the test above), so it can't isolate this path. appendUpdate is exactly
    // what beforeHandleMessage calls; this proves loadDocument correctly replays a log with no snapshot
    // row at all, independent of any server lifecycle timing.
    const store = createPostgresStore(pool)
    const docId = `logonly-${await freePort()}`

    const doc = new Y.Doc()
    appendBlock(doc, 'paragraph', 'from the log only')
    await store.appendUpdate(docId, 0, Y.encodeStateAsUpdate(doc))

    const loaded = await store.loadDocument(docId)
    expect(loaded.snapshot).toBeNull()
    expect(loaded.updates.length).toBe(1)

    const replayed = new Y.Doc()
    for (const update of loaded.updates) Y.applyUpdate(replayed, update)
    expect(blockViews(replayed).some((v) => v.text === 'from the log only')).toBe(true)
  })

  // "Kill client A after it emits an op but before ack" (issue #33) is scoped down here to "client A
  // never got a chance to emit at all" (no network) rather than a genuine mid-flight drop: forcing a
  // real WebSocket to lose an already-queued send deterministically would need a hard socket reset
  // (SO_LINGER=0 / .terminate()) that HocuspocusProviderWebsocket doesn't expose — a graceful close, by
  // spec, still flushes what's already been handed to the transport. The property under test (the
  // client's durable indexeddb queue is what makes reconnect-and-redeliver work, independent of what
  // triggered the gap) is the same either way.
  it('a client that dies before syncing still delivers its edit — reopening the same local doc self-heals via its indexeddb requeue', async () => {
    const port = await freePort()
    const docId = `selfheal-${port}`
    const localId = `peerA-${docId}`

    // "Client A" writes fully offline (no network at all), then the process dies. Nothing ever reached
    // the wire — only its local y-indexeddb queue is durable.
    const offline = openDoc(localId, { room: docId, seed: true })
    await offline.whenSynced
    appendBlock(offline.doc, 'paragraph', 'queued while offline')
    // No sleep here: y-indexeddb's update listener issues its IndexedDB write synchronously off the
    // Yjs 'update' event (see y-indexeddb.js's `doc.on('update', this._storeUpdate)`); destroy()'s
    // db.close() is spec-guaranteed to wait for any transaction already opened on that connection to
    // finish before actually closing, so there's no flush-completion signal to poll for here.
    offline.destroy()

    expect(await updateCount(docId)).toBe(0)

    server = await startScrollServer({ port, databaseUrl: DATABASE_URL })

    // "A fresh client" = reopening the same local doc id, now with a real network connection.
    const revived = openDoc(localId, { room: docId, seed: false, websocketProvider: wsPeer(`ws://127.0.0.1:${port}`) })
    handles.push(revived)
    await revived.whenSynced

    await waitFor(async () => (await updateCount(docId)) > 0)

    const b = openDoc(`peerB-${docId}`, { room: docId, seed: false, websocketProvider: wsPeer(`ws://127.0.0.1:${port}`) })
    handles.push(b)
    await b.whenSynced
    await waitFor(() => blockViews(b.doc).some((v) => v.text === 'queued while offline'))
    expect(blockViews(b.doc).some((v) => v.text === 'queued while offline')).toBe(true)
  })
})
