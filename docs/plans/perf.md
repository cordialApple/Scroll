# Runtime performance plan

Turns the runtime-perf findings into staged, adjudicator-gated, PR-sized changes. The current
implementation is **sound-but-O(n)**: the anchor-centric virtualization bounds the *DOM*
(`windowFor` renders O(viewport) nodes) but not the *arithmetic* — `computeLayout` sums heights
across the whole doc, `indexOf`/`indexOfBlock` scan linearly, and `Editor.tsx` rebuilds `order` +
`estimates` for the entire doc on every keystroke. Fine to ~1–2k blocks, sluggish ~10k, falls
over ~100k — which matters because `docs/architecture/relative-viewport-anchoring.md` targets
"multi-year documents". `Y.Doc({ gc: false })` is a separate memory ceiling that grows with edit
history regardless of size.

## Non-negotiable oracle

Every stage must keep these green **byte-for-byte** — they are the behavior spec:

- **Q1 PBT anchoring properties** — `src/test/pbt/anchor.pbt.test.ts`: round-trips over
  `computeLayout` / `deriveAnchor` / `windowFor` / `resolveEffectiveAnchor`.
- **P0 anti-jump e2e** — `e2e/milestone.spec.ts`: "insert above the camera does not move the top
  block".
- `typecheck` / `vitest` / `build` / `playwright` all green.

**Method that makes this safe:** the existing pure functions in `src/layout/layout.ts`
(`computeLayout`, `windowFor`, `deriveAnchor`, `sumHeights`) and `src/doc/model.ts`
(`indexOfBlock`, `blockOrder`) are **never deleted and never change signature**. They become the
**reference oracle**. Each optimization ships as a *new* fast path whose only correctness
guarantee is a fast-check property asserting it returns results identical to the naive function
for random docs + mutations. Properties are the spec; the naive function is the spec's executable
form.

## Shared substructure — `src/layout/orderIndex.ts` (new, Stage 1)

One structure serves all three fixes (id→index for `model.ts` + `Editor.tsx`, prefix-height for
`layout.ts`). It holds, per block, position and current effective height, with aggregate subtree
sums so every query is O(log n).

```ts
export interface OrderIndex {
  size(): number
  indexOf(id: string): number                 // -1 if absent  ≡ order.indexOf(id)
  idAt(index: number): string | undefined
  prefixHeight(count: number): number          // ≡ sumHeights(order, hm, 0, count)
  heightBefore(id: string): number             // ≡ prefixHeight(indexOf(id))
  totalHeight(): number                        // ≡ sumHeights(order, hm, 0, length)
  findByOffset(px: number): { id: string; offset: number }   // ≡ deriveAnchor(px, order, hm)
  insertAfter(afterId: string | null, id: string, height: number): void  // O(log n)
  remove(id: string): void                                                // O(log n)
  setHeight(id: string, height: number): void                            // O(log n)
  order(): string[]                            // O(n), oracle/debug only
}

export function buildOrderIndex(order: string[], heightOf: (id: string) => number): OrderIndex
```

- **Backing:** an order-statistics balanced tree (treap or AVL) with each node carrying
  `{ subtreeCount, subtreeHeight }`. A plain Fenwick is **insufficient** — structural insert/delete
  renumbers indices, which is O(n) on a fixed array; the tree makes insert/delete O(log n) too.
  *Acceptable first cut:* back it with an array + lazily-rebuilt Fenwick (point `setHeight`
  O(log n), structural op O(n) rebuild) since text edits dominate keystrokes and rarely change
  structure — the `OrderIndex` interface is stable, so the backing can upgrade to a treap later
  without touching any consumer. Profiling decides if/when.
- **Effective height:** the index stores one height per block. The owner (Editor) calls
  `setHeight(id, measured ?? estimate)` whenever either changes — the index never knows about the
  measured-vs-estimate distinction, keeping `layout.ts`'s `heightOf` semantics intact.
- **`findByOffset` must match `deriveAnchor` exactly**, including the "return last block when
  target ≥ total" and "clamp negative target to 0" branches (`layout.ts` `deriveAnchor`). The
  Stage-1 property is what forces that.

