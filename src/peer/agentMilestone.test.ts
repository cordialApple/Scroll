import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { startScrollServer } from '../../server/hocuspocus'
import { createPostgresStore } from '../../server/db/store'
import { CAP_PROPOSE, createPeerAuthenticator, mintPeerToken } from '../../server/auth/peerToken'
import { appendBlock, blockViews, createDoc, setBlockText } from '../doc/model'
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

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
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
async function storeText(room: string): Promise<string[]> {
  const loaded = await createPostgresStore(pool).loadDocument(room)
  const replay = createDoc()
  if (loaded.snapshot) Y.applyUpdate(replay, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(replay, u)
  return blockViews(replay).map((v) => v.text)
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
// This is the first test with a live proposer AND a live camera — it de-latents everything P6.2-6.5 built
// (before this, no test published a camera, so the guard guarded nothing). BELT: the agent commits only cold
// blocks. SUSPENDERS: a write straight into the human's band is refused by the authority regardless of the
// proposer's good behavior. Durable: the human's band content survives in Postgres, agent edits land.
describe('P6.6 milestone: agent reorganizes cold regions, the spatial guard enforces live', () => {
  it('agent commits ONLY cold blocks; a band write is refused; the human band is invariant and durable', async () => {
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

    // The human publishes a camera — THIS is what arms the guard (a room with no cameras guards nothing).
    human.lookAt({ blockId: cameraId, offset: 0 })
    // The agent must SEE the human camera via awareness before its observer can treat that band as guarded.
    await waitFor(() => agent.cameras().some((c) => c.raw.blockId === cameraId))

    // Drive the agent with a deterministic marker actor (append a tag once). Collect every committed target.
    const committed: string[] = []
    runners.push(
      runAttentionAgent(agent, {
        intervalMs: 15,
        actor: (fork, target) => {
          const v = blockViews(fork).find((b) => b.id === target)
          if (v && !v.text.includes('[agent]')) setBlockText(fork, target, `${v.text} [agent]`)
        },
        onTick: (r) => {
          if (r.committed && r.targetId) committed.push(r.targetId)
        },
      }),
    )
    // Let the agent work several DISTINCT cold blocks (the LRU rotates through them).
    await waitFor(() => new Set(committed).size >= 5)
    runners.splice(0).forEach((r) => r.stop())

    // BELT + SUSPENDERS, live: every committed target was COLD (outside the band). The authority is the
    // backstop — `committed` cannot contain a band block even if the agent's selection had raced awareness.
    for (const id of committed) expect(bandIds.has(id)).toBe(false)

    // The human's whole band is byte-for-byte pristine after all that agent activity above and below it.
    for (const v of human.snapshot()) {
      if (bandIds.has(v.id)) expect(v.text).toBe(`L${order.indexOf(v.id)} original`)
    }

    // SUSPENDERS, directly: a proposal straight into the camera block — bypassing the agent's cold-selection
    // — is refused op-grain by the authority. The guard, not the agent's manners, is the enforcement.
    const direct = await agent.propose((fork) => setBlockText(fork, cameraId, 'SHOULD BE REFUSED'))
    expect(direct.committed).toBe(false)

    // Durability: read the room back from Postgres. The camera block survived; at least one cold edit landed.
    const persisted = await storeText(room)
    expect(persisted[CAM]).toBe(`L${CAM} original`)
    expect(persisted.some((t) => t.includes('[agent]'))).toBe(true)
  })
})
