import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createDoc, appendBlock, blockViews } from '../doc/model'
import type { HeadlessPeer, ProposalOutcome } from '../peer/headlessPeer'
import type { RemoteCamera } from '../doc/awareness'
import { createAttentionAgent, normalizeWhitespaceActor } from './attentionAgent'

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

interface FakeOpts {
  cameras?: RemoteCamera[]
  awareness?: boolean
  respond?: () => ProposalOutcome
}
function fakePeer(doc: Y.Doc, opts: FakeOpts = {}): { peer: HeadlessPeer; proposeCount: () => number } {
  let count = 0
  const peer = {
    provider: { document: doc, awareness: (opts.awareness ?? true) ? {} : null },
    cameras: () => opts.cameras ?? [],
    // Sync arrow returning a resolved Promise — mirrors headlessPeer.propose exactly: mutate runs
    // synchronously, so a throwing actor throws SYNCHRONOUSLY (not as a rejection), which is what makes the
    // driver's finally-advances-the-LRU tooth exercise the real production failure mode.
    propose: (mutate: (fork: Y.Doc) => void) => {
      count++
      const fork = createDoc()
      Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
      mutate(fork)
      return Promise.resolve(opts.respond ? opts.respond() : { committed: true })
    },
  }
  return { peer: peer as unknown as HeadlessPeer, proposeCount: () => count }
}

describe('createAttentionAgent — the native attention-anchored driver (P6.5, #68)', () => {
  it('proposes a cold target — outside every live reader band — and hands that id to the actor', async () => {
    const { doc, ids } = makeDoc(30)
    const seen: string[] = []
    const { peer, proposeCount } = fakePeer(doc, { cameras: [remoteCam(1, ids[15])] })
    const agent = createAttentionAgent(peer, { actor: (_f, t) => void seen.push(t), now: () => 1000 })
    const r = await agent.tick()
    expect(r.proposed).toBe(true)
    expect(proposeCount()).toBe(1)
    const band = new Set(ids.slice(11, 23)) // index 15, default band [11, 22]
    expect(band.has(r.targetId!)).toBe(false)
    expect(seen).toEqual([r.targetId])
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
