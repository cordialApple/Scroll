import * as Y from 'yjs'
import type { Extension } from '@hocuspocus/server'
import { describe, expect, it, vi } from 'vitest'
import { CAP_PROPOSE, CAP_WRITE, type PeerIdentity } from '../auth/peerToken'
import {
  allowAllGuard,
  createProposeCommitExtension,
  encodeProposal,
  evaluateProposal,
  parseProposalResult,
  type CommitProposal,
  type ProposalGuard,
} from './proposeCommit'

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

describe('P4.3 createProposeCommitExtension onStateless — orchestration + crash-safety (F-02)', () => {
  function fakeConnection(peer: PeerIdentity | null) {
    const sent: string[] = []
    const connection = {
      context: peer ? { peer } : {},
      sendStateless: (p: string) => sent.push(p),
    }
    return { connection, sent }
  }

  const invoke = (ext: Extension, args: { connection: unknown; document: Y.Doc; payload: string; documentName: string }) =>
    ext.onStateless!(args as never)

  it('commits: calls commitProposal and replies ok', async () => {
    const commit = vi.fn<CommitProposal>(async () => {})
    const ext = createProposeCommitExtension(commit)
    const { connection, sent } = fakeConnection(proposer)
    await invoke(ext, { connection, document: new Y.Doc(), payload: encodeProposal('c1', updateOf('x')), documentName: 'r' })
    expect(commit).toHaveBeenCalledOnce()
    expect(parseProposalResult(sent[0])).toMatchObject({ id: 'c1', ok: true })
  })

  it('refuses without committing when the peer lacks CAP_PROPOSE', async () => {
    const commit = vi.fn<CommitProposal>(async () => {})
    const ext = createProposeCommitExtension(commit)
    const writer: PeerIdentity = { sub: 'w', role: 'agent', caps: [CAP_WRITE], room: 'r' }
    const { connection, sent } = fakeConnection(writer)
    await invoke(ext, { connection, document: new Y.Doc(), payload: encodeProposal('c2', updateOf('x')), documentName: 'r' })
    expect(commit).not.toHaveBeenCalled()
    expect(parseProposalResult(sent[0])).toMatchObject({ id: 'c2', ok: false })
  })

  it('a commit-path failure is contained as an op-grain refusal, never rethrown (would crash every room)', async () => {
    const commit: CommitProposal = async () => {
      throw new Error('persistence unavailable')
    }
    const ext = createProposeCommitExtension(commit)
    const { connection, sent } = fakeConnection(proposer)
    // onStateless is dispatched fire-and-forget by Hocuspocus; it MUST resolve, not reject.
    await expect(
      invoke(ext, { connection, document: new Y.Doc(), payload: encodeProposal('c3', updateOf('x')), documentName: 'r' }),
    ).resolves.toBeUndefined()
    expect(parseProposalResult(sent[0])).toMatchObject({ id: 'c3', ok: false })
    expect(parseProposalResult(sent[0])!.reason).toContain('commit failed')
  })

  it('ignores non-Scroll stateless traffic (no reply, no misfire)', async () => {
    const commit = vi.fn<CommitProposal>(async () => {})
    const ext = createProposeCommitExtension(commit)
    const { connection, sent } = fakeConnection(proposer)
    await invoke(ext, { connection, document: new Y.Doc(), payload: JSON.stringify({ action: 'version.create' }), documentName: 'r' })
    expect(commit).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})
