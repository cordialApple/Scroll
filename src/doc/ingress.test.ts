import 'fake-indexeddb/auto'
import net from 'node:net'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_WRITE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import { openDoc, type DocHandle } from './persistence'
import { createDoc, appendBlock, blockViews } from './model'

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

// A ws subclass that records every close code/reason it sees and hands the live socket to the test for
// raw frame injection. The provider builds `new Polyfill(url)` per (re)connect, so `seen` outlives any
// single socket instance.
function recordingPolyfill(seen: { code: number; reason: string }[], live: { ws: WebSocket | null }) {
  return class RecordingSocket extends WebSocket {
    constructor(url: string) {
      super(url)
      live.ws = this
      this.addEventListener('close', (ev: { code: number; reason: string }) => {
        seen.push({ code: ev.code, reason: ev.reason })
      })
    }
  } as unknown as typeof WebSocket
}

// Hocuspocus wire frame: [docName][MessageType.Sync=0][messageYjsUpdate=2][payload]. Injected onto an
// already-established socket, it reaches the server's Connection.handleMessage → beforeHandleMessage guard.
function syncUpdateFrame(docName: string, payload: Uint8Array, subtype: number = messageYjsUpdate): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, docName)
  encoding.writeVarUint(enc, 0)
  encoding.writeVarUint(enc, subtype)
  encoding.writeVarUint8Array(enc, payload)
  return encoding.toUint8Array(enc)
}

// A VALID Yjs update whose encoding exceeds `minBytes`. Validity is what makes the sabotage direction
// meaningful: with the guard removed the server must accept-and-apply it, proving the guard (not a decode
// error) is what refuses. Random bytes would fail to apply and muddy that signal.
function oversizedValidUpdate(minBytes: number): Uint8Array {
  const doc = createDoc()
  let i = 0
  let update = Y.encodeStateAsUpdate(doc)
  while (update.byteLength <= minBytes) {
    appendBlock(doc, 'paragraph', `bloat-${i}-${'x'.repeat(64)}`)
    i++
    update = Y.encodeStateAsUpdate(doc)
  }
  return update
}

const pool = new Pool({ connectionString: DATABASE_URL })
afterAll(async () => {
  await pool.end()
})

async function maxRowBytes(docId: string): Promise<number> {
  const res = await pool.query<{ n: number | null }>(
    'SELECT max(octet_length(update))::int AS n FROM document_updates WHERE doc_id = $1',
    [docId],
  )
  return res.rows[0].n ?? 0
}

const sockets: HocuspocusProviderWebsocket[] = []
const providers: HocuspocusProvider[] = []
let server: Hocuspocus | null = null
const handles: DocHandle[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) h.destroy()
  for (const p of providers.splice(0)) p.destroy()
  for (const s of sockets.splice(0)) s.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

function connectWithToken(room: string, url: string, token: string): HocuspocusProvider {
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket, minDelay: 50, maxDelay: 200 })
  sockets.push(socket)
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: createDoc(), token, preserveConnection: false })
  providers.push(provider)
  return provider
}

