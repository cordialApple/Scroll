import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { createDoc, appendBlock, blockViews } from '../doc/model'
import type { HeadlessPeer, ProposalOutcome } from '../peer/headlessPeer'
import type { RemoteCamera } from '../doc/awareness'
import { createAttentionAgent, normalizeWhitespaceActor, runAttentionAgent, type AgentRunner, type TickResult } from './attentionAgent'

function makeDoc(n: number): { doc: Y.Doc; ids: string[] } {
  const doc = createDoc()
  const ids = Array.from({ length: n }, (_, i) => appendBlock(doc, 'paragraph', `block ${i} text`))
  return { doc, ids }
}

const remoteCam = (clientId: number, blockId: string): RemoteCamera => ({
  clientId,
  raw: { blockId, offset: 0 },
  anchor: { blockId, offset: 0 },
})

const monotonic = () => {
  let n = 0
  return () => ++n
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Any runner a test starts is registered here and stopped in afterEach, so a thrown assertion (e.g. a waitFor
// timeout) can't leak a self-rescheduling timer into the rest of the process — the sibling agentMilestone.test
// does the same. Tests still call stop() explicitly where stop() itself is under test.
const activeRunners: AgentRunner[] = []
afterEach(() => {
  for (const r of activeRunners.splice(0)) r.stop()
})

interface FakeOpts {
  cameras?: RemoteCamera[]
  awareness?: boolean
  respond?: () => ProposalOutcome
  // When set, propose resolves after this delay (macrotask) instead of immediately — lets a test call stop()
  // WHILE a tick is awaiting propose, which is the only way to exercise the loop's post-await guards.
  deferMs?: number
  // Invoked with the forked doc AFTER the actor + driver mutate it, BEFORE the outcome resolves — lets a test
  // inspect exactly what the driver proposed (e.g. the provenance stamp) with no live server.
  onFork?: (fork: Y.Doc) => void
}
function fakePeer(doc: Y.Doc, opts: FakeOpts = {}): { peer: HeadlessPeer; proposeCount: () => number } {
  let count = 0
  const peer = {
    provider: { document: doc, awareness: (opts.awareness ?? true) ? {} : null },
    cameras: () => opts.cameras ?? [],
    // Sync arrow that runs mutate synchronously before returning its Promise — mirrors headlessPeer.propose
    // exactly, so a throwing actor throws SYNCHRONOUSLY (not as a rejection), exercising the real production
    // failure mode. deferMs only delays the RESOLUTION, never the synchronous mutate.
    propose: (mutate: (fork: Y.Doc) => void) => {
      count++
      const fork = createDoc()
      Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
      mutate(fork)
      opts.onFork?.(fork)
      const outcome = opts.respond ? opts.respond() : { committed: true }
      return opts.deferMs ? new Promise<ProposalOutcome>((r) => setTimeout(() => r(outcome), opts.deferMs)) : Promise.resolve(outcome)
    },
  }
  return { peer: peer as unknown as HeadlessPeer, proposeCount: () => count }
}

describe('createAttentionAgent — the native attention-anchored driver (P6.5, #68)', () => {
  it('proposes a cold target — outside every live reader band — and hands that id to the actor', async () => {
    const { doc, ids } = makeDoc(30)
    const seen: string[] = []
    // Camera at index 0 (band [0, 0+(4-1)+4] = [0, 7]). Deliberate: if resolveCameras mis-resolved and the
    // agent saw NO camera, coldBlocks would return the whole doc and selectNext would pick ids[0] (cold[0]) —
    // which is INSIDE this band, failing the assertion. A mid-doc camera would let that bug pass (ids[0] is
    // outside a mid-doc band), so this placement gives the "target is cold" assertion teeth.
    const { peer, proposeCount } = fakePeer(doc, { cameras: [remoteCam(1, ids[0])] })
    const agent = createAttentionAgent(peer, { actor: (_f, t) => void seen.push(t), now: () => 1000 })
    const r = await agent.tick()
    expect(r.proposed).toBe(true)
    expect(proposeCount()).toBe(1)
    const band = new Set(ids.slice(0, 8))
    expect(band.has(r.targetId!)).toBe(false)
    expect(seen).toEqual([r.targetId])
  })

  it('stamps agent authorship on its target block — driver-level, regardless of the actor', async () => {
    const { doc, ids } = makeDoc(30)
    let authored: string[] = []
    const { peer } = fakePeer(doc, {
      cameras: [remoteCam(1, ids[15])],
      onFork: (fork) => {
        authored = blockViews(fork).filter((v) => v.author === 'agent').map((v) => v.id)
      },
    })
    // A no-op actor: only the DRIVER's stamp can mark a block, so exactly the target ends up 'agent'.
    const agent = createAttentionAgent(peer, { actor: () => {}, now: () => 1000 })
    const r = await agent.tick()
    expect(r.proposed).toBe(true)
    expect(authored).toEqual([r.targetId])
  })

  it('fails closed when the provider has no awareness: idles without proposing', async () => {
    const { doc } = makeDoc(10)
    const { peer, proposeCount } = fakePeer(doc, { awareness: false })
    const agent = createAttentionAgent(peer, { now: () => 0 })
    expect(await agent.tick()).toEqual({ targetId: null, proposed: false })
    expect(proposeCount()).toBe(0)
  })

  it('surfaces a commit refusal (reader moved into the target at commit) without throwing', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])], respond: () => ({ committed: false, reason: 'guarded' }) })
    const agent = createAttentionAgent(peer, { now: () => 0 })
    const r = await agent.tick()
    expect(r).toMatchObject({ proposed: true, committed: false, reason: 'guarded' })
  })

  it('advances the LRU on any attempt: a refused target is not re-picked next tick', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])], respond: () => ({ committed: false, reason: 'guarded' }) })
    const agent = createAttentionAgent(peer, { now: monotonic() })
    const r1 = await agent.tick()
    const r2 = await agent.tick()
    expect(r1.targetId).not.toBeNull()
    expect(r2.targetId).not.toBe(r1.targetId)
  })

  // A throwing actor (a bug in a P6.6+ injected reorganization) must not wedge the loop: propose runs the
  // actor synchronously, so without the driver's finally the LRU would never advance and this same target
  // would be re-picked and re-thrown every tick, starving the rest. tick() resolves to an error result, and
  // the next tick moves on.
  it('does not wedge when the actor throws: surfaces an error result and still rotates the LRU', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])] })
    const agent = createAttentionAgent(peer, { actor: () => { throw new Error('boom') }, now: monotonic() })
    const r1 = await agent.tick()
    expect(r1).toMatchObject({ proposed: false, committed: false })
    expect(r1.reason).toContain('boom')
    const r2 = await agent.tick()
    expect(r2.targetId).not.toBeNull()
    expect(r2.targetId).not.toBe(r1.targetId)
  })

  // End to end through the driver: an unplaceable reader (raw block hard-deleted, no redirect, anchor
  // laundered to a live block) must resolve NON-launderingly and fail closed — resolveCameras keeps 'ghost',
  // guardedBlocks guards the whole doc, the driver idles. Guards the resolveCameras→observe wiring at the
  // call site, which the split cameraResolve/observer unit tests never compose.
  it('fails closed on an unplaceable reader (block gone, no redirect): idles without proposing', async () => {
    const { doc, ids } = makeDoc(30)
    const laundered: RemoteCamera = { clientId: 1, raw: { blockId: 'ghost', offset: 0 }, anchor: { blockId: ids[0], offset: 0 } }
    const { peer, proposeCount } = fakePeer(doc, { cameras: [laundered] })
    const agent = createAttentionAgent(peer, { now: () => 0 })
    expect(await agent.tick()).toEqual({ targetId: null, proposed: false })
    expect(proposeCount()).toBe(0)
  })

  // Single-flight (CF-1): a second tick() racing an in-flight one — before its propose await settles — must
  // get an idle no-op, not run concurrently and last-write-wins clobber the ObserverState fold. `ticking` is
  // set true before runTick's await suspends, so the racer short-circuits before it ever reaches propose.
  it('is single-flight: a tick racing an in-flight tick idles instead of clobbering state', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer, proposeCount } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])] })
    const agent = createAttentionAgent(peer, { now: monotonic() })
    const [r1, r2] = await Promise.all([agent.tick(), agent.tick()])
    expect(r1.proposed).toBe(true)
    expect(r2).toEqual({ targetId: null, proposed: false, reason: 'tick in flight' })
    expect(proposeCount()).toBe(1)
  })
})