`layout.ts` and `model.ts` consume it through **new indexed variants**, never by changing existing
signatures:

```ts
// src/layout/layout.ts  — added, existing computeLayout/windowFor/deriveAnchor untouched
export function computeLayoutIndexed(ix: OrderIndex, window: Window, anchor: Anchor): LayoutResult
export function windowForIndexed(ix: OrderIndex, anchor: Anchor, viewportH: number, overscan: number): Window
```

## Stage sequencing (dependency order)

Ranked by impact I gave: (#1) kill per-keystroke O(n) rebuild, (#2) id→index + prefix-sum, (#3)
memory. But #1 *consumes* #2's structure, so the shared substructure lands first, proven correct
in isolation, then wired into the read paths, then the high-risk Editor rewrite, then memory.

Each stage is independently landable and revertible. Stages 1–2 change **no runtime behavior**
(pure additions + equality proofs), so the oracle passes trivially; risk concentrates in Stage 4.

---

### Stage 1 — `feat(layout): add OrderIndex order-statistics structure`

**Files:** `src/layout/orderIndex.ts` (new), `src/test/pbt/orderIndex.pbt.test.ts` (new),
`src/test/orderIndex.test.ts` (new unit).

**Change:** implement `OrderIndex` + `buildOrderIndex` per the API above. Wired into **nothing** —
pure additive module.

**Verify / PBT hook** (`orderIndex.pbt.test.ts`): generate a random `order` + random height map
(reuse Q1 generators), build the index, then assert against the naive `src/layout/layout.ts`
functions for random queries and after random `insertAfter`/`remove`/`setHeight` sequences:

- `ix.indexOf(id) === order.indexOf(id)`
- `ix.prefixHeight(k) === sumHeights(order, hm, 0, k)` for all k
- `ix.totalHeight() === sumHeights(order, hm, 0, order.length)`
- `ix.findByOffset(px)` deep-equals `deriveAnchor(px, order, hm)` for random px incl. negative and
  beyond-total
- after each mutation, `ix.order()` equals the naively-maintained array

**Invariant that must not regress:** none touched at runtime; Q1 + P0 pass unchanged because no
call site changed. This is the immediately-implementable start.

---

### Stage 2 — `perf(layout): indexed computeLayout/windowFor/deriveAnchor behind OrderIndex`

**Files:** `src/layout/layout.ts` (add `computeLayoutIndexed`, `windowForIndexed`; existing
signatures untouched), `src/test/pbt/anchor.pbt.test.ts` (extend).

**Change:** add indexed variants that use `ix.prefixHeight` / `ix.indexOf` / `ix.findByOffset`
instead of the whole-doc `sumHeights` walks and `order.indexOf`. Still **not wired into Editor** —
this stage only lands the proven-equal fast path.

**Verify / PBT hook:** extend `anchor.pbt.test.ts` — for a random doc/anchor/window,
`computeLayoutIndexed(ix, window, anchor)` deep-equals `computeLayout(order, hm, window, anchor)`,
and `windowForIndexed(...)` equals `windowFor(...)`. This is the behavior-preservation proof for
the read path.

**Invariant:** the existing Q1 round-trips still call the naive functions and still pass; the new
equality property extends the spec. No runtime path changed yet.

---

### Stage 3 — `perf(doc): fast block locate in mutators via optional index`

**Files:** `src/doc/model.ts` (`setBlockText`, `insertBlockAfter`, `splitBlock`,
`mergeIntoPrevious` gain an optional `at?: number` / index-lookup param, default = current
`indexOfBlock` scan), `src/dev/synthetic.ts` (`insertAbove`/`deleteAbove` accept the index),
`src/test/pbt/model.pbt.test.ts` (new).

**Change:** the O(n) `indexOfBlock` inside each mutator becomes a fallback; callers holding an
`OrderIndex` pass the resolved index. Signatures stay backward-compatible (new param optional), so
every current caller and every existing test keeps working.

**Verify / PBT hook** (`model.pbt.test.ts`): for random op sequences, the doc produced by the
mutator-with-index is structurally identical (`blockViews` equal) to the mutator-without-index —
the fast locate changes nothing but speed.

**Invariant:** `blockOrder` / `blockViews` outputs unchanged; redirect table writes unchanged
(the merge+redirect same-transaction atomicity in `model.ts` lines ~122–137 is untouched).

#### Stage 3b (2026-07-25): wire the caller side — hot-path Editor callbacks pass the hint

Stage 3 gave the mutators the `at?` fallback but only the imperative-handle ops (`insertAbove`/
`deleteAbove`/`mergeAnchorAway`) passed it. The per-keystroke `onEdit`/`onSplit`/`onMerge` still called
in with no hint, so `resolveBlockIndex` fell through to the O(n) `indexOfBlock` scan on **every**
keystroke — the exact cost Stage 3 exists to kill. Fix: the callbacks read `modelRef.current.ix.indexOf(id)`
(O(1) map lookup on the live index) and pass it as `at`; `resolveBlockIndex` still verifies it, so a
stale hint is corrected, never trusted. Teeth: `src/test/perfLocate.test.ts` spies the `Y.Array` instance's
`get` and asserts a valid hint touches O(1) slots while no hint scans O(n) (sabotage of the short-circuit
→ hinted count jumps to N, RED). Structural insert/remove staying O(n) inside `OrderIndex.rebuild` is the
deliberate first-cut noted above (text edits ≫ structural changes); a treap upgrade to O(log n) structural
ops is the remaining, optional follow-up (issue #27) — **landed, see Stage 7 below**.

### Stage 7 (2026-07-25): `perf(layout): treap-backed OrderIndex — O(log n) structural insert/remove` (#27)

Closes the last O(n) in the hot path. `buildOrderIndex` now returns a `TreapOrderIndex`: an implicit
(position-keyed) order-statistics treap, balanced by an FNV-1a + murmur3-fmix32 hash of the id (deterministic
— survives the PBT entropy freeze — and ~2.4·log2(n) deep in practice). Split/merge by rank, no rotations;
parent pointers let `indexOf` walk up to a rank and `setHeight` repair `sumH` upward, both O(log n). One
semantic shift: `indexOf` moves O(1)→O(log n); every consumer is fine with it and the Stage 3b write-path
hint still verifies-then-trusts. `ArrayOrderIndex` is retained as the **differential oracle**. Teeth: a
differential PBT pins treap ≡ array across every method after random op sequences (sabotaging `setHeight`'s
upward repair → RED); a balance test caps depth at 4·log2(N) (flattening priorities to a path → RED). The
structural cost only bit near the ~100k-block ceiling per op, so this is completeness, not a felt fix.

---

### Stage 4 — `perf(editor): incremental order/estimates from Yjs delta` **(highest risk)**

**Files:** `src/editor/Editor.tsx` (replace the `[doc, version]` full-rebuild memo, lines ~90–102,
and thread the `OrderIndex`), `src/test/pbt/editorState.pbt.test.ts` (new, headless).

**Change:** today `observeDeep → forceRender` (lines 76–84) invalidates a `useMemo` that loops the
entire `Y.Array` and rebuilds `order` + a full `estimates` `Map` **per keystroke** (O(n) alloc).
Replace with an incremental consumer: the `observeDeep` callback reads the Yjs delta and

- on structural insert/delete: `ix.insertAfter` / `ix.remove` and splice the maintained `order`;
- on text change: recompute only that block's `estimateHeight` (`src/layout/estimate.ts`) and
  `ix.setHeight(id, measured ?? newEstimate)`;

so a keystroke is O(log n) + O(1), not O(n). Editor then reads layout via
`computeLayoutIndexed`/`windowForIndexed` (Stage 2). The `useLayoutEffect` measure/settle loop and
`heightsRef` are unchanged here except that measuring a block also calls `ix.setHeight`.

**Why highest risk:** the delta→order/estimates mapping must reproduce the full-rebuild result
*exactly*. `observeDeep` on a `Y.Array<Y.Map>` with nested `Y.Text` emits events for both array
structure and text edits; correctly translating inserts/deletes/moves and text-length deltas into
index mutations is subtle, and a drift bug is silent (wrong estimate → wrong spacer → camera
creep, exactly the P0 failure mode).

**How the properties de-risk it** (`editorState.pbt.test.ts`, headless, no browser): drive a real
`Y.Doc` with random op sequences (insert/delete/split/merge/edit above/inside/below the anchor),
feeding each mutation through the incremental consumer, and after **every** op assert:

- `incrementalOrder === blockOrder(doc)` (the naive full scan) — the exact drift oracle;
- `ix.prefixHeight(k) === sumHeights(blockOrder(doc), hmFromEstimates, 0, k)` for all k;
- `resolveEffectiveAnchor(incrementalOrder, redirectSource(doc), anchor)` equals the same computed
  from the naive order — ties directly to Q1.

Plus a **dev-only invariant check**: behind a flag, run the full rebuild every N mutations and
assert equality with the incremental state, so any escaped drift trips in development. The P0
anti-jump e2e remains the end-to-end oracle. Ship this stage only when all three green.

**Invariant:** P0 anti-jump byte-for-byte; Q1 round-trips unchanged; typing latency drops from
O(n) to O(log n) per keystroke (the headline win).

---

### Stage 5 — `perf(editor): evict heightsRef outside a band`

**Files:** `src/editor/Editor.tsx` (`heightsRef` maintenance in the settle effect).

**Change:** `heightsRef` (line 68) currently never evicts — it retains a measured height for every
block ever rendered, growing monotonically over a long scroll session. Add band eviction: after
settle, drop measured entries whose `ix.indexOf(id)` is outside
`[window.start - MARGIN, window.end + MARGIN]` (MARGIN generous, e.g. 500 blocks each side, so
re-entry doesn't thrash). **Never evict** the current window+overscan or the anchor block; on
re-entry a dropped block falls back to `estimateHeight` then re-measures — identical to a
first-ever visit.

**Verify:** unit test that eviction never removes an in-window/anchor id; P0 e2e (scroll far, come
back) shows no jump. PBT: `heightOf` after eviction+re-measure equals the pre-eviction measured
value for the same rendered content.

**Invariant:** anchor stability across scroll-away-and-return; memory bounded to O(band), not
O(blocks-ever-seen).

---

### Stage 6 — `docs(perf): gc:false tombstone-growth ceiling + compaction options`

**Files:** this doc / a decision note. **Doc-only for now** — no code, because the choice depends
on what actually consumes tombstones.

**The ceiling:** `createDoc()` uses `Y.Doc({ gc: false })` (`src/doc/model.ts` line 17). Tombstones
are retained forever, so memory grows with **total edit history**, not current size — the real
"multi-year document" ceiling, orthogonal to block count.

**Key honest finding:** Scroll's current anchor does **not** depend on tombstones surviving. The
camera is `{ blockId, offset }` with app-level ids (`src/doc/ids.ts`) resolved through the
`redirects` `Y.Map` (`src/doc/redirects.ts`), **not** a Yjs `RelativePosition`. So the usual reason
to keep `gc:false` (RelativePosition anchors must resolve through deleted content) does not yet
apply. `gc:false` is currently more conservative than the anchoring model requires.

**Options + tradeoffs:**

| Option | Mechanism | Tombstone cost | Anchor risk | When |
|---|---|---|---|---|
| A. Enable GC (`gc:true`) | let Yjs collect deleted items | eliminated | **None today** (anchors are app-level ids + redirects, not RelativePosition) — but re-check before any future caret/selection built on `RelativePosition`; those would break under GC | Cheapest; viable now if the audit in this stage confirms nothing reads tombstones |
| B. Periodic snapshot + re-encode | on idle, `encodeStateAsUpdate` → fresh `Y.Doc`; optionally keep a `Y.Snapshot` for history | eliminated per compaction | Same as A — plus any live `RelativePosition` is invalidated at compaction | If some history/undo needs bounded retention |
| C. Keep `gc:false`, cap retention | segment the doc / archive cold regions (ties to P6 residency) | bounded by window | Anchors into archived regions need the redirect/rehydrate path | Largest; only if A/B insufficient |

**Recommended:** land an **audit task** first — grep for `RelativePosition` / any tombstone
consumer; if none (expected today), Option A is a one-line change gated by a PBT that random
edit+delete sequences still converge and anchors still resolve after GC. Revisit when caret/selection
lands on `RelativePosition` (then B or C). This stage produces the decision + the audit; the code
change is a follow-up stage once the audit confirms safety.

#### Decision (2026-07-25): keep `gc: false` — Option A rejected

**Call:** `gc: false` stays (`src/doc/model.ts` line 17). The audit ran and confirmed the code is
tombstone-clean — the only hit for `RelativePosition|snapshot|tombstone|gc` in `src/` is the flag
itself; anchors are app-level ids resolved via `redirects`, not `Y.RelativePosition`. Option A is
therefore *safe today* and still wrong:

1. **The ceiling and the constraint arrive together.** Tombstone growth only bites on multi-year
   docs; those require persistence; persistence arrives with the multi-user/agent architecture
   ([distributed-systems.md](../architecture/distributed-systems.md)) where `gc: false` is
   load-bearing — snapshots/version-restore require it, GC + offline peers is data-loss failure mode
   #4, agent stale-position writes (#8) need `Y.RelativePosition`, and all peers of a room must share
   one GC policy. There is no future window where GC is both needed and safe.
2. **The flip is one-way.** GC policy is decided per-document at creation and never flipped for an
   existing history ([storage-and-persistence.md](../architecture/storage-and-persistence.md), GC
   rule 2). Docs created under `gc: true` in the interim could never safely serve version history.
3. **Product commitment:** the distributed-systems posture is embedded, not optional.

**Supersedes** this stage's earlier "Option A viable now" recommendation, which was scoped to the
single-client in-memory snapshot and did not weigh the DS invariants. The lifetime-memory answer is
the **epoch reset protocol**; Option B in the table above is its degenerate single-peer form (idle
`encodeStateAsUpdate` → fresh doc; app-level block ids carried verbatim, so anchors survive by
construction) and is the approved follow-up.

**Revisit triggers:**

| Trigger | Action |
|---|---|
| Serialized doc (`Y.encodeStateAsUpdate` bytes) crosses ~50 MB, or persistence lands (DO authority cap ~128 MB makes it exact) | Build single-peer epoch reset (Option B) |
| Owner explicitly drops version history + offline peers + agent positioning | Only then reconsider `gc: true` |

## Risk summary

- **Stages 1–3 are low-risk:** pure additions and optional params, each fronted by an equality
  PBT against the untouched naive oracle; the runtime path is unchanged until Stage 4 wires it.
- **Stage 4 is the one to watch:** incremental delta handling can silently drift and manifest as
  camera creep — the exact P0 failure. It is de-risked by (a) the per-op `incrementalOrder ===
  blockOrder(doc)` property, (b) the dev-only periodic full-rebuild equality check, (c) Q1 +
  the P0 e2e as end-to-end oracles. Do not merge without all green.
- **Stage 6 is honest scope control:** the memory ceiling is real for multi-year docs, but the
  fix is cheap *if* the tombstone audit confirms nothing depends on `gc:false` — which the current
  app-level-id anchoring suggests. Decide before building.

**What the first two land buys:** Stages 1–2 + 4 together move the per-keystroke and per-frame cost
from O(n) to O(log n), shifting the usability cliff from ~10k blocks out past ~100k. Stage 5 bounds
session memory; Stage 6 addresses the lifetime-of-doc memory axis. Stages 1–3 share one structure
(`OrderIndex`) and are the enabling work; Stage 4 is where the user feels it.

## Start here

**Stage 1** is fully self-contained: create `src/layout/orderIndex.ts` implementing the `OrderIndex`
interface (array+lazy-Fenwick backing is fine to start), plus `src/test/pbt/orderIndex.pbt.test.ts`
proving it equal to `sumHeights`/`indexOf`/`deriveAnchor` for random docs and mutation sequences.
It touches no existing file, so Q1 and P0 pass unchanged — implementable immediately, revertible
cleanly.
