# CONTEXT.md

_Last updated: 2026-07-25 01:45 · branch: main · session: landed Q1/Q2 + perf S1/S2; issue-first workflow adopted; starting perf S3_

## 1. What changed this session
- **PBT Q1** merged (#8): `src/doc/anchor.ts` (`resolveEffectiveAnchor`) extracted pure; `src/test/pbt/harness.ts` R1 determinism harness (neutralizes Math.random/Date/perf/crypto incl. getRandomValues for Yjs clientID; bans timers); `anchor.pbt.test.ts` 6 in-memory anchoring properties. fast-check 3.23.2 pinned exact.
- **PBT Q2** merged (#10): `src/test/pbt/distributed/convergence.pbt.test.ts` — N-replica Yjs network-adversary harness. 3 properties: [SEC] blocks+redirects co-converge, [commutativity] all replicas == canonical once-each replay, [anchor-under-concurrency] replica-0 merges the anchor away and every replica resolves the redirect to its predecessor. `j>=2` pins the redirect branch distinct from the top-fallback.
- **Perf S1** merged (#9): `src/layout/orderIndex.ts` — Fenwick-backed `OrderIndex` (id→index, prefix-height, findByOffset) + equivalence PBT vs `sumHeights`/`deriveAnchor`.
- **Perf S2** merged (#12, closes #11): `computeLayoutIndexed` / `windowForIndexed` in `layout.ts` (array originals untouched = oracle); `anchor.pbt.test.ts` equivalence property drives `ix` through structural ops in lockstep + probes edge branches.
- **Workflow:** adopted issue-first + PR `Closes #N`; deleted 8 stale merged branches; remote `feat/*` now clean. `delete-branch-on-merge` stays OFF (user choice) → branches pruned manually post-merge.

## 2. Decisions made and why
- **Naive layout/model functions are the frozen oracle** — every perf fix ships as a NEW fast path proven byte-equal to the untouched naive function by a fast-check property. No existing signature changes until Stage 4 wiring.
- **Q2 anchor property injects a real merge** — the earlier global `protectedId` made the anchor un-attackable (vacuous); replica-0 now genuinely merges it away so the redirect branch is exercised under concurrency.
- **Issue-first, manual branch prune** — `Closes #N` closes the issue, not the branch; auto-delete setting left off, so each stage deletes its own branch after merge.

## 3. What was tested and how
- `typecheck` clean · `vitest` **79/79** · full suite green. Q2 gate: inspector (6 findings, 2 blocking) → rewrite → adjudicator PASS (5 sabotage-then-revert teeth checks). Perf S2 gate: inspector (coverage gaps) → strengthened property → adjudicator PASS (5 sabotages all RED+reverted). Both auto-merged on green CI (typecheck/test/build + playwright).

## 4. Files needing attention
- `docs/plans/perf.md` — Stages 3–6 queued; S3 is the next step.
- Q1 debt (#12-task): harden windowFor/P2 teeth. S1 adjudicator debt (3 items) still unlogged.
- PS1/PS2 (PersonalServer C# side) still queued — cross-app receiver + `get_scroll_verdict`. Repos renamed: local `PersonalServer_ Recall_Seed`, remote `PersonalServer Recall-Seed`. A .NET context switch.
- Prior debt: registry `localStorage` unbounded (→P3); `playwright.config` `retries:2` masks flake.

## 5. Next step
Start **perf Stage 3** (`perf(doc): fast block locate in mutators via optional index`): give `setBlockText`/`insertBlockAfter`/`splitBlock`/`mergeIntoPrevious` in `src/doc/model.ts` an optional `at?: number` (default = current `indexOfBlock` scan), thread it through `src/dev/synthetic.ts`, and add `src/test/pbt/model.pbt.test.ts` proving the with-index and without-index docs are structurally identical (`blockViews` equal) over random op sequences. Open issue first, then adjudicator-gated PR with `Closes #<n>`.
