# Feature consolidation QA — 2026-09-10

Integration branch: `codex/coalesce-features`, based on `origin/main` `3680932`.
Feature source: `feat/editor-ui-images-tabs-picker` `7f3dd5d`.

## Changes and regression fixes

Bring images, document tabs, picker, toolbar and menus together with current main. Fix concurrent tab creation/rename loss, image handling and nondefault-tab coverage in the proposal guard, tab-scoped dictation and undo, focused-block DOM reconciliation, and remote tab navigation updates.

Document picker HTTP API is local-only until authentication exists. Restrict caller, Host and Origin; bound body bytes; validate title and document ID. Shared document deletion is deferred: deleting stored rows alone cannot stop cached/offline replicas from restoring them. Remove its UI action and reject DELETE.

## Validation

- Typecheck passed.
- 33 focused unit tests passed; 3 existing DB-dependent skips.
- 8 Chromium checks passed: tab editing/undo/dictation, camera insertion/growth, split/merge focus, programmatic endpoints and dictation anchoring.
- Initial full local unit run failed because PostgreSQL was unavailable; not a passing full-suite result. Required GitHub CI supplies PostgreSQL 16 and runs full unit, build and browser suites before merge.
- Simplifier completed on image components and regression fixes.

## Branch inventory

Only the editor branch contained a remaining feature delta. Aggregate patch comparisons matched existing main commits for P4.1 peer tokens, P4.2 ingress authorization, P5.1 dictation, Q2 convergence, order-index performance, P3.1 provider seam, P3.2 multiuser anchoring and P1 grading E2E branches. Those squash-merged branches need no code merge. References preserved.

Original checkout's untracked architecture/system-map and P7 planning documents were preserved. All integration edits and tests ran in an isolated worktree.
