# CONTEXT.md

_Last updated: 2026-07-24 08:36 · branch: feat/p2-programmatic-spawn · session: P1 done+merged; P2 Scroll-side spawn-by-URL built + gated, opening PR #3_

## 0. Where things stand
- **main = `2352e9d`** (P1 spawners PR #1 + live-grading e2e PR #2, both merged & CI-green).
- **Stage 4 done on `feat/p2-programmatic-spawn`** — programmatic spawn-by-URL. Inspectors (security + routing) → adjudicator = PASS. Simplifier: no changes. Next: gated PR #3 → auto-merge.
- Loop rule (user): `adjudicator` gates every PR and any CI/e2e authoring. See memory `scroll-build-loop`.

## 1. What changed this session (Stage 4)
- `src/es/programmatic.ts` — base64url schema codec (`encodeSchema`/`decodeSchema`/`programmaticSpawnUrl`) with a 64KB payload cap.
- `src/es/factory.ts` — `create_endpoint(input)` kind-dispatch (validates before spawn).
- `src/es/SpawnView.tsx` + `#/es/new?s=<base64>` route in `App.tsx` — decode → validate → spawn → `location.replace` to `#/es/<id>` (replace, not push, so Back doesn't re-spawn).
- `src/es/schema.ts` — **security:** `entry.functionName` must match `/^[A-Za-z_$][A-Za-z0-9_$]*$/` (closes a `new Function` template-injection reachable now that schemas come from untrusted URLs — both the worker template and the seeded code stub).
- Launcher "Spawn via URL (sample)" button. Tests: `programmatic.dom.test.ts` (codec, dispatch, oversize, injection-adjacent), schema injection-guard test, `e2e/programmatic.spec.ts` (spawn→grade→Accepted, Back-no-respawn, garbage-payload error UI).

## 2. Decisions made and why
- **URL-encoded schema is the programmatic seam** — host-agnostic; a future C# MCP server just builds this URL. Scroll validates every field (rejectUnknown + identifier guard) before spawning; the URL path uses the exact same validators as the dev-console path (no weaker parallel path).
- **`location.replace` for the redirect** — avoids an orphan endpoint per browser-Back.

## 3. What was tested and how
- `typecheck` clean · `vitest` **49/49** · `playwright` **6/6** (P0 anti-jump, grading accept/wrong/TLE, programmatic spawn+grade / Back-no-respawn / garbage-payload) · `build` green.

## 4. Files needing attention
- Deferred debt (adjudicator, not blocking): registry `localStorage` grows unbounded (no eviction) → P3 persistence; `playwright.config` `retries:2` can mask flakiness; StrictMode not enabled (ran-ref already safe).
- Full **P2** (C# PersonalServer MCP that seeds a schema + builds a spawn URL + polls the result URL) remains a separate cross-app decision — Scroll side is now ready for it.

## 5. Next step
Open PR #3 (label `automerge`), let CI + auto-merge land it, then decide with the user whether to start P2-proper (C# MCP server — cross-app, needs direction) or a smaller in-repo stage (e.g. doc-es e2e, registry eviction, real caret/selection polish).
