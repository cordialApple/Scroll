# Property-based testing in CI

Staged plan for bringing property-based testing (PBT) into Scroll's normal CI. Derived from the
three idea notes (`scroll-pbt-dev.md`, `pbt-scroll.txt`, `pbt-ci.txt`): the hard bugs here are
state-evolution bugs across interacting systems (doc mutations, remote edits, viewport, layout,
virtualization), not pure-function bugs — and the product promise (relative-viewport anchoring)
is itself a property, not a test case. Design constraints taken from the notes and kept:

- **Always-on inside normal CI.** No nightly fuzzing farm, ever. Value is state-space coverage,
  not volume.
- **Deterministic seeds, always replayable.** A failure must become a committed regression
  fixture, not a shrug.
- **Small budget.** Per-PR campaign in seconds, main-push campaign in low minutes.
- **Semantic oracle, never pixels.** The invariant is "the user is still looking at the same
  logical content", asserted against the pure model — not screenshots, not scrollTop values.

## 0. Thesis — anchoring is a distributed-systems property

Scroll's value proposition is a **distributed-systems** one, and it is **embedded in Scroll
itself**, not merely asserted by tests. The product promise — "a remote user inserting content
above your viewport never moves your screen, and you stay anchored to the same logical content" —
is a statement about *concurrent replicas converging while each replica's viewport intent is
preserved*. That is convergence + causal consistency + a per-replica anchor invariant, i.e. a
distributed-systems property, not a layout detail. See
[`docs/architecture/distributed-systems.md`](../architecture/distributed-systems.md) and
[`docs/architecture/relative-viewport-anchoring.md`](../architecture/relative-viewport-anchoring.md).

So this plan is organized with **distributed-systems invariants as the spine** (§5A), not a late
add-on. The single-replica anchoring properties (§3) are the *local projection* of those
invariants — the smallest thing to land first — but the center of gravity is: N in-memory Yjs
replicas, a fast-check-generated **network adversary** (reorder / delay / duplicate / drop-resync
/ partition-heal), and the **anchor-under-concurrency** invariant. The invariants are enforced by
**shipped modules** the PBT exercises directly — the redirect table (`src/doc/redirects.ts` +
the `Y.Map` in `src/doc/model.ts`), the anchor resolver (`resolveEffectiveAnchor`, extracted in
§3.1), and the id model (`src/doc/ids.ts`, app-level ids that survive epoch resets). PBT proves
those modules *are* the convergence mechanism; it does not bolt correctness on from outside.

A second first-class mechanism, not an afterthought: **AI-generated PBT embedded in CI** (§8) —
AI authors generators, adversarial dimensions, and candidate invariants **offline**, emitting
**committed, deterministic** artifacts that CI replays by value. CI never calls a model; the AI is
an adversarial researcher whose output is gated before it becomes load-bearing.

## 1. What already exists (the implicit invariants)

The repo already states its invariants — as examples. PBT generalizes them; almost no new
concepts are needed.

| Existing example-based test | Implicit invariant to generalize |
|---|---|
| `e2e/milestone.spec.ts` "insert above the camera does not move the top block (P0 anti-jump)" — one fixed scenario: seed 400 blocks, scroll 45%, insert 50 above | **For any doc, any anchor, any mutation sequence that never touches the anchor block, the resolved anchor still identifies the same content and its screen position (in the layout model) is unchanged** |
| `src/test/layout.test.ts` "deriveAnchor is the exact inverse of computeLayout scrollTop" — fixed 100-block order, offsets `[0,10,25]`, one height model | Round-trip law for **all** orders, height models (measured/estimate mixes), and in-range offsets |
| `src/test/layout.test.ts` "windowFor keeps the anchor inside the returned window", "contentHeight covers the whole document" | Same laws, arbitrary inputs |
| `src/test/redirects.test.ts` cycle-guard tests | `resolveRedirect` terminates, is idempotent, and never resolves to a consumed id, for **arbitrary** redirect maps including cycles |
| `docs/architecture/relative-viewport-anchoring.md`: "estimated heights above … can never move the anchor under the camera" | Anchor screen position is a function of **measured** window content only — perturbing estimates outside the window changes `topSpacer`/`contentHeight` but never `scrollTop − anchorOffsetTop` relationships for rendered blocks |

The pure substrate for all of this already exists and is browser-free:

- `src/layout/layout.ts` — `computeLayout`, `deriveAnchor`, `windowFor`, `heightOf` (pure).
- `src/doc/model.ts` — Yjs ops: `insertBlockAfter`, `appendBlock`, `splitBlock`,
  `mergeIntoPrevious`, `setBlockText`, `blockViews`, on `Y.Doc({ gc: false })`.
- `src/doc/redirects.ts` — `resolveRedirect` (pure).
- `src/dev/synthetic.ts` — seeded `insertAbove`/`deleteAbove` (already deterministic via LCG).

One gap: the effective-anchor fallback (anchor gone → redirect → first block) lives inline in
`src/editor/Editor.tsx` (`effAnchor` memo, lines ~114–120). Stage 1 extracts it to a pure
function so the property tests exercise the *shipped* resolution logic, not a copy.

## 2. Library choice and integration

**fast-check** (plain, not `@fast-check/vitest`). Reasons:

- De facto standard TS PBT library; integrated shrinking; replay via `{ seed, path }`;
  `fc.commands` for model-based testing later; zero transitive baggage.
