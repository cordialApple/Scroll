import { describe, expect, it, vi } from 'vitest'
import { issueRoomToken } from './admission'
import { CAP_WRITE, verifyPeerToken } from './peerToken'

const SECRET = 'admission-secret'

describe('P4.2 admission — mode derived from room config (contract-3 by construction, closes F-02)', () => {
  it('mints an agent token for an off room, with the room derived from config not the request', () => {
    const resolve = vi.fn((_room: string) => ({ programmatic: 'off' as const }))
    const token = issueRoomToken(SECRET, resolve, { sub: 'interviewer', role: 'agent', room: 'r1', ttlMs: 60_000, caps: [CAP_WRITE] })
    expect(resolve).toHaveBeenCalledWith('r1')
    const id = verifyPeerToken(SECRET, token, { room: 'r1' })
    expect(id).toMatchObject({ sub: 'interviewer', role: 'agent', caps: ['write'], room: 'r1' })
  })

  it('refuses to mint an agent token for a programmatic:on room — even though the request asked for agent', () => {
    const resolve = () => ({ programmatic: 'on' as const })
    expect(() => issueRoomToken(SECRET, resolve, { sub: 'x', role: 'agent', room: 'on-room', ttlMs: 60_000 })).toThrow(/contract-3/)
  })

  it('a human token is fine in an on room', () => {
    const resolve = () => ({ programmatic: 'on' as const })
    const token = issueRoomToken(SECRET, resolve, { sub: 'user', role: 'human', room: 'on-room', ttlMs: 60_000, caps: [CAP_WRITE] })
    expect(verifyPeerToken(SECRET, token, { room: 'on-room' }).role).toBe('human')
  })

  it('the request has no mode field to smuggle — on-ness is only ever the resolved room config', () => {
    const resolve = () => ({ programmatic: 'on' as const })
    // @ts-expect-error AdmissionRequest has no `mode`; a caller cannot pass one to override the room.
    expect(() => issueRoomToken(SECRET, resolve, { sub: 'x', role: 'agent', room: 'on-room', ttlMs: 60_000, mode: 'off' })).toThrow(/contract-3/)
  })
})
