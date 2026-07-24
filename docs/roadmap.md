# Scroll — roadmap

Phased build order, derived from [concept.md](concept.md). Each phase is a testable milestone. The
sequence is deliberately single-user first, then the endpoint seam, then a consumer, then multi-user,
then the AI angles.

## P0 — Single-user editor + relative-anchoring core

- Block-based document model with stable `blockId`s — app-level ids stored as block attributes,
  never Yjs internal ids, so anchors survive an epoch reset (see
  [architecture/distributed-systems.md](architecture/distributed-systems.md)).
- Scroll position stored as `{blockId, offsetWithinBlock}`, never a pixel value.
- `overflow-anchor: none`; pre-paint restore via `useLayoutEffect`.
- Anchor-centric virtualized layout: render window positioned from the anchor block outward, so
  estimated heights above never move the camera (see
  [architecture/relative-viewport-anchoring.md](architecture/relative-viewport-anchoring.md)).
- Yjs `Y.Doc` as the substrate even in single-user (so multi-user is additive, not a rewrite).
- Consumed-id redirect table so merges/deletions resolve anchors through the rename.

Milestone: with a synthetic op stream inserting content above the camera, the viewport does not
move — including with virtualized rendering and variable-height blocks. An unvirtualized pass proves
nothing about the shipped architecture.

## P1 — Endpoint spawners (doc-es, ide-es)

- `doc-es`: spawn a single-person prose surface.
- `ide-es`: `create_ide_es(schema)` (or "sl") spawns a single-person code surface from an attached
  schema (goal condition, problem, test-case + TLE, hints).
- Grader for ide-es: run hidden tests, enforce the TLE / complexity budget, resolve submission only
  on pass + within budget.

Milestone: a schema in produces a working, gradable IDE endpoint out.

## P2 — PersonalServer integration (programmatic seed)

- PersonalServer (Claude-only MCP) seeds an ide-es schema programmatically (baking in its own
  `resultCallbackUrl`) and gets back a spawn URL; on submit Scroll pushes the verdict to that callback
  (contract 6 in [architecture/boundaries.md](architecture/boundaries.md)). It does not run the
  editor.
- Degrade cleanly when Scroll is not running.
- See [integrations/personalserver.md](integrations/personalserver.md).

Milestone: Claude, in conversation, seeds a problem and hands back a unique Scroll IDE URL that
grades on submit.

## Q — Distributed-systems PBT in CI (cross-cutting quality track)

- Not a phase; runs alongside the P-line. **The spine:** Scroll's anchoring promise *is* a
  distributed-systems property — a user stays semantically anchored while other replicas concurrently
  mutate under an adversarial network. PBT (`fast-check`) enforces that on the shipped modules (the
  redirect table, the anchor resolver, the id model), not just in layout tests, because the hard bugs
  are state-evolution bugs across concurrency / reorder / partition, not pure-function bugs.
- Small and always-on inside the existing `verify` CI job (no nightly fuzzing farm): PR = fixed-seed
  short campaign; main push = heavier + run-number-seeded campaign that accrues a committed coverage
  ledger; failures dump a value-based `{initial, ops, expected, observed}` artifact promoted to a
  committed, seed-independent regression fixture and replayed.
- **AI-generated PBT is first-class but authoring-time only:** a model examines failure artifacts +
  diffs + generators offline and proposes new adversarial dimensions / generators / candidate
  invariants as committed deterministic artifacts; CI only replays them, never calls a model. Every
  AI artifact enters `@exploratory` and is adjudicator-gated (oracle soundness reviewed — an AI oracle
  never silently becomes source of truth) before it is load-bearing.
- Sub-track: **Q1** local anchoring property (generalize the P0 anti-jump e2e in-memory) → **Q2** the
  DS convergence spine (N in-memory Yjs replicas under a generated reorder/delay/duplicate/
  partition-heal schedule; SEC + causal consistency + anchor-under-concurrency) → **Q3** supporting
  families (virtualization/estimate-drift, `fc.commands` model-based, viewport-chaos) → **Q4** turn on
  AI-generated intake → **Q5** provider-chaos (real transport, gated behind P3). Each is an
  adjudicator-gated PR. See [plans/pbt-in-ci.md](plans/pbt-in-ci.md) and
  [architecture/distributed-systems.md](architecture/distributed-systems.md).

Milestone: a generated adversarial network schedule that breaks convergence or anchoring is a
minimized, seed-independent, replayable fixture.

## P3 — Multi-user mode (two localhost instances)

- Yjs room per document; `y-websocket` (or Hocuspocus) provider; awareness for presence.
- Test relative-anchoring viewport (rel anch vwprt) with two localhost instances on one laptop:
  edits above one camera must not move the other.
- One layout, N cameras: offscreen collaborators anchored identically to the rendered one.
- Persist with a Postgres snapshot + append-only update-log (persist-before-ack); keep the client
  `y-indexeddb` queue so a dropped write self-heals. See
  [architecture/storage-and-persistence.md](architecture/storage-and-persistence.md).
- `y-websocket` is fine here because there is one server; any real deployment needs
  single-authority-per-room (Durable Object or a lease). See
  [architecture/distributed-systems.md](architecture/distributed-systems.md).

Milestone: two browsers, concurrent edits above each viewport, neither screen jumps.

## P4 — STARfolio as a second user (AI interviewer reads the document)

- STARfolio joins as a second peer and reads the shared document.
- Open fork: native Scroll notepad / whiteboard surfaces for STARfolio to view, vs STARfolio adds
  them and provisions its own observability. See [integrations/starfolio.md](integrations/starfolio.md).
- Listening (reading the shared doc as a peer) is trivial once P3 works.

Milestone: STARfolio's AI interviewer observes a live Scroll session as a peer.

## P5 — App-native voice typing

- Voice typing built into Scroll (not borrowed from a consumer).

## P6 — Attention-anchored agent editor (native value prop)

- Residency (12 blocks per user: 4 visible, 4 above, 4 below), pinned-block immunity.
- Spatial guard (correctness) + LRU (prioritization) gates.
- Two decoupled agent loops (cheap observer, expensive actor with lease revalidation).
- Provenance rendering (authorship as color, derivation as gradient).
- See [architecture/attention-anchored-editor.md](architecture/attention-anchored-editor.md).

Milestone: an agent reorganizes cold regions of a document while no human viewport moves.

## Scoping reminder

- `ide_es` + `doc-es` are needed by P1 through P4 (single-user and multi-user-with-AI).
- P6 (attention-anchored AI editor) needs only `doc-es`, and per the OCP thesis may not need an
  endpoint at all. See [open-questions.md](open-questions.md).
