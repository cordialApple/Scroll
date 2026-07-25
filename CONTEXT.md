# CONTEXT.md

_Last updated: 2026-07-25 02:36 · branch: main · session: perf S1–S4 landed (O(n)→O(log n) compute win complete); Q1/Q2 done_

## 1. What changed this session
- **Perf S1–S4 all merged** — the full compute-axis fix from `docs/plans/perf.md`:
  - S1 (#9): `src/layout/orderIndex.ts` Fenwick `OrderIndex`.
  - S2 (#12, closes #11): `computeLayoutIndexed`/`windowForIndexed` (array originals = frozen oracle).
  - S3 (#14, closes #13): `resolveBlockIndex` verified optional `at?` hint in `model.ts` mutators + `synthetic.ts`.
  - **S4 (#16, closes #15): `src/editor/docModel.ts` incremental Yjs-delta consumer replaces Editor's per-keystroke O(n) rebuild.** Keystroke now O(log n)+O(1). Two indices: `ix` (effective=measured??estimate) for layout, `ixEst` (estimate-only) for the estimate-stable render window. `Editor.tsx` reads layout via the indexed twins; `setMeasured` on DOM measure; doc-swap subscription guard; dev-only `devDriftCheck`.
- **PBT Q1 (#8) + Q2 (#10)** merged earlier this session (anchoring properties; N-replica convergence + anchor-under-concurrency).
- **Workflow hardened:** issue-first + PR `Closes #N`; branches pruned manually post-merge (auto-delete off, and GitHub auto-close isn't firing here → close issues manually). 8 stale branches cleaned; remote `feat/*` empty.

## 2. Decisions made and why
- **Frozen-oracle method** — every perf fix is a NEW fast path proven byte-equal to the untouched naive function by a fast-check property; runtime path only changed at S4 wiring, which composes (incremental==rebuild) ∘ (indexed==array) ⇒ render output unchanged.
- **S4 two-index split** — window must stay estimate-stable (not shift as DOM measurements arrive), so `ixEst` is estimate-only and `setMeasured` touches only `ix`. Preserves pre-S4 windowing exactly.
- **fable is the adjudicator gate now** (user directive) — ran passes until approval. Fable's 1st-pass FAIL on S4 caught the drift oracle being vacuous on `ixEst` (uniform block heights → trivial prefix-sum equality); fixed with height variance + direct `order()` equality, re-verified teeth, 2nd-pass PASS.

## 3. What was tested and how
- `tsc` clean · `vitest` **84/84** (16 files) · `vite build` clean · `playwright` **8/8** incl. P0 anti-jump (`milestone.spec.ts`). Each stage adjudicator-gated by sabotage-then-revert teeth checks; S4 by fable across two passes.

## 4. Files needing attention
- `docs/plans/perf.md` — Stages 5 (heightsRef band eviction) and 6 (gc:false audit) remain; both memory-axis, lower urgency than the compute win now landed.
- S4 debt (fable, non-blocking): settle-cap `passes>=4` calls `setMeasured` without re-render (pre-S4 staleness class, not a regression); optional generator op applying a remote-batched update (text-edit + delete same block in one `Y.applyUpdate`) to make the array-first event ordering + delete guard empirically load-bearing.
- Q1 debt (harden windowFor/P2 teeth, #12-task); S1 adjudicator debt (3 items) still unlogged.
- PS1/PS2 (PersonalServer C# side) queued — cross-app receiver + `get_scroll_verdict`. Repos: local `PersonalServer_ Recall_Seed`, remote `PersonalServer Recall-Seed`. A .NET switch.

## 5. Next step
Perf **Stage 5** (`perf(editor): evict heightsRef outside a band`): `heightsRef` never evicts, so it grows with every block ever rendered. Add band eviction after settle — drop measured entries whose `ix.indexOf(id)` is outside `[window.start - MARGIN, window.end + MARGIN]` (MARGIN ~500), NEVER evicting the window+overscan or the anchor. Watch the jump-risk: evicting an ABOVE-anchor block reverts its height (measured→estimate), changing spacers — must trigger a hold-correction re-pin so the anchor doesn't move, and needs a NEW scroll-away-and-return e2e (current `milestone.spec.ts` doesn't cover return). Issue-first, fable-gated PR with `Closes #N`.
