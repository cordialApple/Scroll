import { mintPeerToken, type PeerRole, type ProgrammaticMode } from './peerToken'

export interface RoomConfig {
  programmatic: ProgrammaticMode
}

export interface AdmissionRequest {
  sub: string
  role: PeerRole
  room: string
  ttlMs: number
  caps?: string[]
}

// The admission seam (contract-7): a peer requests a room-scoped token; Scroll issues it. `mode` is
// DERIVED from authoritative room config via the resolver, never taken from the request — there is no
// mode field on AdmissionRequest to smuggle. That is what makes contract-3 provable: mintPeerToken
// throws for on+agent, and on-ness comes from the room, so an agent can never be admitted to a
// programmatic:on room regardless of what the requester asks for.
export function issueRoomToken(
  secret: string,
  resolveRoomConfig: (room: string) => RoomConfig,
  req: AdmissionRequest,
): string {
  const { programmatic } = resolveRoomConfig(req.room)
  return mintPeerToken(secret, {
    mode: programmatic,
    sub: req.sub,
    role: req.role,
    room: req.room,
    ttlMs: req.ttlMs,
    caps: req.caps,
  })
}
