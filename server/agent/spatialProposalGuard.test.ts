import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { describe, it, expect } from 'vitest'
import { CAP_PROPOSE, type PeerIdentity } from '../auth/peerToken'
import { evaluateProposal, type ProposalGuard } from '../db/proposeCommit'
import { createSpatialProposalGuard } from './spatialProposalGuard'
import { appendBlock, createDoc, insertBlockAfter, mergeIntoPrevious, setBlockText } from '../../src/doc/model'

const MAX = 8 * 1024 * 1024
const proposer: PeerIdentity = { sub: 'agent-1', role: 'agent', caps: [CAP_PROPOSE], room: 'r' }

function seed(n: number): { doc: Y.Doc; ids: string[] } {
  const doc = createDoc()
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(appendBlock(doc, 'paragraph', `line ${i}`))
  return { doc, ids }
}

// A proposal update = the diff of a fork mutation vs the current doc (mirrors headlessPeer.propose).
function proposal(doc: Y.Doc, mutate: (fork: Y.Doc) => void): Uint8Array {
  const fork = createDoc()
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
  const before = Y.encodeStateVector(fork)
  mutate(fork)
  return Y.encodeStateAsUpdate(fork, before)
}

// The room authority's awareness with one remote peer camera injected at `blockId`.
function awarenessWithCamera(doc: Y.Doc, blockId: string, offset = 0): Awareness {
  const authority = emptyAwareness(doc)
  const peer = new Awareness(new Y.Doc())
  peer.setLocalStateField('camera', { blockId, offset })
  applyAwarenessUpdate(authority, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return authority
}

function emptyAwareness(doc: Y.Doc): Awareness {
  const a = new Awareness(doc)
  a.setLocalState(null)
  return a
}

function decide(doc: Y.Doc, update: Uint8Array, awareness: Awareness | null, guard: ProposalGuard, now = 0) {
  return evaluateProposal({ peer: proposer, update, document: doc, guard, maxUpdateBytes: MAX, awareness, now })
}

describe('createSpatialProposalGuard — commit-time spatial enforcement (P6.3)', () => {
  it('commits a proposal editing a cold block far from every camera', () => {
    const { doc, ids } = seed(40)
    const awareness = awarenessWithCamera(doc, ids[5])
    const update = proposal(doc, (f) => setBlockText(f, ids[30], 'edited cold'))
    expect(decide(doc, update, awareness, createSpatialProposalGuard())).toEqual({ commit: true })
  })

  it('refuses a proposal editing a block inside a live camera band', () => {
    const { doc, ids } = seed(40)
    const awareness = awarenessWithCamera(doc, ids[20]) // default band ~[16..27]
    const update = proposal(doc, (f) => setBlockText(f, ids[22], 'edited guarded'))
    expect(decide(doc, update, awareness, createSpatialProposalGuard())).toMatchObject({ commit: false })
  })

  it('refuses an insert INTO a guarded band but commits an insert ABOVE it', () => {
    const { doc, ids } = seed(40)
    const awareness = awarenessWithCamera(doc, ids[20])
    const into = proposal(doc, (f) => insertBlockAfter(f, ids[22], 'paragraph', 'intruder'))
    expect(decide(doc, into, awareness, createSpatialProposalGuard())).toMatchObject({ commit: false })
    const above = proposal(doc, (f) => insertBlockAfter(f, ids[2], 'paragraph', 'above'))
    expect(decide(doc, above, awareness, createSpatialProposalGuard())).toEqual({ commit: true })
  })

  it('refuses merging (deleting) a guarded block', () => {
    const { doc, ids } = seed(40)
    const awareness = awarenessWithCamera(doc, ids[20])
    const update = proposal(doc, (f) => mergeIntoPrevious(f, ids[22]))
    expect(decide(doc, update, awareness, createSpatialProposalGuard())).toMatchObject({ commit: false })
  })

  it('commits anything when no camera is published (guards nothing — allow-all compatible)', () => {
    const { doc, ids } = seed(20)
    const update = proposal(doc, (f) => setBlockText(f, ids[10], 'whatever'))
    expect(decide(doc, update, emptyAwareness(doc), createSpatialProposalGuard())).toEqual({ commit: true })
  })

  it('fails closed: a null awareness (unknown peer set) refuses a real edit', () => {
    const { doc, ids } = seed(20)
    const update = proposal(doc, (f) => setBlockText(f, ids[10], 'whatever'))
    expect(decide(doc, update, null, createSpatialProposalGuard())).toMatchObject({ commit: false })
  })

  it('keeps a dropped camera guarded within grace, then releases it', () => {
    const { doc, ids } = seed(40)
    const guard = createSpatialProposalGuard({ graceMs: 1000 })
    const withCam = awarenessWithCamera(doc, ids[20])
    const empty = emptyAwareness(doc)
    const edit = (tag: string) => proposal(doc, (f) => setBlockText(f, ids[22], tag))

    expect(decide(doc, edit('a'), withCam, guard, 0).commit).toBe(false) // camera live
    expect(decide(doc, edit('b'), empty, guard, 1000).commit).toBe(false) // dropped, within grace
    expect(decide(doc, edit('c'), empty, guard, 1001).commit).toBe(true) // past grace, released
  })

  it('honors injected pinned blocks (always guarded, even far from any camera)', () => {
    const { doc, ids } = seed(40)
    const guard = createSpatialProposalGuard({ pinned: () => [ids[35]] })
    const awareness = awarenessWithCamera(doc, ids[5])
    const update = proposal(doc, (f) => setBlockText(f, ids[35], 'edit pinned'))
    expect(decide(doc, update, awareness, guard).commit).toBe(false)
  })
})
