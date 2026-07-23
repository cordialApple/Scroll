# Scroll

Scroll is a document application built on **relative viewport anchoring**: a collaborative
editor where remote edits above your viewport never move your screen. It starts as a
single-user editor and grows into a multi-user, agent-aware workspace. It exposes its editing
surfaces as spawnable endpoints so external systems (PersonalServer, STARfolio) can drive them
without reaching into the native app.

This folder currently holds **planning documents only**. Nothing is built yet. The goal of these
docs is to preserve the full idea before implementation, so scope and sequencing survive.

## Two value propositions

1. **Relative viewport anchoring for multi-user documents** — a collaborative editor where remote
   edits above your viewport never move your screen. Google Docs, Confluence, and Overleaf transform
   the caret correctly through concurrent edits but do not transform the camera. Scroll anchors both.
   See [architecture/relative-viewport-anchoring.md](docs/architecture/relative-viewport-anchoring.md).

2. **Attention-anchored collaborative editor** — a document where the viewport is a lock. Users
   write, an agent reorganizes, and nobody's screen ever moves under them. This is the native app
   value prop, an offshoot of the anchoring primitive.
   See [architecture/attention-anchored-editor.md](docs/architecture/attention-anchored-editor.md).

## The endpoint-spawner model

Scroll can spawn single-person editing endpoints on demand. Endpoint spawning is a feature exposed
in the app itself.

- **doc-es** — document endpoint spawner (prose editor).
- **ide-es** — IDE endpoint spawner (code editor) with **schema attachability**, spawned by a
  `create_ide_es` function or similar spawn logic (referred to as "sl").

Programmatic consumers (starting with PersonalServer) do not run the editor. They **seed the schema**
(goal condition, problem, test-case + TLE budget, hints, and so on) and let Scroll spawn the endpoint.

See [architecture/endpoint-spawners.md](docs/architecture/endpoint-spawners.md).

## Thesis (unproven)

PersonalServer and STARfolio should control **endpoints**, not Scroll's native app processes. The
endpoint-spawner seam exists for Open/Closed adherence: consumers extend Scroll by driving endpoints,
not by modifying the app. This is a design bet, not a proven fact. It is recorded as such in
[open-questions.md](docs/open-questions.md).

## Documents

- [concept.md](docs/concept.md) — the full vision and how the pieces relate.
- [roadmap.md](docs/roadmap.md) — the phased build order.
- [architecture/endpoint-spawners.md](docs/architecture/endpoint-spawners.md) — doc-es, ide-es, schema attachability, the OCP seam.
- [architecture/relative-viewport-anchoring.md](docs/architecture/relative-viewport-anchoring.md) — value prop 1, mechanism, hard parts, substrate.
- [architecture/attention-anchored-editor.md](docs/architecture/attention-anchored-editor.md) — value prop 2, residency, guards, agent loops, provenance.
- [architecture/boundaries.md](docs/architecture/boundaries.md) — the interface contracts between Scroll and its consumers: dependency direction, peer protocol, spawn schema, programmatic Strategy, grader trust boundary, and a review checklist.
- [architecture/distributed-systems.md](docs/architecture/distributed-systems.md) — the hard core: guarantees, failure modes, single-authority-per-room, GC safety, the agent as a peer, pre-answered reviewer questions.
- [architecture/storage-and-persistence.md](docs/architecture/storage-and-persistence.md) — how a Y.Doc persists single-user to multi-user, compaction, durability rules.
- [architecture/whiteboard.md](docs/architecture/whiteboard.md) — build-vs-buy for the STARfolio whiteboard (Konva+Yjs vs Excalidraw vs tldraw).
- [integrations/personalserver.md](docs/integrations/personalserver.md) — programmatic schema seeding via ide-es.
- [integrations/starfolio.md](docs/integrations/starfolio.md) — STARfolio as a second user and AI interviewer.
- [architecture/sample-implementation.md](docs/architecture/sample-implementation.md) — illustrative diagrams (structure + two flows) with the contracts on the edges.
- [open-questions.md](docs/open-questions.md) — the forks and unproven theses.
- [fable-review-brief.md](docs/fable-review-brief.md) — the adversarial-review prompt to hand to Fable.