- Plain `fc.assert(...)` inside ordinary vitest `it()` blocks means **zero runner changes**:
  `vite.config.ts` test block, `npm test`, and the CI `verify` job all stay untouched. PBT files
  are just more `src/test/**/*.test.ts` files running in the default `node` environment (no
  happy-dom needed — nothing here touches the DOM).
- `@fast-check/vitest` adds a wrapper API for little gain; a 30-line local helper gives us the
  seed/env/artifact behavior we actually want (see §4).

Install: `npm i -D fast-check` (pin exact — see §7 R2). That is the entire new infrastructure.

New files (Stage 1):

```
src/test/pbt/pbt.ts                 seed/runs config + failure-artifact wrapper + purity guard
src/test/pbt/ops.ts                 op ADT + arbitraries + interpreter onto Y.Doc
src/test/pbt/anchoring.pbt.test.ts  first property family
src/test/pbt/regressions/           committed failure fixtures (JSON), replayed every run
src/test/pbt/coverage-ledger.json   committed per-property cumulative coverage (see §7 R4)
```

## 3. Stage 1 — the first property: generalized P0 anti-jump, in-memory, no browser

PR-sized, adjudicator-gated, implementable immediately.

### 3.1 Refactor (tiny, behavior-preserving)

Extract from `Editor.tsx` into `src/doc/anchor.ts`:

```ts
export function resolveEffectiveAnchor(
  order: string[],
  redirects: RedirectSource,
  anchor: Anchor,
): Anchor
```

Exactly the current `effAnchor` logic: present in order → unchanged; else follow
`resolveRedirect`; else `{ blockId: order[0], offset: 0 }` (empty order → `{ '', 0 }`).
`Editor.tsx` calls it. This is the system-under-test seam.

### 3.2 The op language (generator)

Ops are **data first, interpreted second** — this is what makes shrinking and replay artifacts
work (a shrunk counterexample is a smaller op list, and the JSON artifact is the op list).
Positions are expressed **relative to the anchor**, not as raw indices, so every generated op is
meaningful for the invariant and shrinks stay meaningful:

```ts
type Op =
  | { kind: 'insertAbove'; count: number; seed: number }
  | { kind: 'insertBelow'; count: number; seed: number }
  | { kind: 'deleteAbove'; count: number }
  | { kind: 'deleteBelow'; count: number }
  | { kind: 'editOther'; rel: number; seed: number }
  | { kind: 'largePaste'; where: 'above' | 'below'; blocks: number; seed: number }
  | { kind: 'reformat'; rel: number; toType: BlockType }
  | { kind: 'splitOther'; rel: number; at: number }
  | { kind: 'mergeOther'; rel: number }
```

- `insertAbove/Below` reuse `src/dev/synthetic.ts` (`insertAbove`, `deleteAbove`) plus a mirror
  `insertBelow`/`deleteBelow` helper; text comes from the existing seeded `pseudoText` LCG, so
  content is deterministic given the op's `seed` field.
- `largePaste` is `insertAbove/Below` with `blocks` in `[50, 500]` — the "large paste" case from
  the idea notes.
- `reformat` flips a non-anchor block's `type` (`paragraph`/`heading`/`quote`) via a small
  `setBlockType` helper — changes `estimateHeight` output, i.e. a layout-shift op with no
  content change.
- `editOther`/`splitOther`/`mergeOther` target `anchorIdx + rel` clamped into range, **skipping
  the anchor block itself** (the anchor-touching cases are a separate property, §3.4).
- The interpreter applies ops to a real `Y.Doc` from `createDoc()` via `src/doc/model.ts` /
  `src/dev/synthetic.ts` — the shipped mutation code, not a reimplementation.

Initial state generator: doc of `fc.integer({min: 3, max: 300})` blocks (seeded texts, mixed
types), anchor = uniformly chosen block id + `fc.nat` offset within its estimated height.

### 3.3 The oracle: "what content should the user still be looking at"

Captured **before** the op sequence runs:

```ts
interface Expectation {
  anchorId: string
  anchorText: string
  following: string[]
}
```

