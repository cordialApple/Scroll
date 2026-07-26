import { mintPeerToken, type PeerRole, type ProgrammaticMode } from './peerToken'

export interface RoomConfig {
  programmatic: ProgrammaticMode
  // Room-authoritative cap grant (F-05): the ROOM decides which capabilities an admitted peer of a
  // given role receives (write, propose). Absent → no caps. contract-1 says the room grants write via a
  // cap, so the grant lives here, never on the request — there is no `caps` field on AdmissionRequest to
  // smuggle, the same provable-by-construction move that kept `mode` off the request for contract-3.
  grantCaps?: (role: PeerRole) => string[]
}

export interface AdmissionRequest {
  sub: string
  role: PeerRole
  room: string
  ttlMs: number
}

// The admission seam (contract-7): a peer requests a room-scoped token; Scroll issues it. Both `mode`
// and `caps` are DERIVED from authoritative room config via the resolver, never taken from the request.
// That is what makes the guarantees provable: mintPeerToken throws for on+agent (contract-3), and a
// requester cannot self-grant write/propose because there is no field to carry it (F-05).
export function issueRoomToken(
  secret: string,
  resolveRoomConfig: (room: string) => RoomConfig,
  req: AdmissionRequest,
): string {
  const config = resolveRoomConfig(req.room)
  return mintPeerToken(secret, {
    mode: config.programmatic,
    sub: req.sub,
    role: req.role,
    room: req.room,
    ttlMs: req.ttlMs,
    caps: config.grantCaps?.(req.role) ?? [],
  })
}
