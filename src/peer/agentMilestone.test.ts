import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_PROPOSE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import { AUTHOR_AGENT, appendBlock, blockViews, createDoc, setBlockText, type BlockView } from '../doc/model'
import { runAttentionAgent, type AgentRunner } from '../agent/attentionAgent'
import { createHeadlessPeer, type HeadlessPeer } from './headlessPeer'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'
const SECRET = 'agent-milestone-trust-root'

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

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const pool = new Pool({ connectionString: DATABASE_URL })
const peers: HeadlessPeer[] = []
const runners: AgentRunner[] = []
let server: Hocuspocus | null = null

function tok(room: string, sub: string): string {
  return mintPeerToken(SECRET, { mode: 'off', sub, role: 'agent', room, ttlMs: 60_000, caps: [CAP_PROPOSE] })
}

function peer(room: string, url: string, sub: string): HeadlessPeer {
  const p = createHeadlessPeer({ room, url, token: tok(room, sub), WebSocketPolyfill: WebSocket, minDelayMs: 50, maxDelayMs: 200 })
  peers.push(p)
  return p
}

// Read the room back from Postgres (snapshot + replayed update-log) to prove a commit is durable, not just
// broadcast.
async function storeViews(room: string): Promise<BlockView[]> {
  const loaded = await createPostgresStore(pool).loadDocument(room)
  const replay = createDoc()
  if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(replay, u)
  return blockViews(replay)
}