describe('P3.6 ingress guard — refuse-and-resync', () => {
  it('an oversized update is refused (4400, with reason), never persisted, and the refused peer resyncs', async () => {
    const port = await freePort()
    const room = `ingress-${port}`
    const LIMIT = 4096
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, maxUpdateBytes: LIMIT })
    const url = `ws://127.0.0.1:${port}`

    const seen: { code: number; reason: string }[] = []
    const live: { ws: WebSocket | null } = { ws: null }
    const attacker = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: recordingPolyfill(seen, live),
      minDelay: 50,
      maxDelay: 200,
      delay: 50,
      factor: 1,
    })
    sockets.push(attacker)

    const a = openDoc(`peerA-${room}`, { room, seed: true, websocketProvider: attacker })
    handles.push(a)
    await a.whenSynced
    appendBlock(a.doc, 'paragraph', 'legit content')
    await waitFor(async () => (await maxRowBytes(room)) > 0)

    const oversized = oversizedValidUpdate(LIMIT)
    expect(oversized.byteLength).toBeGreaterThan(LIMIT)
    live.ws!.send(syncUpdateFrame(room, oversized))

    await waitFor(() => seen.some((c) => c.code === 4400))
    expect(seen.find((c) => c.code === 4400)!.reason).toContain('rejected')

    // The oversized payload never became a row: the widest persisted update stays under the cap.
    expect(await maxRowBytes(room)).toBeLessThan(LIMIT)

    // The RESYNC half, on the refused connection itself: after the 4400 close the attacker peer must
    // reconnect and keep making progress. A NEW edit written post-refusal only reaches a fresh reader if
    // `a`'s own socket came back — this is what a fresh peer converging (which would pass even against a
    // permanently-dead refused peer) cannot prove.
    appendBlock(a.doc, 'paragraph', 'after refusal survives')

    const cleanSocket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket })
    sockets.push(cleanSocket)
    const reader = openDoc(`peerC-${room}`, { room, seed: false, websocketProvider: cleanSocket })
    handles.push(reader)
    await reader.whenSynced
    await waitFor(() => {
      const texts = blockViews(reader.doc).map((v) => v.text)
      return texts.includes('legit content') && texts.includes('after refusal survives')
    })
    const texts = blockViews(reader.doc).map((v) => v.text)
    expect(texts).toContain('legit content')
    expect(texts).toContain('after refusal survives')
  })

  it('a structurally-corrupt update payload (valid envelope, garbage CRDT bytes) is refused, not persisted', async () => {
    const port = await freePort()
    const room = `malformed-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL })
    const url = `ws://127.0.0.1:${port}`

    const seen: { code: number; reason: string }[] = []
    const live: { ws: WebSocket | null } = { ws: null }
    const socket = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: recordingPolyfill(seen, live),
      minDelay: 50,
      maxDelay: 200,
    })
    sockets.push(socket)
    const a = openDoc(`peerA-${room}`, { room, seed: true, websocketProvider: socket })
    handles.push(a)
    await a.whenSynced
    await waitFor(async () => (await maxRowBytes(room)) > 0)

    // Valid Hocuspocus/sync envelope wrapping bytes that are NOT a decodable Yjs update. The envelope
    // passes extractSyncUpdate; the payload fails Y.applyUpdate — which is exactly what a room load would
    // choke on, so it must never enter the durable log.
    const garbage = new Uint8Array([9, 9, 9, 255, 255, 7, 3, 1, 200, 200])
    live.ws!.send(syncUpdateFrame(room, garbage))

    await waitFor(() => seen.some((c) => c.code === 4400))
    expect(seen.find((c) => c.code === 4400)!.reason).toContain('payload')

    // The durable state stays clean and fully decodable: reconstructing from snapshot+log applies without
    // throwing and yields the seeded doc. Had the guard let the garbage through, it would sit in the log
    // as an un-applied row (its apply throws, so compaction never folds/deletes it) and this replay would
    // throw — so a clean reconstruction is the proof it was never persisted.
    const loaded = await createPostgresStore(pool).loadDocument(room)
    const replay = createDoc()
    if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
    for (const u of loaded.updates) Y.applyUpdate(replay, u)
    expect(blockViews(replay).length).toBeGreaterThan(0)
  })
})

describe('P3.6 onAuthenticate seam (contract-7 trust root)', () => {
  const SECRET = 'agent-42'

  it('a valid token authenticates; a rejected token is denied', async () => {
    const port = await freePort()
    const room = `auth-${port}`
    server = await startScrollServer({
      port,
      databaseUrl: DATABASE_URL,
      authenticate: (token: string) => {
        // Stub trust root: identity IS the token, and only the known secret is admitted. Real issuance
        // (room-scoped tokens, Scroll-asserted roles) is P4 — this only proves the seam gates.
        if (token !== SECRET) throw new Error('permission-denied: unknown token')
        return { user: token }
      },
    })
    const url = `ws://127.0.0.1:${port}`

    const authed = connectWithToken(room, url, SECRET)
    await waitFor(() => authed.isAuthenticated)
    expect(authed.isAuthenticated).toBe(true)

    const denied = connectWithToken(room, url, 'forged-token')
    let failed = false
    denied.on('authenticationFailed', () => {
      failed = true
    })
    await waitFor(() => failed)
    expect(failed).toBe(true)
    expect(denied.isAuthenticated).toBe(false)
  })
})

