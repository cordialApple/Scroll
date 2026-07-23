# Scroll — roadmap

Phased build order, derived from [concept.md](concept.md). Each phase is a testable milestone. The
sequence is deliberately single-user first, then the endpoint seam, then a consumer, then multi-user,
then the AI angles.

## P0 — Single-user editor + relative-anchoring core

- Block-based document model with stable `blockId`s.
- Scroll position stored as `{blockId, offsetWithinBlock}`, never a pixel value.
- `overflow-anchor: none`; pre-paint restore via `useLayoutEffect`.
- Yjs `Y.Doc` as the substrate even in single-user (so multi-user is additive, not a rewrite).
- Consumed-id redirect table so merges/deletions resolve anchors through the rename.

Milestone: with a synthetic op stream inserting content above the camera, the viewport does not move.

## P1 — Endpoint spawners (doc-es, ide-es)

- `doc-es`: spawn a single-person prose surface.
- `ide-es`: `create_ide_es(schema)` (or "sl") spawns a single-person code surface from an attached
  schema (goal condition, problem, test-case + TLE, hints).
- Grader for ide-es: run hidden tests, enforce the TLE / complexity budget, resolve submission only
  on pass + within budget.

Milestone: a schema in produces a working, gradable IDE endpoint out.

## P2 — PersonalServer integration (programmatic seed)

- PersonalServer (Claude-only MCP) seeds an ide-es schema programmatically and receives a spawned
  endpoint URL. It does not run the editor.
- Degrade cleanly when Scroll is not running.
- See [integrations/personalserver.md](integrations/personalserver.md).

Milestone: Claude, in conversation, seeds a problem and hands back a unique Scroll IDE URL that
grades on submit.

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
