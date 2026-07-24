# CONTEXT.md

_Last updated: 2026-07-24 23:10 · branch: main · session: P2 S1+S2 merged; PBT plan v2 (DS spine + AI-gen); starting Q1_

## 1. What changed this session
- **S1 (contract-6 callback)** merged (`ce45c73`, PR #4): `src/es/notify.ts` fire-and-forget POST of
  `ResultPayload` to `resultCallbackUrl` on submit; http(s)-guarded, backoff + per-attempt 5s abort,
  swallow-all; called after the durable local write in `IdeEndpointView.tsx`.
- **S2 (wire-shape golden vectors)** merged (`508c961`, PR #6): `docs/contracts/result-payload.v1.json`
  + `src/es/result-payload.golden.json` + `resultPayload.golden.test.ts` (7 tests) pin the payload
  byte-for-byte (JSON key order, exact key-set, consumer-blindness = `cases` dropped, tle>error
  precedence, contract-derived bounds). `e2e/callback.spec.ts` asserts exact keys on the real POST.
- **PBT plan v2** (`docs/plans/pbt-in-ci.md`, 693 lines, fable): distributed-systems value prop is the
  spine; AI-generated PBT is first-class (authoring-time only, CI replays committed artifacts).
- `docs/roadmap.md` Q-track rewritten to the DS spine + AI-gen + Q1→Q5 sub-track.

## 2. Decisions made and why
- **Consumer-minted `resultCallbackUrl` carries correlation; push not poll** — endpoint id is
  browser-minted, so the consumer bakes its own loopback URL and Scroll pushes the verdict. Payload =
  `ResultPayload` only (pass/fail/counts); Scroll stays consumer-blind.
- **Callback SSRF accepted as intended contract-6 design** (S1 adjudicator) — non-sensitive payload,
  Submit-gated; scheme-guard blocks non-http(s).
- **Anchoring is a distributed-systems property, tested on shipped modules** (user directive) — PBT
  centers on convergence + anchor-under-concurrency via the redirect table / anchor resolver / id
  model, network modelled as a fast-check adversary.
- **AI never decides pass/fail and CI never calls a model** — AI proposes generators/invariants
  offline as committed deterministic artifacts; `@exploratory` + adjudicator oracle-soundness review
  before load-bearing (mirrors the ide-es grading-trust rule).

## 3. What was tested and how
- `typecheck` clean · `vitest` **62/62** · `playwright` **8/8** · `build` green (re-run after each
  stage's adjudicator fixes). S1 gate: simplifier → 2 inspectors → adjudicator PASS-WITH-FIXES.
  S2 gate: inspector (golden fidelity) → adjudicator PASS (blocking wire-assertion gap closed).

## 4. Files needing attention
- S1 debt (deferred): doc-es allows `resultCallbackUrl` but never fires it (decide inert vs reject);
  `submit()` has no `catch` around `grade()`; add callback-URL trust boundary to a contract-6
  promotion checklist.
- Prior debt: registry `localStorage` unbounded (→P3); `playwright.config` `retries:2` masks flake.
- **PS1/PS2 (PersonalServer C# side) still queued** — the cross-app receiver + `get_scroll_verdict`
  tool in `C:\Users\randl\Documents\GitHub\PersonalServer_`. Not started; a context switch to .NET.

## 5. Next step
Start **PBT Q1** (per user's DS-PBT steer, in-repo): extract the effective-anchor fallback from
`Editor.tsx` (~114–120) into a pure `src/doc/anchor.ts`, add `fast-check` (pinned exact) + the R1
determinism harness, and land the first in-memory anchoring property (generalize the P0 anti-jump
e2e: generated op sequences insert/delete above/inside/below the camera; oracle = the anchor still
resolves to the same logical content). Adjudicator-gated PR.
