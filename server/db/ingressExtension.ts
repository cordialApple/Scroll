import type { Extension } from '@hocuspocus/server'
import { extractSyncUpdate } from './extractSyncUpdate'

// 4403 (Forbidden) is deliberate, not arbitrary: it is the ONLY close code the Hocuspocus provider
// retries. On close it sets shouldConnect=false for Unauthorized(4401) and MessageTooBig(1009), so
// closing with either of those would refuse the update AND permanently stop the peer — no resync. A
// 4403 close makes the provider reconnect and re-run sync (step1/step2), which is the "refuse-and-
// resync" the distributed-systems.md "Rejecting an update" rule requires. See the provider's onClose.
const REFUSE_CODE = 4403

function refuse(reason: string): Error {
  // handleMessage reads `code`/`reason` straight off the thrown error to close the socket.
  return Object.assign(new Error(reason), { code: REFUSE_CODE, reason })
}

export interface IngressOptions {
  // Hard cap on a single wire message. Default is generous (abuse-shaped, not legitimate-doc-shaped):
  // a real syncStep2 carries the whole document, so this must sit well above any honest snapshot.
  maxUpdateBytes?: number
  // contract-7 trust root. When present, EVERY connection must authenticate (defining onAuthenticate on
  // any extension flips Hocuspocus's requiresAuthentication server-wide), so leaving it undefined is what
  // keeps single-owner localhost tokenless. Returns the identity context; throw to deny. Token ISSUANCE
  // stays P4 — this is only the seam.
  authenticate?: (token: string) => unknown | Promise<unknown>
}

// Registered BEFORE the persistence extension so a refusal short-circuits the beforeHandleMessage chain
// (Hocuspocus runs hooks sequentially and a reject skips the rest) — an oversized/malformed frame is
// refused before it is ever appended to Postgres, never persisted-then-rejected.
export function createIngressExtension(opts: IngressOptions = {}): Extension {
  const maxUpdateBytes = opts.maxUpdateBytes ?? 8 * 1024 * 1024

  const ext: Extension = {
    async beforeHandleMessage({ update }) {
      if (update.byteLength > maxUpdateBytes) {
        throw refuse(`update rejected: ${update.byteLength}B exceeds ${maxUpdateBytes}B cap`)
      }
      // A frame we cannot even decode is refused rather than handed to MessageReceiver.apply, whose own
      // decode failure would land uncaught in handleMessage's .then() (past beforeHandleMessage's guard).
      // extractSyncUpdate returns null for non-sync frames (awareness/query) — those are legitimate.
      try {
        extractSyncUpdate(update)
      } catch {
        throw refuse('update rejected: malformed sync envelope')
      }
    },
  }

  if (opts.authenticate) {
    const authenticate = opts.authenticate
    ext.onAuthenticate = async ({ token }) => authenticate(token)
  }

  return ext
}
