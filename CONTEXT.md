# CONTEXT.md

_Last updated: 2026-07-27 · branch: main (P6.3 landed, PR #64 merged) · session: P6 attention-anchored agent editor — autonomous stage loop_

## 1. What changed this session (P6.1 → P6.3, all merged)
- **P6.1 (#59, `5b22ea2`) — above-camera measure lag fixed.** The §4 carry-forward from P5. `Block.tsx` now sync a non-focused block's `innerText` in `useLayoutEffect` (before paint), so the Editor's `useLayoutEffect` re-measure see a fresh height → an above-camera programmatic grow no longer drift the camera. Plus a focused split/merge blur reconcile. Load-bearing for P6 (an agent edit above the human caret is exactly this flow).
- **P6.2 (#61, `9e65c93`) — spatial guard predicate + grace tracker (pure, no wiring).**
  - **`src/agent/spatialGuard.ts`** — pure fail-closed predicate. `guardedBlocks(input): Set<string>` from order + cameras + pinned. Band is ASYMMETRIC `[A-buffer, A+(visibleBlocks-1)+buffer]` because the camera anchor is the viewport TOP and the visible span run DOWNWARD (defaults visibleBlocks=4, buffer=4, graceMs=120_000). Fail closed: awareness outage → guard all; unplaceable camera → guard all; pinned always; grace keeps a dropped camera's band ~2min.
  - **`src/agent/guardTracker.ts`** — `trackCameras(prev, live, now, graceMs)` grace reducer (last-write-wins per clientId).
  - Architecture doc reconciled: band asymmetry justified (anchor = viewport top).
- **P6.3 (#62, PR #64, `4f994be`) — commit-time spatial `ProposalGuard`, enforced at the authority.**
  - **`server/agent/spatialProposalGuard.ts`** — `createSpatialProposalGuard(): ProposalGuard`. Per-room grace tracker (WeakMap by doc), folded each proposal. `liveCameras` map awareness cameras through order+redirect; an UNPLACEABLE camera → raw id → fail closed (never `order[0]`). Block signature = `id + type + text DELTA` (`toDelta`), catches mark/embed edits. `guardedSpansIntact` = STRUCTURAL per-field compare over each maximal guarded run (length guard + element-wise), no delimiter.
  - **`server/db/proposeCommit.ts`** — `ProposalGuardCtx` widened with room `awareness` + `now`; authority clock `performance.now()` (monotonic).
  - **`server/hocuspocus.ts`** — guard default-on. A room with no published camera guard nothing → behavior-compatible with the old allow-all (P4.5-safe).

## 2. Decisions and why
- **Enforce at COMMIT, at the authority.** contract-1 seam. The single-threaded room authority evaluate the guard against the AUTHORITATIVE doc, closing the check-then-act race a proposer's read-time check can't. Op-grain refuse (no teardown).
- **Fail closed, everywhere.** null awareness (unknown peer set), unplaceable camera (block hard-deleted no redirect), awareness outage → guard the whole doc. A dropped reader keeps their band for `graceMs` (network-blip immunity).
- **Signature = text DELTA, structural compare.** Not `toString()` (would miss marks/embeds) and not a string join (a delimiter byte was a bug — a literal NUL made the file binary). Per-field element-wise over each guarded run.
- **Default-on but LATENT.** Prod `server/index.ts` set no `authenticate` → `peerFromContext` null → a proposal is refused PRE-guard. So the guard evaluate zero real proposals today; every fail-open is latent until P6.4 wires an authenticated `CAP_PROPOSE` agent. This is why the deep awareness-freshness holes defer to P6.4.

## 3. Tested / gated
- **225 pass / 2 skip** (the 2 skips are honest P6.4 pins, verified to FAIL if un-skipped). typecheck 0.
- Each stage gated: simplifier → parallel `inspector`s (one lens each) → `adjudicator` (sabotage-verifies, renders the determination). P6.2 and P6.3 both landed **PASS-WITH-CARRYFORWARD** after a first-pass BLOCK (P6.2: symmetric band; P6.3: NUL bytes) fixed + re-adjudicated.
- P6.3 sabotage-proven: flip `toDelta`→`toString` reddens the formatting test; flip unplaceable→`order[0]` reddens the fail-closed test.

## 4. Carry-forward (adjudicator-logged, non-blocking)
- **Guard hardening → P6.4 (#63)** — all LATENT (no prod proposer yet):
  - **F-04** continuous awareness observer: the tracker fold only at proposal time → a reader who move A→B with no intervening proposal then drop is remembered at stale A. Fix = per-room awareness `update` observer.
  - **F-05** reconnect-gap fail-open: a reloaded room present a fresh EMPTY awareness, indistinguishable from "no readers" → a proposal in the gap commit. Fix = empty-vs-unknown signal + grace keyed by room NAME not doc identity.
  - **F-06** proposer self-exclusion (liveness, not safety): an agent that publish its own camera near where it propose would refuse itself. Fix = actor never publish a camera, or guard exclude the proposer's clientId.
  - Both safety holes (F-04/F-05) pinned by skipped tests that FAIL un-skipped.
- **Still open from prior phases:** [I3-F2] shared-pool flake (P4 infra debt), [I3-F6] `sinkSocketError` private-`webSocket` cast in `headlessPeer.ts`.

## 5. Next step — P6.4
**P6.4 — the authenticated agent + cap policy + agent loops.** The counterparty that makes the guard load-bearing:
- `resolveRoomConfig` / `grantCaps` — wire an `authenticate` path that grant an agent `CAP_PROPOSE` (propose-only; never `CAP_WRITE`).
- Agent observer/actor loops — observer read cold regions; actor propose reorganizations via the propose/commit path (refused if it hit a live camera band).
- LRU prioritization over residency (which cold region to work first).
- Fold in #63's F-04/F-05/F-06 (they finally have the machinery to integration-test against).

Then **P6.5** (provenance rendering — show which blocks an agent touched) and **P6.6** (milestone e2e → P6 CLOSE, the last phase).

Program status board (single source of truth, refreshed at phase boundaries): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2 — stale (still show P5 building); bump to P6 3/6 landed at the next refresh.