`following` = texts of the next K (≈3) blocks — the anchor plus its local context is the
semantic "place" the user is at, per the idea notes ("anchor = function compileQuery, local
context = surrounding lines").

### 3.4 The assertions

Property A — **anchor identity survives non-anchor mutations** (the generalized anti-jump):

- run ops; compute `order' = blockOrder(doc)`,
  `a' = resolveEffectiveAnchor(order', redirectSource(doc), a0)`
- assert `a'.blockId === a0.blockId`, `a'.offset === a0.offset`
- assert `blockViews(doc)` at `a'.blockId` has text `=== anchorText` if no `editOther` hit rel 0
  after clamping (the generator guarantees this by construction, so assert unconditionally)

Property B — **no camera movement in the layout model** (the pixel-free anti-jump):

- define `screenTop(id) = cumHeightBefore(id) − layout.scrollTop` from
  `computeLayout(order, hm, windowFor(...), anchor)` with heights = `estimateHeight` of each
  block (pure, deterministic)
- for ops **strictly above** the anchor: `screenTop(anchorId)` before === after, and every
  rendered block at/after the anchor keeps its `screenTop`
- for ops **strictly below** the anchor window: `layout.scrollTop` unchanged

Property C — **anchor death redirects, never teleports to top** (generalizes
`redirects.test.ts` + the merge path): a sequence ending in `mergeIntoPrevious(anchorId)` must
resolve to the merge successor (`redirects` chain), the successor's text must end with the
anchor's original text, and resolution must be idempotent
(`resolve(resolve(a)) === resolve(a)`).

Property D — **layout laws, generalized** (absorbs `layout.test.ts` intent): for arbitrary
order/height-model/window/anchor: `deriveAnchor(computeLayout(...).scrollTop) === anchor` when
offset < anchor height; `contentHeight` = total; anchor index ∈ `[window.start, window.end)`
from `windowFor`.

Property B is the smallest single most valuable one if the stage must shrink further; A+B
together are the honest generalization of the P0 e2e and still one small PR.

### 3.5 Stage 1 exit criteria

- `npm test` green locally with default budget (≤ ~15s added).
- Properties fail loudly when sabotaged (verify during development by e.g. breaking
  `resolveEffectiveAnchor`'s redirect fallback — a mutation-test smoke check, done manually,
  not in CI).
- No changes to `ci.yml` yet — the tests already run inside the existing `verify` job.
  (Per the build-loop rule, any later CI edit is adjudicator-gated.)

## 4. Seed determinism and failure-replay artifacts

### 4.1 Determinism contract

- `src/test/pbt/pbt.ts` reads `PBT_SEED` (default: a fixed committed constant, e.g. `202607`)
  and `PBT_RUNS` (default 100 locally) and applies them via each `fc.assert` call's
  `{ seed, numRuns }`. Same seed ⇒ same generated cases ⇒ PR runs are byte-deterministic.
- Known hazard, accepted: `src/doc/ids.ts` uses `Math.random()`/`Date.now()`, so **block ids
  differ across runs**. All properties are therefore id-*relational* (compare identities
  captured during the run, never literal id strings), and artifacts store the **op script + the
  fc seed/path**, never concrete ids. No production change needed. (Contrast: `src/es/factory.ts`
  already injects `now` — the codebase precedent for determinism-by-injection if ids ever need
  it.)
- No `Date.now`/`performance.now` in any property or interpreter. Everything runs in vitest's
  `node` environment; no timers, no DOM, no async — enforced by the purity guard (§7 R1), which
  is what keeps flakiness structurally impossible in this layer.

### 4.2 Failure artifact

The `pbt.ts` wrapper around `fc.assert`:

1. On failure, writes `test-results/pbt/<property-name>.failure.json`:

```json
{
  "property": "anchor-survives-non-anchor-mutations",
  "seed": 202607,
  "path": "0:1:1",
  "numRuns": 100,
  "counterexample": { "initial": { "blocks": 42, "anchorIdx": 17, "offset": 12 },
                       "ops": [ { "kind": "largePaste", "where": "above", "blocks": 213, "seed": 9 } ] },
  "expected": { "anchorId": "<relational: idx 17 at t0>", "anchorText": "…", "following": ["…"] },
  "observed": { "resolvedIdx": 0, "text": "…" }
}
```

2. Rethrows, so vitest fails normally and fast-check's own seed/path message is in the log.

CI surfacing: add one step to the existing `verify` job in `.github/workflows/ci.yml`
(mirroring the e2e job's existing pattern):

```yaml
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: pbt-failures
    path: test-results/pbt/
    retention-days: 7
```

### 4.3 Failure → committed regression fixture

- Local replay: `PBT_SEED=<seed> npm test -- anchoring` reproduces exactly; fast-check shrinks
  to the minimal op list automatically.
- To pin it forever: drop the artifact JSON (or its shrunk `counterexample`) into
  `src/test/pbt/regressions/`. A loader in `anchoring.pbt.test.ts` globs that directory and
  replays every fixture **as an explicit example, not by seed** (§7 R2) — so regressions run on
  every PR at zero seed-budget cost and survive fast-check upgrades.
- This is the "random discovery → deterministic debugging → permanent bug report" loop from the
  idea notes, with the fixture living in-repo under normal review.

## 5. Property families → stages

Two-part structure. **§5A is the spine: distributed-systems invariants** — the product value
prop, tested against the shipped convergence modules. §5B are the supporting families. Each
stage is one adjudicator-gated, PR-sized unit that fits the existing loop
(implement → inspectors → adjudicator → PR → CI green → auto-merge). Stage 1 is the smallest
first landing (the *local projection* of the spine); Stage 2 raises the distributed-systems
harness itself and is the plan's center of gravity — not a late add-on.

### 5A. The distributed-systems spine

#### The network adversary (the harness)

The core test object is **N in-memory Yjs replicas + a fast-check-generated network schedule**.
No server, no provider, no wall-clock — a schedule is *data*, so it shrinks and replays like any
other fixture. Model:

```ts
type Replica = 'A' | 'B' | 'C'
type NetEvent =
  | { kind: 'localOp'; replica: Replica; op: Op }           // §3.2 Op, applied locally
  | { kind: 'deliver'; from: Replica; to: Replica; updateIdx: number }  // ship one pending update
  | { kind: 'reorder'; replica: Replica }                   // permute this replica's inbox
  | { kind: 'duplicate'; from: Replica; to: Replica; updateIdx: number }
  | { kind: 'drop'; from: Replica; to: Replica; updateIdx: number }     // never delivered…
  | { kind: 'resync'; from: Replica; to: Replica }          // …until a full state-vector sync heals it
  | { kind: 'partition'; a: Replica; b: Replica; heal: boolean }
```

Updates are captured with `Y.encodeStateAsUpdate` / diffed via state vectors and applied with
`Y.applyUpdate`; `resync` uses `Y.encodeStateVector` + `Y.encodeStateAsUpdate(doc, remoteSV)` so
a partition always heals to convergence. A generated schedule ends with a **quiescence drain**
(deliver every outstanding update, no drops) so the convergence assertions have a well-defined
final state. This harness is the fast-check embodiment of the idea notes' "reorder / delay /
duplicate / duplicate messages" network model.

#### Distributed-systems invariants (asserted by the harness, enforced by shipped modules)

| Invariant | Assertion | Shipped module it exercises |
|---|---|---|
| **Strong eventual consistency (SEC)** | any two replicas that have applied the same *set* of updates (order-independent) have identical `blockViews` and identical `redirects` map | `src/doc/model.ts` (`blocks` `Y.Array`, `redirects` `Y.Map`), Yjs |
| **Commutativity / associativity / idempotence** | applying updates in any generated permutation, with arbitrary duplication, yields the same state as canonical order; re-applying a delivered update is a no-op | update-application path in the interpreter over `model.ts` |
| **Causal consistency** | an update is only *observed* after its causal deps (Yjs enforces via state vectors); a `deliver` of an update whose deps are absent is a no-op until `resync` — assert no replica ever shows an effect whose cause it hasn't seen | Yjs delivery + `resync` path |
| **Conflict-resolution determinism** | concurrent merge/split of the *same* block on two replicas converges to one successor on all replicas (the architecture doc's "deterministic per-key resolution" claim) | `mergeIntoPrevious` + `redirects` write-in-same-transaction (`src/doc/model.ts` lines ~122–137) |
| **Anchor-under-concurrency** (the product promise) | replica A holds an anchor; replicas B/C concurrently mutate under an adversarial schedule; after quiescence A's `resolveEffectiveAnchor` still identifies the **same logical content** (same block, or its redirect successor with the original text as a suffix) — and never teleports to top | `resolveEffectiveAnchor` (`src/doc/anchor.ts`), `resolveRedirect` (`src/doc/redirects.ts`), `src/doc/ids.ts` app-level ids |

The last row is the whole thesis in one property: **the anchoring promise is a
distributed-systems invariant** — a user's viewport stays semantically anchored *while other
replicas concurrently mutate the document under a hostile network*. It composes the redirect
table, the anchor resolver, and the id model — all shipped code — so a green run proves those
modules *are* the convergence mechanism, per §0 "embedded in Scroll."

#### PROVES vs does-NOT-PROVE (kept honest — full boundary in §7 R3)

The in-memory harness proves the **schema + resolution logic** converge under any message
schedule. It does **not** prove the real transport (`y-websocket`/Hocuspocus), reconnect/resync
timing, awareness, persistence races, or the **single-authority-per-room / lease** requirement
called out in [`docs/architecture/distributed-systems.md`](../architecture/distributed-systems.md)
and [`docs/architecture/storage-and-persistence.md`](../architecture/storage-and-persistence.md).
Those need the **provider-chaos stage**, which is **P3-gated** (the provider does not exist yet).
See roadmap P3.

### 5B. Stages

#### Stage 1 — `test(pbt): anchoring model properties + fast-check` (§3, §4.1–4.2)
The **local projection** of the spine: single-replica relative-anchoring invariants, pure model.
fast-check dep, `pbt.ts`, `ops.ts`, properties A–D, artifact writer, purity guard, upload-artifact
step. **Start here** — smallest valuable landing; everything else builds on its Op ADT + oracle.

#### Stage 2 — `test(pbt): distributed convergence + anchor-under-concurrency (in-memory, no network)` — **the spine**
Builds the §5A network-adversary harness and asserts every §5A invariant, **including
anchor-under-concurrency**. In-memory, no provider (§7 R3). This is the plan's center of gravity:
it is where Scroll's distributed-systems value prop becomes a gate. Test file
`src/test/pbt/dist/convergence.pbt.test.ts`; describe block carries `[in-memory, no provider]`;
each property names its invariant (`[SEC]`, `[commutativity]`, `[causal]`, `[conflict-det]`,
`[anchor-under-concurrency]`). Reuses Stage 1's Op ADT as the `localOp` payload — no new op
language, just the network layer around it.

#### Stage 3 — `test(pbt): virtualization + estimate-drift properties`
Family: incremental rendering / "virtualized view corresponds to document state". Generators add:
height models where `measured` and `estimate` disagree by arbitrary drift; window recycling
(recompute `windowFor` after each op, as `Editor.tsx` does); viewport resize (`viewportH`
arbitrary); anchor walking into estimated regions (`deriveAnchor` on arbitrary scrollTops). New
invariants, straight from `docs/architecture/relative-viewport-anchoring.md`:
- perturbing estimates for blocks **outside** the render window never changes any rendered
  block's `screenTop` (estimates move scrollbar geometry only);
- `windowFor` always contains the anchor; window growth is monotone in `viewportH`/`overscan`;
- `deriveAnchor` total: any scrollTop ∈ [0, contentHeight] resolves to a real block with
  `0 ≤ offset < height`.

#### Stage 4 — `test(pbt): model-based op machine (truth model)`
Family 4 (model-based testing). `fc.commands` with the Op ADT as commands; system under test =
real `Y.Doc` via `model.ts`; truth model = plain `{ id, text, type }[]` plus
`expectedAnchor: { idx-or-successor }`. After every command: `blockViews(doc)` ≡ model array;
resolved anchor ≡ model's expected anchor. Catches interaction bugs between ops
(split-then-merge-then-delete chains) that flat sequences underweight, and gives the "what
content should the user still be looking at" oracle its own permanent home. Also the natural
place to property-test `resolveRedirect` against adversarial redirect maps (arbitrary chains +
cycles: terminates, idempotent, offset zeroed iff hops > 0) — a spine invariant at the unit level.

#### Stage 5 — `test(pbt): viewport chaos sequences + main-tier budget`
Family 3 (viewport chaos) + CI tiering (§6). Extends the harness with anchor *movement* (user
scrolls: re-derive anchor via `deriveAnchor` at arbitrary scrollTop) interleaved with the network
schedule and remeasurement, asserting the invariant at **every** step, not just quiescence. Adds
the main-push heavier budget to `ci.yml` and the coverage ledger (§7 R4). Optional, explicitly
**not** default-in: a single Playwright chaos spec replaying one short generated trace through the
real DOM — only if the adjudicator judges the flakiness cost acceptable given the existing
`retries: 2` debt; the plan's default is to keep PBT out of the browser entirely.

#### Provider-chaos — **P3-gated, not scheduled here**
When P3 ships the real `y-websocket`/Hocuspocus provider, a `test(pbt): provider chaos` stage
extends the §5A invariants onto the real transport (message loss on the wire, reconnect/resync
timing, awareness, persist-before-ack, single-authority-per-room). It depends on code that does
not exist yet; the in-memory Stage 2 is the honest stand-in until then (§7 R3). Cross-linked from
roadmap P3.

Not planned (right-sized out): nightly/RC mega-campaigns (the notes' author's own conclusion —
"always-on adversarial tests inside normal CI, not a giant nightly farm"), mutation testing. AI
generator evolution is **not** deferred — it is a first-class authoring-time mechanism, §8.

## 6. CI tiering (this repo's reality)

Current CI: `verify` (typecheck / test / build) + `e2e`, both required checks, auto-merge on
green. PBT rides `verify` — no new jobs, no matrix.

| Tier | Trigger | Budget | Mechanism |
|---|---|---|---|
| PR | `pull_request` | `PBT_RUNS=200` per property, fixed `PBT_SEED` — target ≤ 60s added to `verify` | `env:` on the `npm test` step |
| main | `push` to `main` | `PBT_RUNS=2000`, fixed seed **plus** a second campaign with `PBT_SEED=${{ github.run_number }}` — target ≤ 4 min | same step, conditional env: `PBT_RUNS: ${{ github.event_name == 'push' && 2000 || 200 }}` |

- The rotating main-push seed is what buys cumulative state-space coverage over time without any
  scheduled job; it is printed in the log and lands in the failure artifact, so a red main run
  is still perfectly replayable (`PBT_SEED=<n> npm test`). PRs stay fully deterministic so a
  red PR check is always the PR's fault, never seed luck — this matters because auto-merge has
  no human in the loop.
- A main-only failure from a rotating seed cannot block a PR retroactively; the loop's response
  is mechanical: shrink → commit fixture to `src/test/pbt/regressions/` → fix — as its own
  gated stage/PR.
- Release-candidate tier: not applicable yet (no release process); if one appears, it is a
  manual `PBT_RUNS=20000 npm test`, not new CI.
- **AI-authored artifacts ride the same tiers, deterministically.** Committed AI-generated
  fixtures/generators (§8) run **by value** on every PR (part of `PBT_RUNS`), same as
  hand-written ones. `@exploratory` AI properties (§8, §7 R4) run but are **non-blocking on PR**
  (reported, not gating) until adjudicator-promoted; they become blocking only after promotion.
  CI never invokes a model — the AI's output is already committed code/data. No new job, no
  network call from CI.

## 7. Risks and mitigations (honest)

Each risk below carries a **concrete guard**, not just acknowledgement.

### R1 — Node-only PBT can still leak non-determinism → flake

The node layer removes the *browser* flake vector, but a property can still go non-deterministic
through: `Date.now()`/`performance.now()`/`Math.random()` read inside a property body, real
`setTimeout`/`queueMicrotask`, un-awaited Yjs async (there is none today, but an `observe`
callback or a provider added later could introduce it), or fake-timer state leaking between
tests. Stating "flake is absent" is not a guard; here is the guard.

**Mitigation — a determinism harness + a lint fence:**

1. **Purity guard in `runProperty` (`src/test/pbt/pbt.ts`).** The wrapper that every property
   calls stubs the ambient sources of entropy for the duration of the `fc.assert` and restores
   them in a `finally`:
   - replace `Math.random` with a seeded PRNG derived from `PBT_SEED` (so even
     `src/doc/ids.ts` becomes reproducible *within a run*, upgrading the §4.1 "accepted hazard"
     from relational-only to fully deterministic);
   - freeze `Date.now`/`performance.now` to a fixed constant and throw if a property schedules a
     real `setTimeout`/`setInterval` (assign a throwing stub, restore after);
   - assert **synchrony**: the property function is non-`async` and returns a `boolean`/`void`,
     and the interpreter uses only synchronous Yjs calls (`applyUpdate`, `transact`) — no
     `await`, no `Promise`. `fc.assert` (sync form) throws if a property returns a thenable, so
     this is enforced by construction.
2. **Double-run self-check.** A meta-test in `pbt.ts` runs one representative property twice
   with the *same* seed and asserts identical pass/fail + identical first counterexample. If
   anything non-deterministic sneaks in, this test flips red deterministically (it is the canary
   for R1). Cost: one extra property execution, negligible.
3. **Lint fence.** An ESLint `no-restricted-syntax`/`no-restricted-globals` rule scoped to
   `src/test/pbt/**` bans `Date.now`, `performance.now`, `Math.random`, `setTimeout`,
   `setInterval`, and `async`/`await` tokens in property/interpreter files — a compile-time stop
   so a future contributor cannot reintroduce entropy silently. (If the repo has no ESLint yet,
   the double-run self-check + the throwing stubs are sufficient; add the lint rule when linting
   lands.)

Net: flake in this layer is prevented *structurally* (stubs + synchrony enforcement) and
*detected* (double-run canary), not merely asserted.

### R2 — fast-check version bump can shift seed→case generation

Pinning exact stops silent drift but does not make old failures immune, and does not tell us
*when* a bump changed generation. Two guards.

**Mitigation — fixtures replay by value, plus a canary:**

1. **Regression fixtures replay the concrete op-script, never a seed.** A fixture is the shrunk
   counterexample as *data*, not a `{seed, path}`:

   ```json
   {
     "id": "2026-07-anchor-teleport-on-largepaste",
     "initial": { "blocks": 42, "anchorIdx": 17, "offset": 12, "textSeed": 88 },
     "ops": [ { "kind": "largePaste", "where": "above", "blocks": 213, "seed": 9 } ],
     "expected": { "resolvedRelToInitialAnchor": 0, "anchorTextEqualsInitial": true },
     "observed_at_capture": { "resolvedIdx": 0, "text": "…" }
   }
   ```

   The loader in `anchoring.pbt.test.ts` does
   `import.meta.glob('./regressions/*.json', { eager: true })`, and for each fixture runs the
   **interpreter directly** on `initial`+`ops` (no `fc.arbitrary`, no seed) then asserts
   `expected`. Because it never touches fast-check's generators, a fast-check upgrade cannot
   change what a fixture exercises — the historical bug is pinned to the exact document + op
   sequence that once broke it. (fast-check's own `examples: [...]` option is an equivalent
   alternative, but calling the interpreter directly keeps fixtures independent of the fc API
   surface entirely, which is the stronger immunity.)
2. **Generator-drift canary test.** One committed fixture is *also* stored with its original
   `{ seed, path, fastCheckVersion }` and replayed **by seed** through the live generator. Its
   assertion is: "replaying this seed still produces a case whose op-kind multiset matches the
   recorded one." On a fast-check bump that reshuffles generation, this single test fails loudly
   with a message like `fast-check <old>→<new> changed seed→case mapping; regression fixtures
   are value-based and safe, but re-baseline the canary`. So the bump is *visible* (CI goes red
   on the canary, nowhere else), the value-based fixtures keep protecting the real bugs, and the
   fix is a one-line re-baseline of the canary — never a silent loss of coverage.
3. **Renovate/dependabot note.** `fast-check` is pinned exact in `package.json`; its bump PRs
   run the canary, so the upgrade decision is always accompanied by an explicit "generation
   changed / didn't change" signal.

### R3 — The distributed-systems spine (Stage 2) must not over-claim P3 multi-user safety

Stage 2 (§5A) is the plan's center of gravity, so the over-claim risk is *higher*, not lower:
a green convergence + anchor-under-concurrency check is easy to read as "multi-user works." It
does not. The distributed-systems invariants are proven **at the CRDT/schema/resolution layer**,
against real Yjs replicas but a **modelled** network — not the shipped transport. Guard is
scope-in-the-name + a scope banner + roadmap/CONTEXT wording.

**What the in-memory distributed-systems harness PROVES:**
- Scroll's *data schema* (the `blocks` `Y.Array`, the `redirects` `Y.Map`, the transaction
  boundaries in `model.ts` where merge+redirect are written atomically) is CRDT-sound: under any
  generated reorder/delay/duplicate/drop-resync/partition-heal schedule (§5A), all replicas that
  have applied the same update set converge to identical `blockViews` and `redirects` — SEC,
  commutativity, associativity, idempotence, causal consistency, conflict-resolution determinism.
- The architecture doc's key claim — "concurrent merge/split of the same block converges by the
  map's deterministic per-key resolution … anchors survive multi-hop renames" — holds under
  adversarial schedules.
- **Anchor-under-concurrency**: with B/C mutating under a hostile schedule, A's
  `resolveEffectiveAnchor` still identifies the same logical content (or its redirect successor)
  — the product promise, proven at the resolution layer over shipped modules.

**What it does NOT prove (belongs to the P3-gated provider-chaos stage, §5B):**
- provider/transport behavior (`y-websocket`/Hocuspocus) — message loss, reordering on the wire,
  reconnect/resync *timing*, backpressure;
- awareness/presence channel correctness;
- persistence race conditions (persist-before-ack, the `y-indexeddb` self-healing queue);
- **single-authority-per-room / lease** semantics called out in
  [`docs/architecture/distributed-systems.md`](../architecture/distributed-systems.md) and
  [`docs/architecture/storage-and-persistence.md`](../architecture/storage-and-persistence.md).
There is no provider code in the repo today, so there is nothing real to test yet — testing it
now would be testing a mock, which proves nothing. The modelled network is honest *because* it is
labelled a model everywhere it appears.

**Mitigation — make the boundary un-missable:**
1. Test file is `src/test/pbt/dist/convergence.pbt.test.ts`; the top-level `describe` is
   `Distributed convergence (in-memory replicas, MODELLED network, NO provider — see plan §7 R3)`;
   each property name carries `[in-memory]` plus its invariant tag (`[SEC]`,
   `[anchor-under-concurrency]`, …).
2. A comment banner at the top of the file enumerates the "does NOT prove" list above, pointing
   to the **P3-gated** `test(pbt): provider chaos` stage that depends on the `y-websocket`
   provider existing.
3. The Stage 2 PR description states the boundary in one line, and CONTEXT.md's status note says
   "collaboration *schema + resolution* proven under a modelled network; collaboration
   *transport* still P3."
4. The roadmap's P3 entry gains a back-reference: "provider-chaos PBT stage lands here, extending
   the in-memory distributed-systems invariants (PBT plan §5A) onto the real provider."

### R4 — "Green PR ≠ state space cleared": coverage honesty without a nightly farm

200 seeds/PR is regression-catching, not exhaustive; nobody should read green as "explored."
Without a fuzzing farm we still need an *honest, cumulative* coverage signal.

**Mitigation — a committed coverage ledger + a load-bearing rule:**
1. **Per-property "cases explored" report in CI.** `runProperty` records, per property, the
   `numRuns` actually executed and a cheap structural-coverage tally (a set of *op-kind
   bigrams* — pairs of consecutive op kinds — seen across generated sequences; this is a
   proxy for "which interaction shapes were exercised"). At the end of the run it prints a table
   to the CI log:
   `property | runs | distinct op-bigrams seen / total possible`.
2. **Committed cumulative ledger `src/test/pbt/coverage-ledger.json`.** The **main-push** tier
   (the rotating-seed campaign, §6) merges its newly-seen op-bigrams into this file and, if the
   set grew, the main-push job commits the updated ledger back to `main` (a `[skip ci]` chore
   commit, or a follow-up automerge PR). Over weeks this accumulates the real explored frontier
   *without any nightly job* — exactly the "coverage accrues over time" model the notes ask for.
   PRs read the ledger but never write it (keeps PR runs deterministic and side-effect-free).
3. **Coverage regression guard.** A PR fails if it *removes* a property or drops a property's
   `numRuns` below the committed floor for that property (stored alongside the ledger). This
   stops silent coverage erosion — the thing a green check would otherwise hide.
4. **"Load-bearing" promotion rule (explicit, in this file).** A property is considered
   *load-bearing* (i.e. trusted as a real gate, not exploratory) only once: (a) it has caught at
   least one committed regression **or** was written to pin a specific architecture claim, (b)
   its op-bigram coverage has reached a stated threshold in the ledger (e.g. ≥ 80% of reachable
   bigrams for its op set), and (c) it has survived ≥ N main-push rotating-seed campaigns without
   a spurious failure. Until all three hold, the property is labeled `@exploratory` in its test
   name and a failure is triaged as "possible spec bug in the property" before "product bug."
   This gives a truthful, mechanical answer to "how much do we trust this green?" per property,
   surfaced in the same CI table.

Net: coverage is *reported* per property, *accumulated* in a committed ledger by the main tier,
*protected* against erosion by the regression guard, and *interpreted* by the load-bearing rule
— all without a fuzzing farm, and all visible in the normal CI log.

### Remaining tradeoffs (accepted, lower-stakes)

- **Time budget.** fast-check on pure functions runs ~10³–10⁴ cases/sec; 200 runs × ~6
  properties is seconds. The Yjs-backed interpreter is slower (doc construction per case);
  Stage 1 caps initial doc size at 300 blocks and op sequences at ~30 ops to hold the ≤60s PR
  budget. If `verify` creeps past ~3 min total, drop `PBT_RUNS` before dropping properties.
- **Shrinking through stateful Yjs.** Interpreting shrunk op lists against a fresh `Y.Doc` per
  attempt is the correct pattern (ops-as-data, §3.2); the cost is that op fields like `rel` are
  clamped at interpretation time, so a shrunk case can differ semantically from the original
  failure's shape. Mitigation: clamp deterministically and record the *post-clamp* effective
  targets in the artifact.
- **Oracle drift.** Properties B/D encode `computeLayout`'s current contract; if the layout
  model changes (e.g. P6 residency work), properties must be updated with it. That is by
  design — the properties *are* the spec — but a layout refactor now touches `src/test/pbt/`
  too, and the adjudicator should treat a property *loosened* during a refactor as a red flag.

## 8. AI-generated PBT (authoring-time, CI-replayed)

First-class, not "AI later." The idea notes' loop — AI as an **adversarial researcher** that
invents scenarios, expands generators, and proposes invariants — is embedded here **without**
breaking determinism, by drawing one hard line:

> **The AI runs at authoring time (offline). CI only ever replays committed, deterministic
> artifacts. CI never calls a model.** This reconciles with R1 (purity harness) and R2
> (value-based replay): an AI-authored fixture is byte-identical to a hand-authored one by the
> time CI sees it.

### 8.1 The loop (offline)

1. **Inputs** the AI examines: recent failure artifacts (`test-results/pbt/*.failure.json`),
   the recent code diff (esp. touches to `src/doc/`, `src/layout/`, `src/editor/Editor.tsx`),
   the existing generators (`src/test/pbt/ops.ts`, the §5A schedule), and the coverage ledger
   (§7 R4) to see which op-bigrams / invariant tags are under-explored.
2. **Output** (one of): a new **adversarial dimension** (e.g. the notes' "symbol movement +
   viewport anchoring + async layout completion", or a nastier network schedule like
   "partition A|BC, fill divergence, heal, immediately re-partition"), a new **generator**
   (extra `Op` / `NetEvent` variant + arbitrary), a batch of **value-based fixtures**, and/or a
   **candidate invariant** (a proposed property + oracle, in prose + a code stub).
3. Emitted as a **committed artifact** (§8.2), opened as a normal PR.

### 8.2 Artifact format + storage

Stored under `src/test/pbt/ai/` (segregated from human-authored `src/test/pbt/` so provenance is
obvious in review and blame):

```
src/test/pbt/ai/
  generators/<name>.ts        new Op/NetEvent variants + fc arbitraries (deterministic; obey R1 lint fence)
  fixtures/<name>.json         value-based cases: { initial, ops|schedule, expected, observed_at_capture, provenance }
  candidates/<name>.md         proposed invariant: prose statement, oracle, why-sound argument, sabotage check
  MANIFEST.json                { artifact, source: "ai", model, prompt_hash, created, status }
```

Every fixture carries `"provenance": { "source": "ai", "model": "...", "prompt_hash": "...",
"reviewed_by": null }`. A candidate invariant lands as a **failing-or-`@exploratory`** property
(never a silently-trusted gate) plus its `candidates/<name>.md` rationale.

### 8.3 How CI runs it (deterministically)

- AI fixtures under `ai/fixtures/` are globbed and replayed **by value** exactly like R2
  regressions — the interpreter runs `initial`+`ops`/`schedule`, asserts `expected`. No seed, no
  model, no network. They ride the normal PR tier (§6).
- An AI generator under `ai/generators/` is imported into a property only after adjudicator sign-off
  (§8.4); until then its *cases* exist only as frozen fixtures, so CI stays deterministic even
  while the generator itself is under review.

### 8.4 The gate (AI proposal → load-bearing)

Ties directly to R4's promotion rule and the ide-es grading-trust discipline (an AI-proposed
oracle must **never** silently become the source of truth):

1. Every AI artifact enters `@exploratory` (§7 R4): it **runs but does not block PR merges**
   (§6), and a failure is triaged "possible bad AI property" before "product bug."
2. **Adjudicator review of the oracle for soundness** is mandatory before promotion — the same
   gate every stage passes. The adjudicator must independently justify *why the proposed
   invariant is true of Scroll* (not merely that the test passes), exactly as the ide-es rule
   forbids trusting a grader's verdict without checking the grader. An AI oracle that merely
   mirrors the implementation (tautology) is rejected.
3. Promotion to load-bearing requires R4's three conditions (caught a regression or pins a real
   architecture claim + coverage threshold + survived N main-push campaigns) **and** the
   adjudicator soundness sign-off recorded in `MANIFEST.json` (`reviewed_by` set). Only then does
   the property drop `@exploratory` and start gating.
