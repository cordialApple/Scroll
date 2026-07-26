import 'fake-indexeddb/auto'
import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_PROPOSE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import { encodeProposal, parseProposalResult } from '../../server/db/proposeCommit'
import { createDoc, appendBlock, blockViews } from './model'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'
const SECRET = 'propose-trust-root'

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

// A ws subclass recording every close it sees — used to prove op-grain: a refused proposal must NOT
// close the socket (that would be the connection-grain 4400 path P4.3 replaces).
function recordingPolyfill(seen: { code: number; reason: string }[]) {
  return class RecordingSocket extends WebSocket {
    constructor(url: string) {
      super(url)
      this.addEventListener('close', (ev: { code: number; reason: string }) => {
        seen.push({ code: ev.code, reason: ev.reason })
      })
    }
  } as unknown as typeof WebSocket
}

// Encode a proposal that adds one block, built from a SEPARATE source doc — the proposer never applies
// it to its own doc (that is the whole point: a refusal costs nothing, a commit arrives back as a
// normal remote update).
function proposalAddingBlock(id: string, text: string): { payload: string; bytes: Uint8Array } {
  const src = createDoc()
  appendBlock(src, 'paragraph', text)
  const bytes = Y.encodeStateAsUpdate(src)
  return { payload: encodeProposal(id, bytes), bytes }
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

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy()
  for (const s of sockets.splice(0)) s.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

function connect(room: string, url: string, token: string, WebSocketPolyfill: typeof WebSocket = WebSocket): HocuspocusProvider {
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill, minDelay: 50, maxDelay: 200 })
  sockets.push(socket)
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: createDoc(), token, preserveConnection: false })
  providers.push(provider)
  return provider
}

function onResult(provider: HocuspocusProvider, sink: ReturnType<typeof parseProposalResult>[]): void {
  provider.on('stateless', ({ payload }: { payload: string }) => {
    const r = parseProposalResult(payload)
    if (r) sink.push(r)
  })
}

describe('P4.3 propose/commit over the wire (contract-1 op-grain capability, closes F-04)', () => {
  it('a propose-capable peer commits: it arrives back like a remote update, a reader converges, it is persisted', async () => {
    const port = await freePort()
    const room = `pc-commit-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const proposerTok = mintPeerToken(SECRET, { mode: 'off', sub: 'agent-p', role: 'agent', room, ttlMs: 60_000, caps: [CAP_PROPOSE] })
    const readerTok = mintPeerToken(SECRET, { mode: 'off', sub: 'agent-r', role: 'agent', room, ttlMs: 60_000, caps: [] })
    const proposer = connect(room, url, proposerTok)
    const reader = connect(room, url, readerTok)
    await waitFor(() => proposer.isAuthenticated && reader.isAuthenticated)
    await waitFor(() => proposer.synced && reader.synced)

    const results: ReturnType<typeof parseProposalResult>[] = []
    onResult(proposer, results)
    const { payload } = proposalAddingBlock('c1', 'committed via propose/commit')
    proposer.sendStateless(payload)

    await waitFor(() => results.some((r) => r?.id === 'c1'))
    expect(results.find((r) => r?.id === 'c1')).toEqual({ t: 'scroll/propose-result', id: 'c1', ok: true, reason: undefined })

    // Arrives back on the proposer's OWN doc (it never self-applied) and converges on the reader.
    await waitFor(() => blockViews(proposer.document).some((v) => v.text === 'committed via propose/commit'))
    await waitFor(() => blockViews(reader.document).some((v) => v.text === 'committed via propose/commit'))

    // Persist-before-apply: reconstruct from the durable store alone and find the committed content.
    await waitFor(async () => (await maxRowBytes(room)) > 0)
    const loaded = await createPostgresStore(pool).loadDocument(room)
    const replay = createDoc()
    if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
    for (const u of loaded.updates) Y.applyUpdate(replay, u)
    expect(blockViews(replay).map((v) => v.text)).toContain('committed via propose/commit')
  })

  it('a guard refusal is op-grain: reason returned, nothing applied or persisted, connection stays up', async () => {
    const port = await freePort()
    const room = `pc-refuse-${port}`
    server = await startScrollServer({
      port,
      databaseUrl: DATABASE_URL,
      authenticate: createPeerAuthenticator(SECRET),
      proposalGuard: () => ({ ok: false, reason: 'guard: target inside a live camera band' }),
    })
    const url = `ws://127.0.0.1:${port}`

    const closes: { code: number; reason: string }[] = []
    const proposerTok = mintPeerToken(SECRET, { mode: 'off', sub: 'agent-p', role: 'agent', room, ttlMs: 60_000, caps: [CAP_PROPOSE] })
    const proposer = connect(room, url, proposerTok, recordingPolyfill(closes))
    await waitFor(() => proposer.isAuthenticated && proposer.synced)

    const results: ReturnType<typeof parseProposalResult>[] = []
    onResult(proposer, results)
    const { payload, bytes } = proposalAddingBlock('r1', 'should never land')
    proposer.sendStateless(payload)

    await waitFor(() => results.some((r) => r?.id === 'r1'))
    const r = results.find((x) => x?.id === 'r1')!
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('camera band')

    // Op-grain: the socket never closed and the peer is still connected — no 4400 teardown.
    await new Promise((res) => setTimeout(res, 250))
    expect(closes).toEqual([])
    expect(proposer.isAuthenticated).toBe(true)

    // Nothing applied locally (never self-applied); the proposed content never became a durable row
    // (the widest persisted update stays under the proposal's size — only tiny sync handshakes persist).
    expect(blockViews(proposer.document).some((v) => v.text === 'should never land')).toBe(false)
    expect(await maxRowBytes(room)).toBeLessThan(bytes.byteLength)
  })

  it('a peer lacking CAP_PROPOSE is refused op-grain (authZ at the seam, no teardown)', async () => {
    const port = await freePort()
    const room = `pc-nocap-${port}`
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`

    const closes: { code: number; reason: string }[] = []
    const noCapTok = mintPeerToken(SECRET, { mode: 'off', sub: 'observer', role: 'agent', room, ttlMs: 60_000, caps: [] })
    const observer = connect(room, url, noCapTok, recordingPolyfill(closes))
    await waitFor(() => observer.isAuthenticated && observer.synced)

    const results: ReturnType<typeof parseProposalResult>[] = []
    onResult(observer, results)
    const { payload, bytes } = proposalAddingBlock('n1', 'observer tries to write')
    observer.sendStateless(payload)

    await waitFor(() => results.some((r) => r?.id === 'n1'))
    expect(results.find((r) => r?.id === 'n1')!.reason).toContain('propose capability')

    await new Promise((res) => setTimeout(res, 250))
    expect(closes).toEqual([])
    expect(observer.isAuthenticated).toBe(true)
    expect(await maxRowBytes(room)).toBeLessThan(bytes.byteLength)
  })
})
