# CONTEXT.md

_Last updated: 2026-07-24 08:20 · branch: test/p1-grading-e2e · session: P1 merged (PR #1); adding live-grading e2e (Stage 3)_

## 0. Where things stand
- **PR #1 merged to main** (`c795b15`): P1 endpoint spawners + CI + branch protection (required checks `typecheck / test / build` + `playwright e2e`) + auto-merge-on-green (no review, user-approved).
- **Stage 3 in progress** on `test/p1-grading-e2e`: `e2e/grading.spec.ts` — spawns a real ide-es endpoint, submits, asserts Accepted 4/4 / Wrong answer / TLE through the **real Web Worker**. Adjudicator = PASS. Next: gated PR → auto-merge.
- Workflow rule (user): `adjudicator` must gate every PR and any CI/e2e authoring. Loop: implement → inspectors → adjudicator → PR → CI → auto-merge → handoff.

## 1. What changed this session
- **P1 endpoint spawners shipped** (3 commits on `feat/p1-endpoint-spawners`, based on P0 `731567d`):
  - `ec1e2ee` — pinned wire schemas: `src/es/schema.ts` (types + versioned constants + dependency-free validators that now reject unknown keys) mirrored by `docs/contracts/{doc-es,ide-es}.v1.json`.
  - `22ccedd` — the spawner machinery: `factory.ts` (`create_doc_es`/`create_ide_es` → `{endpointId,url,resultUrl}`), `endpoint.ts` (endpoint state on its own `Y.Doc`: meta map + code `Y.Text` / prose blocks), `grader.ts` + `executor.worker.ts` + `workerExecutor.ts` (sandboxed per-test grading with hard TLE via `worker.terminate()`), `registry.ts` (localStorage index + result cache = the pollable result URL), views (`IdeEndpointView`/`DocEndpointView`/`ResultView`/`Launcher`/`EndpointRoute`), hash router in `App.tsx` (P0 `HomeDoc` preserved byte-for-byte).
  - `faeefda` — CI: `.github/workflows/ci.yml` (verify: typecheck/test/build + e2e: playwright), `auto-merge.yml`, `playwright.config.ts`, `e2e/milestone.spec.ts` (automates the P0 anti-jump browser check).
- **Remote created + main pushed:** public repo `github.com/cordialApple/Scroll`; `main` = P0.
- **Checkpoint run:** 4 inspectors (boundary, grader-TLE, Yjs-substrate/P0, React-lifecycle) → adjudicator = PASS-AFTER-FIXES. All blockers + warnings fixed (endpoint-route `key`, `mounted` submit guard, unknown-key rejection, unified `matchesExpected`, try/finally, write-once init). Simplifier pass applied.

## 2. Decisions made and why
- **Grader sandbox = in-browser Web Worker, per-test wall-clock TLE.** P1 is single-user in-browser; native oracle vetting/bank is a P2 concern (open-questions #3). The consumer authoring tests + grading themselves is harmless with no untrusted seeder yet.
- **Endpoint content lives in a per-endpoint `Y.Doc`** (`es-<id>`), substrate preserved for P3 multi-user; registry (localStorage) is only an index + result cache, not a content store.
- **Public repo** (user chose it over private) so CI-gated auto-merge can run; agent-initiated push required explicit user OK (classifier blocked the first attempt).
- **Deferred, tracked (NOT P1 gaps):** consumer-oracle vetting → P2; hidden-answers-in-doc privacy → P3; `programmatic` enforcement → P3/P4 (needs peer admission); contract-6 push callback → optional (pull path works).

## 3. What was tested and how
- `npm run typecheck` clean; `npx vitest run` **39/39** (schema 14, grader 5, endpoint 4, factory 4, + P0 12); `npm run build` green (worker bundles as its own chunk). Playwright milestone e2e verified green earlier by the CI agent locally (3× stable).
- Not yet run: CI on GitHub (no PR pushed yet); the ide-es grade path not yet exercised live in-browser this session (worker path covered by unit tests via a fake executor, not the real Worker).

## 4. Files needing attention
- Branch `feat/p1-endpoint-spawners` is committed but **not pushed**; PR not yet opened. CONTEXT.md is the only uncommitted file (this handoff).
- GitHub repo has no branch protection / required-checks yet — needed for auto-merge to actually gate.
- `IdeEndpointView` keeps a local `code` state with no CRDT observer (fine single-user; revisit at P3).

## 5. Next step
Commit this handoff, push `feat/p1-endpoint-spawners`, open a PR labeled `automerge`, enable repo auto-merge + required checks (`verify`, `e2e`), then set a wakeup to poll CI and squash-merge when green.
