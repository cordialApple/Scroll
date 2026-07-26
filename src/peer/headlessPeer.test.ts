import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_PROPOSE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import type { ProposalGuard } from '../../server/db/proposeCommit'
import { appendBlock, blockViews, createDoc } from '../doc/model'
import { createHeadlessPeer, type HeadlessPeer } from './headlessPeer'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'
const SECRET = 'headless-peer-trust-root'

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

// A ws subclass recording every close — used to prove op-grain: a refused proposal must NOT close the
// socket (the connection-grain 4400 teardown P4.3 replaced).
function recordingPolyfill(seen: { code: number }[]) {
  return class RecordingSocket extends WebSocket {
    constructor(url: string) {
      super(url)
      this.addEventListener('close', (ev: { code: number }) => seen.push({ code: ev.code }))
    }
  } as unknown as typeof WebSocket
}

const pool = new Pool({ connectionString: DATABASE_URL })
afterAll(async () => {
  await pool.end()
})

async function storeText(room: string): Promise<string[]> {
  const loaded = await createPostgresStore(pool).loadDocument(room)
  const replay = createDoc()
  if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(replay, u)
  return blockViews(replay).map((v) => v.text)
}

const peers: HeadlessPeer[] = []
let server: Hocuspocus | null = null

function peer(room: string, url: string, token: string, WebSocketPolyfill: typeof WebSocket = WebSocket): HeadlessPeer {
  const p = createHeadlessPeer({ room, url, token, WebSocketPolyfill, minDelayMs: 50, maxDelayMs: 200, proposalTimeoutMs: 4000 })
  peers.push(p)
  return p
}

function tok(room: string, sub: string, caps: string[]): string {
  return mintPeerToken(SECRET, { mode: 'off', sub, role: 'agent', room, ttlMs: 60_000, caps })
}

async function boot(guard?: ProposalGuard): Promise<string> {
  const port = await freePort()
  server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET), proposalGuard: guard })
  return `ws://127.0.0.1:${port}`
}

afterEach(async () => {
  for (const p of peers.splice(0)) p.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

describe('P4.4 native headless-peer harness (first propose/commit consumer)', () => {
  it('a commit arrives back through sync (never self-applied), a reader converges, it is persisted', async () => {
    const room = `hp-commit-${await freePort()}`
    const url = await boot()
    const proposer = peer(room, url, tok(room, 'agent-p', [CAP_PROPOSE]))
    const reader = peer(room, url, tok(room, 'agent-r', []))
    await Promise.all([proposer.whenReady, reader.whenReady])

    expect(proposer.snapshot().some((v) => v.text === 'via harness')).toBe(false)
    const outcome = await proposer.propose((fork) => appendBlock(fork, 'paragraph', 'via harness'))
    expect(outcome).toEqual({ committed: true, reason: undefined })

    // Lands on the proposer's OWN doc only by arriving back over the wire, and converges on the reader.
    await waitFor(() => proposer.snapshot().some((v) => v.text === 'via harness'))
    await waitFor(() => reader.snapshot().some((v) => v.text === 'via harness'))
    expect(await storeText(room)).toContain('via harness')
  })

  it('a refused proposal is op-grain: the local doc is NEVER touched, nothing persists, the socket stays up', async () => {
    const room = `hp-refuse-${await freePort()}`
    const url = await boot(() => ({ ok: false, reason: 'guard: target inside a live camera band' }))
    const closes: { code: number }[] = []
    const proposer = peer(room, url, tok(room, 'agent-p', [CAP_PROPOSE]), recordingPolyfill(closes))
    await proposer.whenReady

    const outcome = await proposer.propose((fork) => appendBlock(fork, 'paragraph', 'should never land'))
    expect(outcome.committed).toBe(false)
    expect(outcome.reason).toContain('camera band')

    // THE never-self-apply proof: the peer authored the mutation on a fork and only proposed it, so its
    // own doc is empty even after the refusal. A self-applying peer would have forked here (F-04).
    await new Promise((res) => setTimeout(res, 200))
    expect(proposer.snapshot().some((v) => v.text === 'should never land')).toBe(false)
    expect(closes).toEqual([])
    expect(proposer.provider.isAuthenticated).toBe(true)
    expect(await storeText(room)).not.toContain('should never land')
  })

  it('results correlate by proposal id, not arrival order (a slow commit and a fast refuse do not swap)', async () => {
    const room = `hp-correlate-${await freePort()}`
    // Content-aware guard: refuse any proposal whose decoded content carries REJECT, commit the rest.
    const guard: ProposalGuard = (update, { document }) => {
      const probe = createDoc()
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(document))
      Y.applyUpdate(probe, update)
      const rejects = blockViews(probe).some((v) => v.text.includes('REJECT'))
      return rejects ? { ok: false, reason: 'guard: REJECT marker' } : { ok: true }
    }
    const url = await boot(guard)
    const proposer = peer(room, url, tok(room, 'agent-p', [CAP_PROPOSE]))
    await proposer.whenReady

    // The committed proposal is large, so its result waits on a Postgres append; the refused one returns
    // synchronously. Sent commit-first, its result therefore arrives AFTER the refuse — reversed order.
    // FIFO correlation would hand the first-arriving (refuse) result to the first-sent (commit) promise.
    const big = proposer.propose((fork) => appendBlock(fork, 'paragraph', 'alpha '.repeat(60_000)))
    const small = proposer.propose((fork) => appendBlock(fork, 'paragraph', 'REJECT beta'))
    const [bigOut, smallOut] = await Promise.all([big, small])

    expect(bigOut.committed).toBe(true)
    expect(smallOut.committed).toBe(false)
    expect(smallOut.reason).toContain('REJECT')
  })

  it('a peer observes committed text deltas and remote cameras', async () => {
    const room = `hp-observe-${await freePort()}`
    const url = await boot()
    const writer = peer(room, url, tok(room, 'agent-w', [CAP_PROPOSE]))
    const observer = peer(room, url, tok(room, 'agent-o', []))
    await Promise.all([writer.whenReady, observer.whenReady])

    const seen: string[][] = []
    observer.observeText((views) => seen.push(views.map((v) => v.text)))

    expect((await writer.propose((fork) => appendBlock(fork, 'paragraph', 'observed line'))).committed).toBe(true)
    await waitFor(() => seen.some((snap) => snap.includes('observed line')))

    // Awareness half: the writer looks at the new block, the observer reads that camera as a remote.
    const blockId = writer.snapshot()[0].id
    writer.lookAt({ blockId, offset: 0 })
    await waitFor(() => observer.cameras().some((c) => c.raw.blockId === blockId))
  })

  it('destroy settles every in-flight proposal and tears down the socket', async () => {
    // Point at a dead port: whenReady never resolves, so the proposal registers but is never sent.
    const dead = await freePort()
    const room = `hp-destroy-${dead}`
    const p = peer(room, `ws://127.0.0.1:${dead}`, tok(room, 'agent-d', [CAP_PROPOSE]))

    const inflight = p.proposeUpdate(Y.encodeStateAsUpdate(createDoc()))
    p.destroy()

    expect(await inflight).toEqual({ committed: false, reason: 'peer destroyed' })
    expect(p.provider.configuration.websocketProvider.shouldConnect).toBe(false)
  })
})
