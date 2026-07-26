import * as Y from 'yjs'
import type { Extension } from '@hocuspocus/server'
import { CAP_PROPOSE, peerFromContext, type PeerIdentity } from '../auth/peerToken'

export type GuardResult = { ok: true } | { ok: false; reason: string }

// contract-1 apply-time guard: the single-threaded authority evaluates this against the authoritative
// document at commit, closing the check-then-act race an actor's read-time revalidation cannot. P4.3
// ships the seam with an allow-all default; the concrete spatial-band / pinned-block / lease
// content-hash predicate lands with the P6 doc model. Injected (Strategy), so the capability stays
// generic and consumer-blind — the room owns the policy, no peer concept leaks in.
export type ProposalGuard = (
  update: Uint8Array,
  ctx: { peer: PeerIdentity; document: Y.Doc },
) => GuardResult

export const allowAllGuard: ProposalGuard = () => ({ ok: true })

// A commit applies-persists-broadcasts; a refuse costs the proposer nothing because it never
// self-applied. Both are op-grain: a value the authority acts on, never a thrown close code — the
// connection stays up (this is what closes F-04 vs the connection-grain 4400 sync path).
export type ProposalDecision = { commit: true } | { commit: false; reason: string }

export interface EvaluateProposalArgs {
  peer: PeerIdentity | null
  update: Uint8Array
  document: Y.Doc
  guard: ProposalGuard
  maxUpdateBytes: number
}

// Pure authority decision for one proposal. Proposals arrive as stateless messages, so they bypass the
// ingress beforeHandleMessage guard entirely — size and decode validation therefore live here too, not
// only on the sync path. Order: authenticate (only a propose-capable peer may propose) → size → decode
// (undecodable bytes would poison every future room load) → the injected apply-time guard.
export function evaluateProposal(args: EvaluateProposalArgs): ProposalDecision {
  const { peer, update, document, guard, maxUpdateBytes } = args
  if (!peer) return { commit: false, reason: 'permission-denied: unauthenticated proposal' }
  if (!peer.caps.includes(CAP_PROPOSE)) {
    return { commit: false, reason: 'permission-denied: peer lacks propose capability' }
  }
  if (update.byteLength > maxUpdateBytes) {
    return { commit: false, reason: `proposal rejected: ${update.byteLength}B exceeds ${maxUpdateBytes}B cap` }
  }
  try {
    Y.applyUpdate(new Y.Doc(), update)
  } catch {
    return { commit: false, reason: 'proposal rejected: undecodable update payload' }
  }
  const verdict = guard(update, { peer, document })
  if (!verdict.ok) return { commit: false, reason: verdict.reason }
  return { commit: true }
}

const PROPOSE_MARKER = 'scroll/propose'
const RESULT_MARKER = 'scroll/propose-result'

interface ProposalMessage {
  t: typeof PROPOSE_MARKER
  id: string
  u: string
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  let msg: unknown
  try {
    msg = JSON.parse(payload)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  return msg as Record<string, unknown>
}

function parseProposal(payload: string): ProposalMessage | null {
  const m = parseJsonObject(payload)
  if (!m) return null
  if (m.t !== PROPOSE_MARKER || typeof m.id !== 'string' || typeof m.u !== 'string') return null
  return { t: PROPOSE_MARKER, id: m.id, u: m.u }
}

export function encodeProposal(id: string, update: Uint8Array): string {
  return JSON.stringify({ t: PROPOSE_MARKER, id, u: Buffer.from(update).toString('base64url') })
}

export interface ProposalResult {
  t: typeof RESULT_MARKER
  id: string
  ok: boolean
  reason?: string
}

export function parseProposalResult(payload: string): ProposalResult | null {
  const m = parseJsonObject(payload)
  if (!m) return null
  if (m.t !== RESULT_MARKER || typeof m.id !== 'string' || typeof m.ok !== 'boolean') return null
  return { t: RESULT_MARKER, id: m.id, ok: m.ok, reason: typeof m.reason === 'string' ? m.reason : undefined }
}

function result(id: string, decision: ProposalDecision): string {
  return JSON.stringify(
    decision.commit
      ? { t: RESULT_MARKER, id, ok: true }
      : { t: RESULT_MARKER, id, ok: false, reason: decision.reason },
  )
}

export interface ProposeCommitOptions {
  guard?: ProposalGuard
  maxUpdateBytes?: number
}

// Persists-before-applies a committed proposal on the persistence extension's own durable ledger, so
// the row is compacted like any sync write (never leaks) and the apply is tagged so persistence's
// onChange skips it. Injected rather than reaching into the store directly — keeps propose/commit's
// authZ/guard concern separate from durability bookkeeping while sharing one seq ledger.
export type CommitProposal = (documentName: string, document: Y.Doc, update: Uint8Array) => Promise<void>

// The propose/commit authority seam. onStateless is Hocuspocus's per-connection channel that does NOT
// touch the proposer's own doc — a refusal leaves nothing to unwind. On commit, commitProposal persists
// BEFORE applying (contract-5), and the apply broadcasts the delta to every connection (proposer
// included, so it receives its own committed proposal back like a remote update). The whole body is
// wrapped: Hocuspocus dispatches this callback fire-and-forget (Connection never awaits it), so ANY
// escaping throw — a rejected append, an unexpected decode — becomes an unhandledRejection that crashes
// every room. A commit failure is contained here as an op-grain refusal, never a process crash.
export function createProposeCommitExtension(commitProposal: CommitProposal, opts: ProposeCommitOptions = {}): Extension {
  const guard = opts.guard ?? allowAllGuard
  const maxUpdateBytes = opts.maxUpdateBytes ?? 8 * 1024 * 1024

  return {
    async onStateless({ payload, connection, document, documentName }) {
      const proposal = parseProposal(payload)
      if (!proposal) return // not a Scroll proposal (awareness/history-versioning stateless traffic)

      try {
        let update: Uint8Array
        try {
          update = new Uint8Array(Buffer.from(proposal.u, 'base64url'))
        } catch {
          connection.sendStateless(result(proposal.id, { commit: false, reason: 'proposal rejected: malformed payload' }))
          return
        }

        const peer = peerFromContext(connection.context)
        const decision = evaluateProposal({ peer, update, document, guard, maxUpdateBytes })

        if (decision.commit) await commitProposal(documentName, document, update)
        connection.sendStateless(result(proposal.id, decision))
      } catch (err) {
        // Contain a commit-path failure (e.g. the durable append rejected): refuse op-grain, keep the
        // room alive. Never rethrow — an escaped throw here crashes every room (see header).
        console.error(`[scroll-propose] proposal ${proposal.id} failed for ${documentName}:`, err)
        connection.sendStateless(result(proposal.id, { commit: false, reason: 'proposal rejected: commit failed' }))
      }
    },
  }
}