4. AI **never** decides pass/fail and **never** edits an existing human invariant — it only adds
   candidates. Deterministic PBT decides pass/fail; the AI proposes and explains; the adjudicator
   approves. (This is the idea notes' own "do not make an LLM the thing deciding whether code
   passes CI" architecture.)

### 8.5 Roadmap Q-track

This is the "Q-track" (quality/verification) thread that runs alongside the product roadmap:
- **Q1** = Stage 1 (local anchoring properties).
- **Q2** = Stage 2 (distributed-systems spine) — the load-bearing one.
- **Q3** = Stages 3–5 (virtualization, model-based, viewport chaos + CI tiering).
- **Q4** = AI-authored PBT (this section) turned on: `ai/` directory, `@exploratory` intake,
  adjudicator promotion. Depends on Q1–Q3 existing (the notes' "AI fits *after* the foundations":
  strong invariants + history simulator + replay + CI must exist first).
- **Q5 (P3-gated)** = provider-chaos stage (§5B) once the real provider ships.
Cross-linked from `docs/roadmap.md`; the AI intake explicitly waits on Q1–Q3 so the AI has a
"formal world to reason about" rather than producing shallow noise.

## 9. Immediate next action (Stage 1 checklist)

1. `npm i -D fast-check` (pin exact).
2. Extract `resolveEffectiveAnchor` → `src/doc/anchor.ts`; wire `Editor.tsx`; existing tests
   stay green.
3. Add `insertBelow`/`deleteBelow`/`setBlockType` helpers (in `src/dev/synthetic.ts` /
   `src/doc/model.ts`).
4. `src/test/pbt/pbt.ts` — seed/runs env, artifact writer, **purity guard + double-run canary**
   (R1); `src/test/pbt/ops.ts` (Op ADT, arbitraries, interpreter); `src/test/pbt/anchoring.pbt.test.ts`
   (properties A–D + value-based regression loader, R2); `src/test/pbt/regressions/` fixtures.
5. Sabotage-check each property catches its target bug; restore.
6. Add the `pbt-failures` upload-artifact step to `verify` (adjudicator-gated CI edit).
7. Inspectors → adjudicator → PR `test(pbt): anchoring model properties + fast-check` with
   `automerge` label.

(Coverage ledger R4 and the fast-check canary's main-push commit path land with Stage 5's CI
tiering; Stage 1 ships the reporting hook in `runProperty` but not the committed ledger.)
