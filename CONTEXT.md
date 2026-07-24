# CONTEXT.md

_Last updated: 2026-07-24 23:00 · branch: main · session: P2 Stage S1 merged; S2 + PBT track queued_

## 1. What changed this session
- **S1 (contract-6 callback) merged to main as `ce45c73` (PR #4, CI-green, auto-merged).**
- `src/es/notify.ts` (new) — `notifyResult(schema, payload)`: fire-and-forget POST of `ResultPayload`
  to `schema.resultCallbackUrl`; http(s)-guarded, 3 attempts, exponential backoff, per-attempt 5s
  `AbortSignal.timeout`, swallow-all-errors.
- `src/es/IdeEndpointView.tsx` — `void notifyResult(schema, payload)` after the durable local write
  (`recordVerdict`/`setResult`), so delivery is independent of local truth.
- `src/es/schema.ts` — shared `isHttpUrl` guard; `resultCallbackUrl` (when present) must be http(s).
- Docs + pinned JSON contracts moved from a poll model to the push/callback model; contracts gained
  `pattern: ^https?://`.
- `docs/plans/pbt-in-ci.md` (new, fable) — staged plan for property-based testing in CI.
- `docs/roadmap.md` — folded in cross-cutting **Q — PBT-in-CI** track.

## 2. Decisions made and why
- **Consumer-minted `resultCallbackUrl` carries correlation** — the endpoint id is browser-minted, so
  a consumer (PersonalServer) cannot poll by id; it bakes its own loopback URL into the schema and
  Scroll pushes the verdict on submit. Keeps Scroll consumer-blind (payload = `ResultPayload` only).
- **Fire-and-forget, never surfaces to user** — an unreachable consumer must not break grading; local
  verdict is the durable truth.
- **Callback-URL SSRF flag accepted as intended contract-6 design** (adjudicator) — payload is
  non-sensitive (pass/fail/counts) and delivery is Submit-gated; standing rule: payload stays
  non-sensitive. Scheme guard blocks javascript:/data:/file:/protocol-relative.
- **PBT via fast-check, node-only, inside existing `verify` job** — zero new CI infra, no nightly farm.

## 3. What was tested and how
- `typecheck` clean · `vitest` **55/55** · `playwright` **8/8** (incl. new `callback.spec.ts`:
  intercepts cross-origin POST incl. CORS preflight, asserts exact `ResultPayload`; asserts no POST
  when no callback url) · `build` green. All re-run after adjudicator's two fixes.
- Quality gate: simplifier → 2 inspector lenses (blind delivery; url injection/exfil) → adjudicator
  **PASS-WITH-FIXES**.

## 4. Files needing attention
- S1 adjudicator debt (deferred, non-blocking): (a) doc-es allows `resultCallbackUrl` but never fires
  it — decide inert-by-design vs reject; (b) `submit()` has no `catch` around `grade()` (throwing
  grader silently no-ops); (c) add callback-URL trust boundary to a contract-6 promotion checklist.
- Prior debt: registry `localStorage` unbounded (→P3); `playwright.config` `retries:2` can mask flake.
- `docs/plans/pbt-in-ci.md` — plan only, not implemented; Q1 extracts effective-anchor fallback from
  `Editor.tsx` (~114–120) to a pure `src/doc/anchor.ts` first.

## 5. Next step
Start **Stage S2** — golden-vector fixtures pinning the contract-6 `ResultPayload` wire shape (a
committed JSON fixture + a test asserting `toResultPayload` output matches it byte-for-byte, so the
consumer contract can't drift silently) — on a new branch, adjudicator-gated, then PR with `automerge`.
