import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_PROPOSE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import { appendBlock, blockViews, createDoc } from '../doc/model'
import { insertAbove } from '../dev/synthetic'
import {
  computeLayout,
  deriveAnchor,
  type Anchor,
  type HeightModel,
  type Window,
} from '../layout/layout'
import { createHeadlessPeer, type HeadlessPeer } from './headlessPeer'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'
const SECRET = 'peer-milestone-trust-root'

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

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

// Deterministic per-block "true" height (measured); a WRONG estimate stands in for every unmeasured block —
// the interviewer's above-camera inserts are never measured, so the anchoring must survive estimate-only.
function trueHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return 50 + (h % 71)
}
const WRONG_ESTIMATE = () => 30

function measuredWindow(order: string[], w: Window): HeightModel {
  const m = new Map<string, number>()
  for (let i = Math.max(0, w.start); i < Math.min(order.length, w.end); i++) m.set(order[i], trueHeight(order[i]))
  return { measured: m, estimate: WRONG_ESTIMATE }
}

const pool = new Pool({ connectionString: DATABASE_URL })
const peers: HeadlessPeer[] = []
let server: Hocuspocus | null = null

// Read the room back from Postgres (snapshot + replayed update-log) to prove a commit is durable, not just
// broadcast — the "end-to-end over a real server + Postgres" half of the milestone.
async function storeText(room: string): Promise<string[]> {
  const loaded = await createPostgresStore(pool).loadDocument(room)
  const replay = createDoc()
  if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(replay, u)
  return blockViews(replay).map((v) => v.text)
}

function tok(room: string, sub: string): string {
  return mintPeerToken(SECRET, { mode: 'off', sub, role: 'agent', room, ttlMs: 60_000, caps: [CAP_PROPOSE] })
}

function peer(room: string, url: string, sub: string): HeadlessPeer {
  const p = createHeadlessPeer({ room, url, token: tok(room, sub), WebSocketPolyfill: WebSocket, minDelayMs: 50, maxDelayMs: 200 })
  peers.push(p)
  return p
}

afterEach(async () => {
  for (const p of peers.splice(0)) p.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

afterAll(async () => {
  await pool.end()
})

// P4.5 — the P4 milestone: an interviewer peer observes a live Scroll session AND writes back under
// propose/commit, while the human's relative-anchored viewport does not jump. Composes the peer seam
// (propose/commit over the wire, P4.3/P4.4) with the P0/P3 anchoring promise, end-to-end over a real
// server + Postgres. The interviewer is a headless peer standing in for STARfolio's external adapter;
// the protocol stays Scroll-owned and consumer-blind.
describe('P4.5 milestone: interviewer peer reads a live session and writes above the human, viewport holds', () => {
  it('a committed above-camera insert from the interviewer leaves the human camera content invariant', async () => {
    const N = 40
    const CAM = 20
    const ABOVE = 6
    const INSERTED = 8

    const port = await freePort()
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`
    const room = `p4.5-${port}`

    const human = peer(room, url, 'human')
    const interviewer = peer(room, url, 'interviewer')
    await Promise.all([human.whenReady, interviewer.whenReady])

    // The human authors the session. Even a person writes through propose/commit — the seam is uniform.
    const seed = await human.propose((fork) => {
      for (let i = 0; i < N; i++) appendBlock(fork, 'paragraph', `human line ${i}`)
    })
    expect(seed.committed).toBe(true)
    await waitFor(() => human.snapshot().length === N)

    // READ half: the interviewer observes the live session as a peer — the commit reaches it via sync.
    await waitFor(() => interviewer.snapshot().length === N)
    expect(interviewer.snapshot().map((v) => v.text)).toContain(`human line ${CAM}`)

    // The human's camera: a {blockId, offset} on a mid-document block, plus the anchored viewport math.
    // The HeightModel measures only the rendered window (camera ± neighbors) and is keyed by blockId, so it
    // FOLLOWS that content across the insert — the interviewer's above-camera blocks are never measured and
    // fall to the estimate, which is exactly the "variable-height content above, estimates only" condition.
    const order0 = human.snapshot().map((v) => v.id)
    const cameraId = order0[CAM]
    const window0: Window = { start: CAM - 5, end: CAM + 6 }
    const anchor: Anchor = { blockId: cameraId, offset: 17 }
    const hm = measuredWindow(order0, window0)

    const scrollTop0 = computeLayout(order0, hm, window0, anchor).scrollTop
    expect(deriveAnchor(scrollTop0, order0, hm)).toEqual(anchor)

    // The human watches the interviewer's write land live (proves it is one shared session, not a snapshot).
    let humanSawInsert = false
    const off = human.observeText((views) => {
      if (views.length > order0.length) humanSawInsert = true
    })

    // WRITE half: the interviewer commits content ABOVE the human's viewport — never self-applied, it arrives
    // back through sync like any remote update (fork-and-diff inside propose()).
    const acted = await interviewer.propose((fork) => insertAbove(fork, order0[ABOVE], INSERTED, 3))
    expect(acted.committed).toBe(true)
    await waitFor(() => human.snapshot().length === N + INSERTED)
    off()
    expect(humanSawInsert).toBe(true)

    // The anchoring proof: re-derive the human viewport over the grown document. The camera block moved
    // down INSERTED positions, but its {blockId, offset} still resolves to the same content, and scrollTop
    // grew by exactly the above-inserted (estimated) height — the screen did NOT jump.
    const order1 = human.snapshot().map((v) => v.id)
    const cam1 = order1.indexOf(cameraId)
    expect(cam1).toBe(CAM + INSERTED)
    const window1: Window = { start: cam1 - 5, end: cam1 + 6 }
    // The whole rendered window shifted down by INSERTED but shows the same content top-to-bottom — the
    // inserted blocks are above it, so the virtualization window is content-stable, not just the anchor.
    expect(order1[window1.start]).toBe(order0[window0.start])

    const scrollTop1 = computeLayout(order1, hm, window1, anchor).scrollTop
    expect(deriveAnchor(scrollTop1, order1, hm)).toEqual(anchor)
    expect(scrollTop1).toBe(scrollTop0 + INSERTED * 30)

    // Without re-anchoring (holding the OLD scrollTop against the new order) the camera would land on a
    // block INSERTED positions early — i.e. the naive editor's screen jumps. This is what P4.5 prevents.
    expect(deriveAnchor(scrollTop0, order1, hm)).not.toEqual(anchor)

    // Durability: the interviewer's commit is in Postgres (snapshot + update-log), not merely broadcast.
    const persisted = await storeText(room)
    expect(persisted.length).toBe(N + INSERTED)
    expect(persisted).toContain(`human line ${CAM}`)
  })
})
