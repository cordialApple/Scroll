import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { CAP_PROPOSE, CAP_WRITE, type PeerIdentity } from '../auth/peerToken'
import { allowAllGuard, evaluateProposal, type ProposalGuard } from './proposeCommit'

const MAX = 8 * 1024 * 1024
const proposer: PeerIdentity = { sub: 'agent-1', role: 'agent', caps: [CAP_PROPOSE], room: 'r' }

function updateOf(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

describe('P4.3 evaluateProposal — op-grain authority decision (contract-1 propose/commit)', () => {
  const base = { update: updateOf('hi'), document: new Y.Doc(), guard: allowAllGuard, maxUpdateBytes: MAX }

  it('commits a decodable proposal from a propose-capable peer', () => {
    expect(evaluateProposal({ ...base, peer: proposer })).toEqual({ commit: true })
  })

  it('refuses an unauthenticated (tokenless) proposal — never throws, connection-safe', () => {
    expect(evaluateProposal({ ...base, peer: null })).toEqual({
      commit: false,
      reason: 'permission-denied: unauthenticated proposal',
    })
  })

  it('refuses a peer that lacks CAP_PROPOSE (write alone does not grant propose)', () => {
    const writer: PeerIdentity = { sub: 'w', role: 'agent', caps: [CAP_WRITE], room: 'r' }
    expect(evaluateProposal({ ...base, peer: writer })).toMatchObject({
      commit: false,
      reason: expect.stringContaining('propose capability'),
    })
  })

  it('refuses an oversized proposal (proposals bypass ingress, so the size cap lives here too)', () => {
    const big = new Uint8Array(MAX + 1)
    expect(evaluateProposal({ ...base, peer: proposer, update: big, maxUpdateBytes: MAX })).toMatchObject({
      commit: false,
      reason: expect.stringContaining('exceeds'),
    })
  })

  it('refuses undecodable bytes (would poison every future room load)', () => {
    const garbage = new Uint8Array([9, 9, 9, 255, 255, 7, 3, 1, 200, 200])
    expect(evaluateProposal({ ...base, peer: proposer, update: garbage })).toEqual({
      commit: false,
      reason: 'proposal rejected: undecodable update payload',
    })
  })

  it('refuses with the injected guard reason when the apply-time predicate rejects', () => {
    const denyGuard: ProposalGuard = () => ({ ok: false, reason: 'spatial guard: target inside a live camera band' })
    expect(evaluateProposal({ ...base, peer: proposer, guard: denyGuard })).toEqual({
      commit: false,
      reason: 'spatial guard: target inside a live camera band',
    })
  })

  it('passes the authoritative document and peer into the guard (apply-time, not read-time)', () => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'authoritative')
    let seen: { peer: PeerIdentity; document: Y.Doc } | null = null
    const spyGuard: ProposalGuard = (_u, ctx) => {
      seen = ctx
      return { ok: true }
    }
    evaluateProposal({ ...base, peer: proposer, document: doc, guard: spyGuard })
    expect(seen!.document).toBe(doc)
    expect(seen!.peer).toBe(proposer)
  })
})
