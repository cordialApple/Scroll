# Attention-anchored collaborative editor

**A document where the viewport is a lock. Users write, an agent reorganizes, and nobody's screen
ever moves under them.**

This is the native-app value proposition, an offshoot of the relative-viewport-anchoring primitive.
It only needs `doc-es` (and, per the OCP note, does not strictly need an endpoint at all since Scroll
controls it natively). See [open-questions.md](open-questions.md).

## Residency

Each user permanently holds 12 blocks: 4 visible, 4 buffered above, 4 below. Pinned blocks are immune
to agent mutation regardless of age. Scroll four blocks in any direction at any speed and nothing
changes beneath you.

## Two gates, different jobs

- **The spatial guard is correctness.** Within plus-or-minus 4 blocks of any camera, content is
  untouchable. No clock is involved.
- **LRU is prioritization.** Among blocks already outside every guard band, recency ranks which cold
  region the agent works first. LRU never grants permission.

## Anchoring

Position is `{blockId, offsetWithinBlock}`, never a scroll offset, resolved to pixels at layout time.
One shared layout, N independent cameras: offscreen collaborators stay anchored identically to the
rendered one. Destructive merges redirect consumed ids to their successor so anchors resolve through
the rename.

## Agent

Two decoupled loops:

- A **cheap observer** samples cold regions and enqueues candidates.
- An **expensive actor** dequeues, revalidates the lease against current state, and either commits or
  drops.

This is optimistic concurrency control with a **spatial predicate** instead of a version number.

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
the actor writes committed reorganizations as CRDT ops with a distinct transaction origin so its
edits are attributable and do not trigger its own observer. See
[integrations/starfolio.md](../integrations/starfolio.md) for how an external AI plays this role
instead of a native one.