describe('runAttentionAgent — the driving loop + lifecycle (P6.6, #70)', () => {
  it('loops ticks and stop() halts further onTick', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])] })
    const results: TickResult[] = []
    const runner = runAttentionAgent(peer, { intervalMs: 5, now: monotonic(), onTick: (r) => results.push(r) })
    activeRunners.push(runner)
    await waitFor(() => results.length >= 3)
    runner.stop()
    const atStop = results.length
    await new Promise((r) => setTimeout(r, 40))
    expect(results.length).toBe(atStop)
    expect(results.some((r) => r.proposed)).toBe(true)
  })

  // The reschedule guard has teeth only when stop() lands WHILE a tick is awaiting propose (deferMs) — with an
  // instant propose no runOnce ever spans the stop() macrotask, so clearTimeout alone would end the loop and
  // a dropped `if (running)` reschedule guard would go undetected. proposeCount stability distinguishes "loop
  // halted" from "loop still rescheduling with onTick merely gated"; results-empty covers the onTick guard.
  it('stop() during an in-flight tick reschedules nothing and emits nothing (both post-await guards)', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer, proposeCount } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])], deferMs: 25 })
    const results: TickResult[] = []
    const runner = runAttentionAgent(peer, { intervalMs: 0, now: monotonic(), onTick: (r) => results.push(r) })
    activeRunners.push(runner)
    await waitFor(() => proposeCount() >= 1)
    runner.stop()
    const atStop = proposeCount()
    await new Promise((r) => setTimeout(r, 70))
    expect(results.length).toBe(0)
    expect(proposeCount()).toBe(atStop)
  })

  it('stop() before the first scheduled tick fires does no work', async () => {
    const { doc, ids } = makeDoc(30)
    const { peer, proposeCount } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])] })
    const results: TickResult[] = []
    const runner = runAttentionAgent(peer, { intervalMs: 5, now: monotonic(), onTick: (r) => results.push(r) })
    activeRunners.push(runner)
    runner.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(results.length).toBe(0)
    expect(proposeCount()).toBe(0)
  })
})

describe('normalizeWhitespaceActor — the safe default reorganization', () => {
  it('collapses space runs and trims trailing whitespace, idempotently', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'foo   bar  \nbaz   ')
    const text = () => blockViews(doc).find((v) => v.id === id)!.text
    normalizeWhitespaceActor(doc, id)
    expect(text()).toBe('foo bar\nbaz')
    normalizeWhitespaceActor(doc, id)
    expect(text()).toBe('foo bar\nbaz')
  })

  it('is a no-op for a target that is not in the doc', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'hello')
    expect(() => normalizeWhitespaceActor(doc, 'nope')).not.toThrow()
  })
})
