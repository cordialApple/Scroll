import { createHmac, timingSafeEqual } from 'node:crypto'

export type PeerRole = 'human' | 'agent'
export type ProgrammaticMode = 'on' | 'off'

export interface PeerClaims {
  v: 1
  sub: string
  role: PeerRole
  caps: string[]
  room: string
  iat: number
  exp: number
}

export interface PeerIdentity {
  sub: string
  role: PeerRole
  caps: string[]
  room: string
}

export interface MintOptions {
  mode: ProgrammaticMode
  sub: string
  role: PeerRole
  room: string
  ttlMs: number
  caps?: string[]
  now?: number
}

const TOKEN_VERSION = 1

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function mintPeerToken(secret: string, o: MintOptions): string {
  // contract-3: a programmatic:on preset never issues an agent-role token — this IS "admits no AI
  // peer" in code. The gate lives at issuance, the only place with the mode in hand.
  if (o.mode === 'on' && o.role === 'agent') {
    throw new Error('contract-3: programmatic:on never issues an agent-role peer token')
  }
  // A non-finite ttlMs would make exp NaN/Infinity, which `now >= exp` never rejects — a
  // never-expiring token. Reject at the source so a computed (non-literal) ttlMs can't arm that.
  if (!Number.isFinite(o.ttlMs)) throw new Error('ttlMs must be finite')
  const iat = o.now ?? Date.now()
  const claims: PeerClaims = {
    v: TOKEN_VERSION,
    sub: o.sub,
    role: o.role,
    caps: o.caps ?? [],
    room: o.room,
    iat,
    exp: iat + o.ttlMs,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

export interface VerifyOptions {
  room: string
  now?: number
}

function deny(reason: string): never {
  throw new Error(`permission-denied: ${reason}`)
}

// contract-7: Scroll validates only tokens it issued and roles are Scroll-asserted, never self-declared
// — role/caps/room live inside the MAC-covered payload, so a peer editing any of them breaks the
// signature. Verification proves issuance (secret), freshness (exp), and that the token is scoped to
// THIS room; the returned identity is what the seam trusts, not anything the peer says over the wire.
export function verifyPeerToken(secret: string, token: string, o: VerifyOptions): PeerIdentity {
  const dot = token.indexOf('.')
  if (dot < 0) deny('malformed token')
  const payload = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(secret, payload))
  // timingSafeEqual throws on a length mismatch; a length check first keeps the compare constant-time
  // for equal-length forgeries (the only case where timing would otherwise leak).
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) deny('bad signature')

  let claims: PeerClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PeerClaims
  } catch {
    deny('undecodable claims')
  }
  if (claims.v !== TOKEN_VERSION) deny('unsupported token version')
  if (claims.role !== 'human' && claims.role !== 'agent') deny('unknown role')
  const now = o.now ?? Date.now()
  if (!Number.isFinite(claims.exp) || now >= claims.exp) deny('token expired')
  if (claims.room !== o.room) deny('token not scoped to this room')
  return {
    sub: claims.sub,
    role: claims.role,
    caps: Array.isArray(claims.caps) ? claims.caps : [],
    room: claims.room,
  }
}

export interface AuthContext {
  documentName: string
}

// Adapts the trust root to the ingress `authenticate` seam: the connection's room is the Hocuspocus
// documentName, so room-scope is enforced against the actual room being joined, not a peer claim.
export function createPeerAuthenticator(
  secret: string,
): (token: string, ctx: AuthContext) => PeerIdentity {
  return (token, ctx) => verifyPeerToken(secret, token, { room: ctx.documentName })
}
