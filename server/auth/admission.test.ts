import { describe, expect, it, vi } from 'vitest'
import { issueRoomToken } from './admission'
import { CAP_PROPOSE, CAP_WRITE, verifyPeerToken } from './peerToken'

const SECRET = 'admission-secret'

describe('P4.2 admission — mode derived from room config (contract-3 by construction, closes F-02)', () => {
  it('mints an agent token for an off room, with the room derived from config not the request', () => {
    const resolve = vi.fn((_room: string) => ({ programmatic: 'off' as const, grantCaps: () => [CAP_WRITE] }))
    const token = issueRoomToken(SECRET, resolve, { sub: 'interviewer', role: 'agent', room: 'r1', ttlMs: 60_000 })
    expect(resolve).toHaveBeenCalledWith('r1')
    const id = verifyPeerToken(SECRET, token, { room: 'r1' })
    expect(id).toMatchObject({ sub: 'interviewer', role: 'agent', caps: ['write'], room: 'r1' })
  })

  it('refuses to mint an agent token for a programmatic:on room — even though the request asked for agent', () => {
    const resolve = () => ({ programmatic: 'on' as const })
    expect(() => issueRoomToken(SECRET, resolve, { sub: 'x', role: 'agent', room: 'on-room', ttlMs: 60_000 })).toThrow(/contract-3/)
  })

  it('a human token is fine in an on room', () => {
    const resolve = () => ({ programmatic: 'on' as const, grantCaps: () => [CAP_WRITE] })
    const token = issueRoomToken(SECRET, resolve, { sub: 'user', role: 'human', room: 'on-room', ttlMs: 60_000 })
    expect(verifyPeerToken(SECRET, token, { room: 'on-room' }).role).toBe('human')
  })

  it('the request has no mode field to smuggle — on-ness is only ever the resolved room config', () => {
    const resolve = () => ({ programmatic: 'on' as const })
    // @ts-expect-error AdmissionRequest has no `mode`; a caller cannot pass one to override the room.
    expect(() => issueRoomToken(SECRET, resolve, { sub: 'x', role: 'agent', room: 'on-room', ttlMs: 60_000, mode: 'off' })).toThrow(/contract-3/)
  })
})

describe('P4.3 admission — caps derived from room config, never the request (F-05)', () => {
  it('the room grants caps by role; the requester cannot ask for them (no caps field to smuggle)', () => {
    const resolve = (_room: string) => ({
      programmatic: 'off' as const,
      grantCaps: (role: 'human' | 'agent') => (role === 'agent' ? [CAP_WRITE, CAP_PROPOSE] : [CAP_WRITE]),
    })
    const agent = verifyPeerToken(SECRET, issueRoomToken(SECRET, resolve, { sub: 'a', role: 'agent', room: 'r', ttlMs: 60_000 }), { room: 'r' })
    expect(agent.caps).toEqual([CAP_WRITE, CAP_PROPOSE])
    const human = verifyPeerToken(SECRET, issueRoomToken(SECRET, resolve, { sub: 'h', role: 'human', room: 'r', ttlMs: 60_000 }), { room: 'r' })
    expect(human.caps).toEqual([CAP_WRITE])
  })

  it('a room with no grant policy admits a capless (read-only) peer', () => {
    const resolve = () => ({ programmatic: 'off' as const })
    const id = verifyPeerToken(SECRET, issueRoomToken(SECRET, resolve, { sub: 'ro', role: 'agent', room: 'r', ttlMs: 60_000 }), { room: 'r' })
    expect(id.caps).toEqual([])
  })

  it('a requester cannot self-grant caps — the field does not exist on the request', () => {
    const resolve = () => ({ programmatic: 'off' as const })
    const id = verifyPeerToken(
      SECRET,
      // @ts-expect-error AdmissionRequest has no `caps`; the room is the sole source of capability grants.
      issueRoomToken(SECRET, resolve, { sub: 'x', role: 'agent', room: 'r', ttlMs: 60_000, caps: [CAP_WRITE] }),
      { room: 'r' },
    )
    expect(id.caps).toEqual([])
  })
})
