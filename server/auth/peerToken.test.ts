import { describe, expect, it } from 'vitest'
import { createPeerAuthenticator, mintPeerToken, verifyPeerToken } from './peerToken'

const SECRET = 'scroll-trust-root-secret'
const T0 = 1_700_000_000_000

describe('P4.1 peer token — mint + verify (contract-7 trust root)', () => {
  it('round-trips identity: role, caps, room, sub survive verification', () => {
    const token = mintPeerToken(SECRET, {
      mode: 'off', sub: 'interviewer-1', role: 'agent', caps: ['propose'], room: 'doc-42', ttlMs: 60_000, now: T0,
    })
    const id = verifyPeerToken(SECRET, token, { room: 'doc-42', now: T0 + 1_000 })
    expect(id).toEqual({ sub: 'interviewer-1', role: 'agent', caps: ['propose'], room: 'doc-42' })
  })

  it('a tampered payload is denied (role cannot be self-escalated)', () => {
    const humanToken = mintPeerToken(SECRET, { mode: 'off', sub: 'u', role: 'human', room: 'r', ttlMs: 60_000, now: T0 })
    const [payload, sig] = humanToken.split('.')
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    forged.role = 'agent'
    const reencoded = Buffer.from(JSON.stringify(forged)).toString('base64url')
    expect(() => verifyPeerToken(SECRET, `${reencoded}.${sig}`, { room: 'r', now: T0 })).toThrow(/permission-denied: bad signature/)
  })

  it('a token signed with a different secret is denied', () => {
    const token = mintPeerToken('other-secret', { mode: 'off', sub: 'u', role: 'human', room: 'r', ttlMs: 60_000, now: T0 })
    expect(() => verifyPeerToken(SECRET, token, { room: 'r', now: T0 })).toThrow(/permission-denied: bad signature/)
  })

  it('an expired token is denied', () => {
    const token = mintPeerToken(SECRET, { mode: 'off', sub: 'u', role: 'human', room: 'r', ttlMs: 1_000, now: T0 })
    expect(() => verifyPeerToken(SECRET, token, { room: 'r', now: T0 + 1_000 })).toThrow(/permission-denied: token expired/)
    expect(verifyPeerToken(SECRET, token, { room: 'r', now: T0 + 999 }).sub).toBe('u')
  })

  it('a token minted for another room is denied (room-scoped)', () => {
    const token = mintPeerToken(SECRET, { mode: 'off', sub: 'u', role: 'agent', room: 'room-A', ttlMs: 60_000, now: T0 })
    expect(() => verifyPeerToken(SECRET, token, { room: 'room-B', now: T0 })).toThrow(/permission-denied: token not scoped to this room/)
  })

  it('a structurally malformed token is denied, not crashed', () => {
    expect(() => verifyPeerToken(SECRET, 'not-a-token', { room: 'r', now: T0 })).toThrow(/permission-denied/)
    expect(() => verifyPeerToken(SECRET, '', { room: 'r', now: T0 })).toThrow(/permission-denied/)
  })

  it('a non-finite ttlMs is rejected at mint (no never-expiring token)', () => {
    for (const ttlMs of [NaN, Infinity, -Infinity]) {
      expect(() => mintPeerToken(SECRET, { mode: 'off', sub: 'u', role: 'agent', room: 'r', ttlMs, now: T0 })).toThrow(/ttlMs must be finite/)
    }
  })

  it('contract-3: programmatic:on never mints an agent-role token; human is fine; off may mint agent', () => {
    expect(() => mintPeerToken(SECRET, { mode: 'on', sub: 'x', role: 'agent', room: 'r', ttlMs: 1_000, now: T0 })).toThrow(/contract-3/)
    expect(mintPeerToken(SECRET, { mode: 'on', sub: 'x', role: 'human', room: 'r', ttlMs: 1_000, now: T0 })).toContain('.')
    expect(mintPeerToken(SECRET, { mode: 'off', sub: 'x', role: 'agent', room: 'r', ttlMs: 1_000, now: T0 })).toContain('.')
  })

  it('createPeerAuthenticator enforces room-scope against the joined documentName', () => {
    const authenticate = createPeerAuthenticator(SECRET)
    const token = mintPeerToken(SECRET, { mode: 'off', sub: 'u', role: 'agent', room: 'doc-9', ttlMs: 60_000 })
    expect(authenticate(token, { documentName: 'doc-9' }).role).toBe('agent')
    expect(() => authenticate(token, { documentName: 'doc-other' })).toThrow(/not scoped to this room/)
  })
})
