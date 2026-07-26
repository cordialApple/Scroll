import * as Y from 'yjs'
import type { Extension } from '@hocuspocus/server'
import { extractSyncUpdate } from './extractSyncUpdate'
import { CAP_WRITE, peerFromContext } from '../auth/peerToken'

// 4400 is a generic application close code, chosen deliberately over Hocuspocus's named codes. The
// provider's onClose special-cases exactly three: Unauthorized(4401) and MessageTooBig(1009) set
// shouldConnect=false (the peer never comes back), and Forbidden(4403) hits a quiet-gated early `return`
// that skips reconnect under the default quiet:false config. Any OTHER 4xxx code falls through to
// `if (shouldConnect) connect()` — so 4400 is what actually delivers refuse-AND-resync: the offending
// frame is dropped, the socket closes with a reason, and the peer reconnects and re-runs sync.
const REFUSE_CODE = 4400

function refuse(reason: string): Error {
  // handleMessage reads `code`/`reason` straight off the thrown error to close the socket.
  return Object.assign(new Error(reason), { code: REFUSE_CODE, reason })
}

// A read-only peer still sends one no-op syncStep2 during the handshake (its empty diff against the
// server). That carries no structs/deletes, so it is not a "write" and must not trip the write-cap
// gate — only a state-mutating update does.
function mutatesState(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update)
  return structs.length > 0 || ds.clients.size > 0
}

export interface IngressOptions {
  // Hard cap on a single wire message. Default is generous (abuse-shaped, not legitimate-doc-shaped):
  // a real syncStep2 carries the whole document, so this must sit well above any honest snapshot.
  maxUpdateBytes?: number
  // contract-7 trust root. When present, EVERY connection must authenticate (defining onAuthenticate on
  // any extension flips Hocuspocus's requiresAuthentication server-wide), so leaving it undefined is what
  // keeps single-owner localhost tokenless. Receives the joining room's documentName so room-scope is
  // enforced against the actual room, not a peer claim. Returns the identity context spread into the
  // connection context; throw to deny. See server/auth/peerToken.ts for the P4 issuer/verifier.
  authenticate?: (token: string, ctx: { documentName: string }) => unknown | Promise<unknown>
}

// Registered BEFORE the persistence extension so a refusal short-circuits the beforeHandleMessage chain
// (Hocuspocus runs hooks sequentially and a reject skips the rest) — an oversized/malformed frame is
// refused before it is ever appended to Postgres, never persisted-then-rejected.
export function createIngressExtension(opts: IngressOptions = {}): Extension {
  const maxUpdateBytes = opts.maxUpdateBytes ?? 8 * 1024 * 1024

  const ext: Extension = {
    async beforeHandleMessage({ update, context }) {
      if (update.byteLength > maxUpdateBytes) {
        throw refuse(`update rejected: ${update.byteLength}B exceeds ${maxUpdateBytes}B cap`)
      }
      // Non-sync frames (awareness/query) carry no doc bytes — extractSyncUpdate returns null and they
      // pass. A frame whose envelope won't even decode is refused here rather than handed downstream.
      let syncUpdate: Uint8Array | null
      try {
        syncUpdate = extractSyncUpdate(update)
      } catch {
        throw refuse('update rejected: malformed sync envelope')
      }
      // Validate the CRDT payload with the SAME operation the load path uses (applyUpdate to a throwaway
      // doc). A structurally-corrupt update that persisted here would poison every future room load —
      // loadDocument replays the log through applyUpdate and would throw on it. Paying one extra apply
      // at the trust boundary is what keeps un-decodable bytes out of the durable log entirely; a valid
      // incremental update with missing causal deps buffers without throwing, so this rejects only true
      // corruption, not legitimate out-of-order updates.
      if (syncUpdate) {
        try {
          Y.applyUpdate(new Y.Doc(), syncUpdate)
        } catch {
          throw refuse('update rejected: undecodable update payload')
        }
        // contract-1 AuthZ at the seam: a write from an authenticated peer lacking the write cap is
        // refused before persist — the room-side backstop for the peer-obligated write discipline. A
        // tokenless connection carries no peer (single-owner localhost) and is unaffected; a read-only
        // peer that behaves never sends a sync frame, so it observes uninterrupted.
        const peer = peerFromContext(context)
        if (peer && !peer.caps.includes(CAP_WRITE) && mutatesState(syncUpdate)) {
          throw refuse('update rejected: peer lacks write capability')
        }
      }
    },
  }

  if (opts.authenticate) {
    const authenticate = opts.authenticate
    ext.onAuthenticate = async ({ token, documentName }) => authenticate(token, { documentName })
  }

  return ext
}
