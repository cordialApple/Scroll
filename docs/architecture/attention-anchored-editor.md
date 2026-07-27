# Attention-anchored collaborative editor

**A document where the viewport is a lock. Users write, an agent reorganizes, and nobody's screen
ever moves under them.**

This is the native-app value proposition, an offshoot of the relative-viewport-anchoring primitive.
It only needs `doc-es` (and, per the OCP note, does not strictly need an endpoint at all since Scroll
controls it natively). See [open-questions.md](../open-questions.md).

## Residency

Each user permanently holds 12 blocks: 4 visible, 4 buffered above, 4 below. Pinned blocks are immune
to agent mutation regardless of age. Scroll four blocks in any direction at any speed and nothing
changes beneath you.

## Two gates, different jobs

- **The spatial guard is correctness.** A camera's whole residency band is untouchable: the on-screen
  span plus a 4-block scroll buffer on each side. Because the published camera anchor is the viewport
  **top** (`scrollTop = anchorOffsetTop + offset`), the visible span runs *downward* from the anchor, so
  the band is asymmetric — 4 buffer blocks above, then the visible blocks, then 4 below — not ±4 about a
  point. (First cut: a fixed visible-block count; the height-aware / velocity-weighted extent is the
  refinement — see Sizing.) No clock is involved. The guard is evaluated by the room authority at **commit time**
  (the propose/commit capability in [distributed-systems.md](distributed-systems.md)), not only at
  the agent's read time — otherwise a camera flick-scrolling into the region between revalidation and
  arrival defeats it.
- **LRU is prioritization.** Among blocks already outside every guard band, recency ranks which cold
  region the agent works first. LRU never grants permission.
- **The guard fails closed.** Guard bands derive from awareness, and awareness is ephemeral and lossy
  by design (TTL, clear-on-disconnect). A camera that disappears — network blip, TTL expiry — keeps
  its last-known band guarded for a grace window measured in minutes, not the awareness TTL; a user
  whose wifi dropped for 45 seconds is still looking at the screen. If the peer set itself is unknown
  (awareness outage, room rebooting), the agent idles. Absence of presence is never treated as
  absence of a reader.

## Anchoring

Position is `{blockId, offsetWithinBlock}`, never a scroll offset, resolved to pixels at layout time.
One shared layout, N independent cameras: offscreen collaborators stay anchored identically to the
rendered one. Destructive merges redirect consumed ids to their successor so anchors resolve through
the rename (the redirect table is CRDT data in the doc, atomic with the merge — see
[relative-viewport-anchoring.md](relative-viewport-anchoring.md)). `blockId` is an app-level stable
identifier stored as a block attribute — never a Yjs
internal id — so anchors survive an epoch reset; Yjs `Y.RelativePosition`s are epoch-local and get
remapped at reset (see the epoch reset protocol in
[distributed-systems.md](distributed-systems.md)).

## Agent

Two decoupled loops:

- A **cheap observer** samples cold regions and enqueues candidates.
- An **expensive actor** dequeues and submits through the peer protocol's **propose/commit**
  capability: the room evaluates the lease — spatial predicate plus a content hash over the target
  span — at apply time and commits or refuses. The actor never applies a guarded write locally first,
  so a refusal costs nothing and cannot fork its doc. Pinned-block immunity is enforced by the same
  commit gate.

This is optimistic concurrency control with a **spatial predicate** instead of a version number,
checked by the single-threaded room authority at commit, which closes the check-then-act race.

## Provenance

Authorship renders as color, derivation as gradient. Agent-merged content shows the blend of its
contributing authors, so "who wrote this and what did the model do to it" is legible without a diff.

## Sizing

Two users pin up to 24 blocks, so the document needs roughly 40 or more before the agent has room.
Overlapping spans push the cold zone to the document's outer edges rather than the middle. Fixed
4/4 buffers are the first cut; velocity-weighted asymmetry is the refinement.

## Relationship to the research substrate

The headless-agent-as-peer pattern (a Node process holding the same `Y.Doc`, observing `Y.Text`
deltas and awareness, writing back through CRDT mutations) is the concrete way to build the agent's
two loops. The observer reads document deltas plus awareness (every camera's `{blockId, offset}`);
the actor writes committed reorganizations as CRDT ops attributed to a durable self-identity (a
persisted `clientID` / recorded op-id set — `transaction.origin` is process-local and a restart
randomizes `clientID`, see [distributed-systems.md](distributed-systems.md)), which is what keeps
its edits attributable and out of its own observer. See
[integrations/starfolio.md](../integrations/starfolio.md) for how an external AI plays this role
instead of a native one.