describe('P4.1 room-scoped peer tokens over the wire (contract-7)', () => {
  const SECRET = 'wire-trust-root'

  it('a token minted for THIS room admits; one minted for another room is denied; expired is denied', async () => {
    const port = await freePort()
    const room = `p41-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const good = mintPeerToken(SECRET, { mode: 'off', sub: 'interviewer', role: 'agent', room, ttlMs: 60_000 })
    const authed = connectWithToken(room, url, good)
    await waitFor(() => authed.isAuthenticated)
    expect(authed.isAuthenticated).toBe(true)

    const wrongRoom = mintPeerToken(SECRET, { mode: 'off', sub: 'interviewer', role: 'agent', room: `${room}-elsewhere`, ttlMs: 60_000 })
    const deniedScope = connectWithToken(room, url, wrongRoom)
    let scopeFailed = false
    deniedScope.on('authenticationFailed', () => { scopeFailed = true })
    await waitFor(() => scopeFailed)
    expect(deniedScope.isAuthenticated).toBe(false)

    const expired = mintPeerToken(SECRET, { mode: 'off', sub: 'interviewer', role: 'agent', room, ttlMs: 1, now: Date.now() - 10_000 })
    const deniedExpiry = connectWithToken(room, url, expired)
    let expiryFailed = false
    deniedExpiry.on('authenticationFailed', () => { expiryFailed = true })
    await waitFor(() => expiryFailed)
    expect(deniedExpiry.isAuthenticated).toBe(false)
  })
})

describe('P4.2 role-aware ingress authZ (contract-1 AuthZ at the seam)', () => {
  const SECRET = 'authz-trust-root'

  it("a write-capable peer's content propagates to another peer", async () => {
    const port = await freePort()
    const room = `p42w-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const writerTok = mintPeerToken(SECRET, { mode: 'off', sub: 'agent-w', role: 'agent', room, ttlMs: 60_000, caps: [CAP_WRITE] })
    const readerTok = mintPeerToken(SECRET, { mode: 'off', sub: 'agent-r', role: 'agent', room, ttlMs: 60_000, caps: [CAP_WRITE] })
    const writer = connectWithToken(room, url, writerTok)
    const reader = connectWithToken(room, url, readerTok)
    await waitFor(() => writer.isAuthenticated && reader.isAuthenticated)

    appendBlock(writer.document, 'paragraph', 'edit from a write-capable agent')
    await waitFor(() => blockViews(reader.document).some((v) => v.text === 'edit from a write-capable agent'))
    expect(blockViews(reader.document).map((v) => v.text)).toContain('edit from a write-capable agent')
  })

  it("a no-write peer authenticates and reads, but its content update is refused (4400) and never persisted", async () => {
    const port = await freePort()
    const room = `p42ro-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const roTok = mintPeerToken(SECRET, { mode: 'off', sub: 'observer', role: 'agent', room, ttlMs: 60_000, caps: [] })
    const seen: { code: number; reason: string }[] = []
    const live: { ws: WebSocket | null } = { ws: null }
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: recordingPolyfill(seen, live), minDelay: 50, maxDelay: 200 })
    sockets.push(socket)
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: createDoc(), token: roTok, preserveConnection: false })
    providers.push(provider)

    // Authenticates AND completes the initial sync, then stays connected with ZERO closes — a read-only
    // peer observes fine. The empty handshake syncStep2 is a no-op write; a regression that refused it
    // (dropping the mutatesState exception) would loop-reconnect, so a settle window with no 4400 is
    // what makes this non-vacuous (synced alone races ahead of the first close being recorded).
    await waitFor(() => provider.isAuthenticated)
    await waitFor(() => provider.synced)
    await new Promise((r) => setTimeout(r, 250))
    expect(seen.filter((c) => c.code === 4400)).toEqual([])

    // A genuine content update from the same no-write peer is refused at ingress, before persist.
    const src = createDoc()
    appendBlock(src, 'paragraph', 'sneaky write from a read-only peer')
    const contentUpdate = Y.encodeStateAsUpdate(src)
    live.ws!.send(syncUpdateFrame(room, contentUpdate))

    await waitFor(() => seen.some((c) => c.code === 4400))
    expect(seen.find((c) => c.code === 4400)!.reason).toContain('write capability')
    expect(await maxRowBytes(room)).toBeLessThan(contentUpdate.byteLength)
  })

  it("a no-write peer's content write framed as syncStep2 is refused too (not just messageYjsUpdate)", async () => {
    const port = await freePort()
    const room = `p42s2-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const roTok = mintPeerToken(SECRET, { mode: 'off', sub: 'observer', role: 'agent', room, ttlMs: 60_000, caps: [] })
    const seen: { code: number; reason: string }[] = []
    const live: { ws: WebSocket | null } = { ws: null }
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: recordingPolyfill(seen, live), minDelay: 50, maxDelay: 200 })
    sockets.push(socket)
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: createDoc(), token: roTok, preserveConnection: false })
    providers.push(provider)
    await waitFor(() => provider.isAuthenticated)
    await waitFor(() => provider.synced)

    const src = createDoc()
    appendBlock(src, 'paragraph', 'sneaky syncStep2 write from a read-only peer')
    live.ws!.send(syncUpdateFrame(room, Y.encodeStateAsUpdate(src), messageYjsSyncStep2))

    await waitFor(() => seen.some((c) => c.code === 4400))
    expect(seen.find((c) => c.code === 4400)!.reason).toContain('write capability')
  })
})