afterEach(async () => {
  for (const r of runners.splice(0)) r.stop()
  for (const p of peers.splice(0)) p.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

afterAll(async () => {
  await pool.end()
})

// P6 milestone: the native attention-anchored agent reorganizes COLD regions of a live shared doc while a
// human reader's camera is published, and the spatial guard ENFORCES end-to-end over a real server + Postgres.
// First test with a live proposer AND a live camera — de-latents everything P6.2-6.5 built (before this, no
// test published a camera, so the guard guarded nothing).
//   BELT: the agent never PROPOSES a block inside the human's band. Proven by driving it through the WHOLE cold
//   set — a belt blind to the reader would, to commit every cold block, first propose band blocks along the way
//   (caught in `proposed`). Asserting only over `committed` is blind here: the suspenders refuses band writes,
//   so a broken belt's band proposals never land and committed-are-cold stays true regardless of the belt.
//   SUSPENDERS: a band write is refused op-grain by the authority — both a statically in-band write and the
//   check-then-act race (a block cold at read-time that a reader enters before the commit lands).
//   Durable: the human's band survives byte-for-byte in Postgres; a cold agent edit lands.
describe('P6.6 milestone: agent reorganizes cold regions, the spatial guard enforces live', () => {
  it('agent never proposes into the band; band writes are refused; the band is invariant and durable', async () => {
    const N = 30
    const CAM = 15
    // Default band around index 15 = [15-4, 15+(4-1)+4] = [11, 22]. The agent and the authority share the
    // same spatialGuard defaults, so their bands coincide — belt and suspenders agree on what is cold.
    const BAND_LO = 11
    const BAND_HI = 22

    const port = await freePort()
    server = await startScrollServer({ port, databaseUrl: DATABASE_URL, authenticate: createPeerAuthenticator(SECRET) })
    const url = `ws://127.0.0.1:${port}`
    const room = `p6.6-${port}`

    const human = peer(room, url, 'human')
    const agent = peer(room, url, 'agent')
    await Promise.all([human.whenReady, agent.whenReady])

    // The human authors the session; a deterministic per-block sentinel lets us detect any change.
    const seed = await human.propose((fork) => {
      for (let i = 0; i < N; i++) appendBlock(fork, 'paragraph', `L${i} original`)
    })
    expect(seed.committed).toBe(true)
    await waitFor(() => agent.snapshot().length === N)

    const order = human.snapshot().map((v) => v.id)
    const cameraId = order[CAM]
    const bandIds = new Set(order.slice(BAND_LO, BAND_HI + 1))
    const coldCount = N - bandIds.size // 18

    // The human publishes a camera — THIS is what arms the guard (a room with no cameras guards nothing).
    human.lookAt({ blockId: cameraId, offset: 0 })
    // The agent must SEE the human camera via awareness before its observer can treat that band as guarded.
    await waitFor(() => agent.cameras().some((c) => c.raw.blockId === cameraId))

    // Drive the agent with a deterministic marker actor (append a tag once). Collect PROPOSED and COMMITTED.
    const proposed: string[] = []
    const committed: string[] = []
    runners.push(
      runAttentionAgent(agent, {
        intervalMs: 15,
        actor: (fork, target) => {
          const v = blockViews(fork).find((b) => b.id === target)
          if (v && !v.text.includes('[agent]')) setBlockText(fork, target, `${v.text} [agent]`)
        },
        onTick: (r) => {
          if (r.proposed && r.targetId) proposed.push(r.targetId)
          if (r.committed && r.targetId) committed.push(r.targetId)
        },
      }),
    )
    // Drive through the WHOLE cold set (the LRU visits each cold block once before repeating). A belt blind to
    // the reader would, on its way to committing all 18 cold blocks, PROPOSE band blocks 11-22 (refused) — that
    // is exactly what the belt assertion below catches. Waiting for only 5 commits never rotated past the cold
    // blocks that precede the band, so a disabled belt was behaviorally invisible.
    await waitFor(() => new Set(committed).size >= coldCount)
    runners.splice(0).forEach((r) => r.stop())

    // BELT: the agent NEVER proposed a block inside the human's band (not merely "never committed one").
    for (const id of proposed) expect(bandIds.has(id)).toBe(false)
    // SUSPENDERS backstop: nothing in the band ever committed either.
    for (const id of committed) expect(bandIds.has(id)).toBe(false)

    // The human's whole band is byte-for-byte pristine after all that agent activity above and below it.
    for (const v of human.snapshot()) {
      if (bandIds.has(v.id)) expect(v.text).toBe(`L${order.indexOf(v.id)} original`)
    }

    // SUSPENDERS, static: a proposal straight into the camera block — bypassing the agent's cold-selection —
    // is refused op-grain by the authority. The guard, not the agent's manners, is the enforcement.
    const direct = await agent.propose((fork) => setBlockText(fork, cameraId, 'SHOULD BE REFUSED'))
    expect(direct.committed).toBe(false)

    // Durability: read the room back from Postgres. Every band block survived byte-for-byte; a COLD agent edit
    // landed (an `[agent]` tag on a non-band block); and provenance persisted with it — a COLD block carries
    // author='agent', while the human's band was never written so it carries no authorship at all.
    const persistedViews = await storeViews(room)
    const persisted = persistedViews.map((v) => v.text)
    for (let i = BAND_LO; i <= BAND_HI; i++) expect(persisted[i]).toBe(`L${i} original`)
    expect(order.some((id, i) => !bandIds.has(id) && persisted[i].includes('[agent]'))).toBe(true)
    expect(persistedViews.some((v) => !bandIds.has(v.id) && v.author === AUTHOR_AGENT)).toBe(true)
    for (let i = BAND_LO; i <= BAND_HI; i++) expect(persistedViews[i].author).toBeUndefined()

    // SUSPENDERS, the check-then-act race the commit-time guard exists for: build a diff against a block that
    // is COLD right now, THEN a reader enters it, THEN submit the pre-built diff. The authority re-derives the
    // guarded set from CURRENT awareness at commit, so it refuses — enforcement never trusts the proposer's
    // read-time view. Strictly stronger than the static write above (that block was already in-band at build).
    const raceId = order[0]
    const fork = createDoc()
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(agent.provider.document))
    const before = Y.encodeStateVector(fork)
    setBlockText(fork, raceId, 'raced in')
    const raceUpdate = Y.encodeStateAsUpdate(fork, before)
    human.lookAt({ blockId: raceId, offset: 0 }) // the reader moves onto the block AFTER the diff was built
    await waitFor(() => agent.cameras().some((c) => c.raw.blockId === raceId))
    const raced = await agent.proposeUpdate(raceUpdate)
    expect(raced.committed).toBe(false)
    // 30s: this drives the agent through the WHOLE cold set over a real server+ws+Postgres. A future belt
    // regression makes `waitFor(committed>=coldCount)` slower (band proposals refused, wasted ticks); the
    // headroom lets the belt ASSERTION fire cleanly instead of an opaque vitest-timeout kill.
  }, 30_000)
})
