# Feature consolidation QA — 2026-09-10

Integration branch: `codex/coalesce-features`, based on `origin/main` `3680932`.
Feature source: `feat/editor-ui-images-tabs-picker` `7f3dd5d`.

## Changes and regression fixes

Bring images, document tabs, picker, toolbar and menus together with current main. Fix concurrent tab creation/rename loss, image handling and nondefault-tab coverage in the proposal guard, tab-scoped dictation and undo, focused-block DOM reconciliation, and remote tab navigation updates.

Document picker HTTP API is local-only until authentication exists. Restrict caller, Host and Origin; bound body bytes; validate title and document ID. Shared document deletion is deferred: deleting stored rows alone cannot stop cached/offline replicas from restoring them. Remove its UI action and reject DELETE.

## Validation

- Typecheck passed.
- Initial pass: 33 focused unit tests passed. Three pre-existing skips pin deferred issue #63 awareness-hardening cases; they are not the PostgreSQL startup failure.
- 8 Chromium checks passed: tab editing/undo/dictation, camera insertion/growth, split/merge focus, programmatic endpoints and dictation anchoring.
- Initial full local unit run failed because PostgreSQL was unavailable; not a passing full-suite result. Required GitHub CI supplies PostgreSQL 16 and runs full unit, build and browser suites before merge.
- Simplifier completed on image components and regression fixes.

## Branch inventory

Only the editor branch contained a remaining feature delta. Aggregate patch comparisons matched existing main commits for P4.1 peer tokens, P4.2 ingress authorization, P5.1 dictation, Q2 convergence, order-index performance, P3.1 provider seam, P3.2 multiuser anchoring and P1 grading E2E branches. Those squash-merged branches need no code merge. References preserved.

Original checkout's untracked architecture/system-map and P7 planning documents were preserved. All integration edits and tests ran in an isolated worktree.

## Parallel review follow-up

Two independent inspectors reviewed tab edit preservation and the document-picker HTTP boundary. An adjudicator confirmed three merge blockers: stale dictation targets after tab switches, continued editing of a remotely removed tab, and unhandled store errors escaping Hocuspocus's HTTP listener. Warnings covered lost undo history, ignored editor titles, and previews exposing removed default-tab content.

The stronger claim that picker rename must update the editor title was dismissed: the PostgreSQL title is documented as a picker-only override. Title fallback now honors the Yjs editor title when no override exists.

API fixes have 13 passing tests, including a real Hocuspocus listener returning a bounded error during a simulated store outage and recovering on the next request. Five new cases were observed failing before the fixes. API follow-up inspector found no remaining issues in that scope. The combined API/model/dictation/spatial suite has 39 passing tests and the same 3 deferred #63 skips.

A separate worker fixed per-tab undo/redo history, stale dictation targets, live tab membership after remote removal, and invalid tab URLs. All four new browser regressions failed before fixes. Final browser run: 12 passed, covering those four plus eight earlier editor/voice/anchoring checks. Typecheck, build and diff check passed after simplifier. Both inspector lenses report no remaining findings in the repaired scopes. Final adjudication remains pending; full database QA is still required.

Publication remains pending explicit approval for the public cordialApple/Scroll destination. Automatic approval review blocked the earlier push; no remote code changes were made. Docker's Linux engine is still unavailable, so full PostgreSQL-backed unit/browser CI remains required before merge.

