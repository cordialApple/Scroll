# CONTEXT.md

_Last updated: 2026-07-25 23:12 · branch: main · session: perf S5+S6 landed → full perf arc S1–S6 complete_

## 1. What changed this session
- **Perf S5 (#21, closes #20): heightsRef band eviction** — `evictHeightsOutsideBand` (`src/editor/docModel.ts`) bounds the measured-height cache to O(band): after settle, when `heightsRef.size > EVICT_TRIGGER` (2000), drop entries outside `[window.start-MARGIN, window.end+MARGIN]` (MARGIN 500), never the anchor. **Option Y**: touches ONLY `heightsRef` — `ix` keeps each evicted block's last effective height, so spacers are byte-unchanged and the camera cannot jump. `Editor.tsx` rewired so every camera-geometry consumer reads `ix` not `heightsRef`: `onScroll` fling fallback → `ix.findByOffset` (old `hm`/`deriveAnchor` path deleted); `devDriftCheck` drops the (intentionally divergent) `ix.totalHeight` compare, checks only `order` + `ixEst.totalHeight`. DEV seams `__scrollEvictTrigger`/`__scrollEvictMargin`. New `eviction.pbt.test.ts` + `eviction.spec.ts` e2e.
- **Perf S6 (#18, doc-only): gc:false tombstone decision** — audited; `createDoc()` stays `new Y.Doc({ gc: false })`. Decision note appended to `docs/plans/perf.md` with revisit-trigger table.
- **Full perf compute + memory arc S1–S6 now complete and merged.** Zero open issues on the board.

## 2. Decisions made and why
- **S5 Option Y (evict heightsRef only, leave ix)** — jump-free by construction: the camera is derived from `ix` spacer geometry, so as long as `ix` is untouched, eviction is invisible. Alternative (evict ix too / revert to estimate above anchor) would move spacers and force a re-pin correction — rejected as needless risk. Fable's midway pass caught the two consumers still reading `heightsRef` (fling fallback + drift check) that broke this invariant; both fixed.
- **S6 keep gc:false** — architecture makes it load-bearing (offline-peer merge, snapshots/version-restore, agent RelativePosition). Fable arbitrated: the flip is one-way, no future window where GC is both needed and safe; memory reclaimed instead via epoch-reset protocol.
- **fable is the adjudicator gate** — midway + final passes, iterate til PASS. On both S4 and S5 the midway pass caught real defects that green tests missed (S4 vacuous drift oracle; S5 post-eviction geometry hole).

## 3. What was tested and how
- `tsc` clean · `vitest` **85/85** (17 files) · `playwright` **9/9** incl. new `eviction.spec.ts` (scroll-away-and-return: eviction fires non-vacuously, fling-to-top resolves via `ix.findByOffset` to a near-start index, zero drift errors) + P0 anti-jump `milestone.spec.ts`. S5 sabotage teeth verified RED on anchor guard / absent guard / band bound (PBT) and on the fling fallback (e2e). Fable PASS.

## 4. Files needing attention
- **Perf plan is exhausted** — `docs/plans/perf.md` S1–S6 all landed. No perf stage queued.
- S4/S5 debt (fable, non-blocking): settle-cap `passes>=4` `setMeasured`-without-rerender (pre-S4 staleness class, not a regression); optional generator op for remote-batched text-edit+delete on one block to make array-first ordering empirically load-bearing.
- Q1 debt (harden windowFor/P2 teeth, #12); S1 adjudicator debt (3 items, #9) still unlogged.
- PS1/PS2 (PersonalServer C# side) queued — cross-app receiver + `get_scroll_verdict`. Repos: local `PersonalServer_ Recall_Seed`, remote `PersonalServer Recall-Seed`. A .NET switch. Task #7 in_progress.

## 5. Next step
Pick the next track (perf arc is done): the highest-leverage open item is **#7 P2-proper cross-app** — build the PersonalServer C# `get_scroll_verdict` receiver so Scroll's contract-6 callback POST (already shipped, #8) is consumed end-to-end. Alternatively clear the cheaper test-teeth debt (#12 windowFor / #9 S1 adjudicator) first. Confirm direction, then issue-first, fable-gated PR with `Closes #N`.
