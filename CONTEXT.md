# CONTEXT.md

_Last updated: 2026-07-27 · branch: main (P6.4 landed, PR #67 merged) · session: P6 attention-anchored agent editor — autonomous stage loop_

## 1. What changed this session (P6.1 → P6.4, all merged)
- **P6.1 (#59, `5b22ea2`) — above-camera measure lag fixed.** `Block.tsx` sync a non-focused block's `innerText` in `useLayoutEffect` (before paint) → an above-camera programmatic grow no longer drift the camera. Load-bearing for P6 (an agent edit above the human caret is this exact flow).
- **P6.2 (#61, `9e65c93`) — spatial guard predicate + grace tracker (pure).** `src/agent/spatialGuard.ts` `guardedBlocks(input): Set<string>`; band ASYMMETRIC `[A-buffer, A+(visibleBlocks-1)+buffer]` (anchor = viewport TOP, visible span run DOWNWARD; defaults 4/4/120_000ms). Fail closed: awareness outage / unplaceable camera → guard all; pinned always; grace ~2min. `guardTracker.ts` `trackCameras` grace reducer.
- **P6.3 (#62, PR #64, `4f994be`) — commit-time spatial `ProposalGuard` at the authority.** `server/agent/spatialProposalGuard.ts` `createSpatialProposalGuard()`. `liveCameras` map awareness cameras via order+redirect; UNPLACEABLE → raw id → fail closed (NEVER `order[0]`). Signature = id+type+text DELTA; `guardedSpansIntact` = structural per-field compare over each guarded run. `proposeCommit.ts` widened ctx (awareness+now), `performance.now()` clock. Default-on (P4.5-safe).
- **P6.4 (#65, PR #67, `150db40`) — agent observer + cold-region LRU (pure selection).** `src/agent/coldScheduler.ts` LRU `selectNext`/`markWorked` (never-worked first, LRU, seeded from cold[0] so non-empty cold never null). `src/agent/observer.ts` `observe({order, remotes, prevTracked, lru, now, awarenessKnown, pinned?, config?}) → {targetId, cold, tracked}` — fold grace, `coldBlocks` (same predicate the authority enforce), select. Fail closed: awareness unknown → null target. `spatialGuard.ts` export `resolveGraceMs` (single grace source). PBT rebuilt with an INDEPENDENT oracle (recompute guarded from raw inputs, never from observe's own tracked) — teeth mutation-verified.

## 2. Decisions and why
- **Enforce at COMMIT, at the authority.** The single-threaded room authority evaluate the guard against the AUTHORITATIVE doc, closing the check-then-act race. Op-grain refuse.
- **Belt + suspenders.** Agent picks cold (`coldBlocks`, P6.4) = BELT; authority re-checks at commit (`guardedBlocks`, P6.3) = SUSPENDERS, for the race where a reader moved in after the agent read.
- **Fail closed everywhere.** null awareness / unplaceable camera / awareness outage → guard whole doc; dropped reader keeps band for `graceMs`.
- **Default-on but LATENT in prod.** Prod `server/index.ts` set no `authenticate` → proposal refused PRE-guard. Auth primitives (`mintPeerToken` CAP_PROPOSE, `createPeerAuthenticator`, `resolveRoomConfig`/`grantCaps`) ALL EXIST and are wired in `peerMilestone.test.ts` (P4.5). What's missing is the AGENT DRIVER that uses observe()+propose(), and a test that publishes a human camera to PROVE the guard enforces.

## 3. Tested / gated
- **240 pass / 3 skip**, tsc 0. 3 skips are honest pins: 1× #66 (P6.4 agent laundering) + 2× #63 (P6.3 server awareness-freshness).
- Each stage gated: simplifier → 4 parallel `inspector`s (one lens each) → `adjudicator` (sabotage-verifies, renders determination) → fix → re-adjudicate → PR (`automerge` label) → CI green → auto-merge. P6.2/6.3/6.4 all landed PASS-WITH-CARRYFORWARD after a first-pass BLOCK fixed + re-adjudicated (P6.4 BLOCK was a tautological safety oracle — rebuilt independent).

## 4. Carry-forward (adjudicator-logged, non-blocking, all LATENT — no live proposer yet)
- **P6.5 driver (#66)** — [F-02, GATING] agent must resolve cameras NON-launderingly from the redirect table (it fold via laundered `RemoteCamera.anchor` → `order[0]` for a vanished block → under-guard that reader's region; authority's `liveCameras` do it right). Pinned by skipped `observer.test.ts` case (fail-closed on laundered camera) — un-skip once the driver resolves right. Also [F-06] bundle `{tracked, lru}` into `ObserverState`; [F-07] `awarenessKnown ← peer.provider.awareness != null` (the fail-closed trigger).
- **Server guard hardening (#63)** — [F-04] continuous awareness observer (fold every awareness change, not just at proposal); [F-05] reconnect-gap empty-vs-unknown awareness + grace keyed by room name; [F-06] proposer self-exclusion. 2 skipped server tests.
- **Prior debt:** [I3-F2] shared-pool Postgres flake (green when DB up), [I3-F6] `sinkSocketError` private-`webSocket` cast.

## 5. Next step — P6.5
**P6.5 — the native agent driver (headless), closing #66.** The agent that actually reorganizes cold regions:
- `resolveCameras(remotes, order, redirects) → ObservedCamera[]` — non-laundering, mirror the authority's `liveCameras` (#66 F-02). Un-skip the observer pin.
- `observe()` refactor → `ObserverState {tracked, lru}`, take resolved cameras (#66 F-06).
- `attentionAgent(peer, {actor?, config?})` driver over `HeadlessPeer`: tick = snapshot→order, resolve cameras (peer.cameras() + redirects from `provider.document`), `awarenessKnown = provider.awareness != null` (#66 F-07), observe, propose actor(target) via `peer.propose`, markWorked. A minimal deterministic reorganization actor.
- Tested headlessly (fake peer — deterministic, no Postgres flake).

Then **P6.6** — milestone e2e (real server + human camera + agent → prove the guard ENFORCES: cold commits, camera-band refuses; DE-LATENT the guard) + provenance rendering (which blocks the agent touched) → **P6 CLOSE** (last phase).

Program status board (refreshed at phase boundaries): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2 — stale (still show P5); bump to P6 4/6 landed at next refresh.
