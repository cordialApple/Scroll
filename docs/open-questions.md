# Scroll — open questions and unproven theses

Live design forks. None of these block preserving the idea; they block committing to an
implementation. Resolve each before the phase that depends on it.

## 1. The OCP endpoint thesis (unproven)

Claim: PersonalServer and STARfolio should control **endpoints**, not Scroll's native app processes,
so every editing surface is modeled as a spawnable endpoint (doc-es, ide-es) for Open/Closed
adherence.

Unproven parts:
- Whether the endpoint seam is the right abstraction for **Scroll-only** features (the native
  attention-anchored editor), or whether it adds indirection where a native call would do. `doc-es`
  may not need to be an endpoint at all for parts only Scroll controls.
- Whether "consumers extend via endpoints, never modify the app" holds up as the product grows.

### Leaning (live): document-native engine, endpoint as a spawn-config veneer

An endpoint is not a separate substrate. It is a document plus three extra things: a seed schema, a
non-human lifecycle owner, and a config flag (programmatic on/off). The native app is the degenerate
case (owner is the human, no seed schema). So the engine is **document-native** (one `Y.Doc` +
persistence + anchoring + agent-as-peer), and an endpoint is a thin config layer over it, not a
parallel path. Do not go "endpoint-native all the way down," which would cost the two value props.

Must be in-app, not endpoint-native:
- Persistence / ownership: durable user-owned docs outlive a session; endpoints are ephemeral by
  framing.
- Both value props: relative-viewport anchoring (P3) and the attention-anchored agent (P6) need a
  persistent resident doc; the agent is continuous in-app processing, not a spawned surface.
- The ide-es grader + sandbox: in-app **by necessity, to keep them out of the consumer's reach** (a
  consumer-driven oracle breaks the trust model in #3 and the boundary in personalserver.md).
- Durability/GC machinery (persist-before-ack, GC watermark, single-authority-per-room).

Decision test per feature: does an external consumer need to reach it? Yes -> expose through the
endpoint seam. Only Scroll + the human -> native, do not wrap it. Must be trustworthy/isolated ->
native by necessity, deliberately not consumer-controllable.

The seams this implies are formalized as interface contracts in
[architecture/boundaries.md](architecture/boundaries.md) (dependency direction, peer protocol, spawn
schema, programmatic Strategy, grader trust boundary).

Still open: whether this veneer holds as consumers grow, and where exactly the seam sits for surfaces
that are borderline (a coaching notepad that is ephemeral but human-facing).

Depends-on: P1 (endpoint spawners), P6 (native AI editor).

## 2. Notepad / whiteboard ownership (STARfolio)

Native-to-Scroll surfaces vs STARfolio-provided surfaces + observability provisioning. The
tooling side is now researched in [architecture/whiteboard.md](architecture/whiteboard.md): the
build-vs-buy leaning is **custom on Konva + Yjs** (native server-side AI-readability, native Yjs,
MIT), with Excalidraw-as-a-component-on-Yjs the runner-up; tldraw is best-in-class but $6,000/yr and a
second sync engine. What stays open is **ownership** (native to Scroll vs STARfolio-provided), not the
tech. Depends-on: P4.

## 3. Problem-source / graded-oracle trust (ide-es)

Where do hidden tests + reference solutions come from for the graded path? Options: curated bank in
Scroll (deterministic, trustworthy), Claude-generated per call (flexible, risky oracle), or hybrid
(bank first, generation as unvetted "practice" mode that never hard-gates). Leaning: bank owns the
graded oracle; AI generation is proposal-only. Depends-on: P1/P2.

## 4. CRDT vs OT substrate (decided: Yjs; sub-decision is GC policy)

Decided CRDT (Yjs): identity-based relative-position anchors, existing editor bindings, presence off
the document, a headless agent can join as a peer. OT is compact but central-server-bound and hard to
inject an agent into. The cost of CRDT is tombstones/per-object metadata, which is now a concrete
policy call, not an open algorithm choice: Scroll runs rooms `gc: false` (version history and lagging
peers, the agent included, need it) and trims memory via snapshot/version resets, not per-tombstone
GC. The live sub-decision is the **GC watermark**: when, if ever, it is safe to compact tombstones
given offline peers. See [architecture/storage-and-persistence.md](architecture/storage-and-persistence.md)
and [architecture/distributed-systems.md](architecture/distributed-systems.md). Height compensation
for the viewport is ours to write regardless. Depends-on: P0.

## 5. Height estimation for offscreen cameras

For the rendered pane you measure the DOM. For collaborators' (and offscreen cameras') positions you
work from estimated heights that drift. How much drift is acceptable before a re-anchor, and how to
correct it, is unresolved. Depends-on: P3, P6.

## 6. Managed vs self-hosted transport (constrained by single-authority-per-room)

`y-websocket` (self-host, simplest), Hocuspocus (self-host with lifecycle hooks), or a managed
backend (Liveblocks / PartyKit / Cloudflare Durable Objects). The distributed-systems research adds a
hard constraint: any real deployment needs **single-authority-per-room** (one process owns a
document's canonical `Y.Doc` at a time), or two writers clobber the store. Durable Objects give that
structurally; a plain `y-websocket`/Hocuspocus server must add a per-room lease with fencing tokens
and sticky routing (sticky alone leaves a split-brain window). For the two-localhost test (P3)
`y-websocket` is enough because there is one server. See
[architecture/distributed-systems.md](architecture/distributed-systems.md). Revisit before any real
multi-user deployment.

## 7. Buffer policy (attention-anchored editor)

Fixed 4/4 above/below buffers are the first cut. Velocity-weighted asymmetry (bias the buffer toward
scroll direction) is the refinement. When to graduate from fixed to velocity-weighted is open.
Depends-on: P6.
