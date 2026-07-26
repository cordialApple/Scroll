import * as Y from 'yjs'
import type { Extension } from '@hocuspocus/server'
import { CAP_PROPOSE, peerFromContext, type PeerIdentity } from '../auth/peerToken'
import type { DocumentStore } from './store'
import { DOC_EPOCH_V1 } from './persistenceExtension'

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
// A server-origin tag so the persistence onChange (which only tracks sync-path pending seqs) and any
// future observer can tell a committed proposal apart from a wire sync update.
export const PROPOSE_ORIGIN = 'scroll:propose-commit'

interface ProposalMessage {
  t: typeof PROPOSE_MARKER
  id: string
  u: string
}

function parseProposal(payload: string): ProposalMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(payload)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
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
  let msg: unknown
  try {
    msg = JSON.parse(payload)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
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

// The propose/commit authority seam. onStateless is Hocuspocus's per-connection channel that does NOT
// go through MessageReceiver.apply, so a proposal never touches the proposer's own doc — a refusal
// leaves nothing to unwind. On commit we persist BEFORE applying (contract-5 persist-before-ack, same
// order the sync path enforces in beforeHandleMessage) and then apply to the authoritative document,
// whose update handler broadcasts the delta to every connection — the proposer included, so it
// receives its own committed proposal back exactly like a remote update.
export function createProposeCommitExtension(store: DocumentStore, opts: ProposeCommitOptions = {}): Extension {
  const guard = opts.guard ?? allowAllGuard
  const maxUpdateBytes = opts.maxUpdateBytes ?? 8 * 1024 * 1024

  return {
    async onStateless({ payload, connection, document, documentName }) {
      const proposal = parseProposal(payload)
      if (!proposal) return // not a Scroll proposal (awareness/history-versioning stateless traffic)

      let update: Uint8Array
      try {
        update = new Uint8Array(Buffer.from(proposal.u, 'base64url'))
      } catch {
        connection.sendStateless(result(proposal.id, { commit: false, reason: 'proposal rejected: malformed payload' }))
        return
      }

      const peer = peerFromContext(connection.context)
      const decision = evaluateProposal({ peer, update, document, guard, maxUpdateBytes })

      if (decision.commit) {
        // Persist-before-apply: the append is durable before the authority mutates or broadcasts.
        await store.appendUpdate(documentName, DOC_EPOCH_V1, update)
        Y.applyUpdate(document, update, PROPOSE_ORIGIN)
      }
      connection.sendStateless(result(proposal.id, decision))
    },
  }
}
