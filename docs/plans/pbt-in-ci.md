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

Install: `npm i -D fast-check`. That is the entire new infrastructure.

New files (Stage 1):

```
src/test/pbt/pbt.ts                 seed/runs config + failure-artifact wrapper
src/test/pbt/ops.ts                 op ADT + arbitraries + interpreter onto Y.Doc
src/test/pbt/anchoring.pbt.test.ts  first property family
src/test/pbt/regressions/           committed failure fixtures (JSON), replayed every run
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
  `node` environment; no timers, no DOM, no async — this is what keeps flakiness structurally
  impossible in this layer.

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
  `src/test/pbt/regressions/`. A loader in `anchoring.pbt.test.ts` globs that directory
  (`import.meta.glob('./regressions/*.json', { eager: true })`) and replays every fixture as an
  explicit example before the random campaign (fast-check's `examples` option, or a plain
  `it.each` running the interpreter + assertions). Regressions therefore run on **every** PR at
  zero seed-budget cost.
- This is the "random discovery → deterministic debugging → permanent bug report" loop from the
  idea notes, with the fixture living in-repo under normal review.

## 5. Property families → stages

Each stage is one adjudicator-gated, PR-sized unit that fits the existing loop
(implement → inspectors → adjudicator → PR → CI green → auto-merge). Ordered by
value-per-risk; each is independently shippable and stops cleanly.

### Stage 1 — `test(pbt): anchoring model properties + fast-check` (§3, §4.1–4.2)
Family 1 (relative anchoring invariants), pure model. fast-check dep, `pbt.ts`, `ops.ts`,
properties A–D, artifact writer, upload-artifact step. **Start here.**

### Stage 2 — `test(pbt): virtualization + estimate-drift properties`
Family: incremental rendering / "virtualized view corresponds to document state".
Generators add: height models where `measured` and `estimate` disagree by arbitrary drift;
window recycling (recompute `windowFor` after each op, as `Editor.tsx` does); viewport resize
(`viewportH` arbitrary); anchor walking into estimated regions (`deriveAnchor` on arbitrary
scrollTops). Key new invariants, straight from
`docs/architecture/relative-viewport-anchoring.md`:
- perturbing estimates for blocks **outside** the render window never changes any rendered
  block's `screenTop` (estimates move scrollbar geometry only);
- `windowFor` always contains the anchor; window growth is monotone in `viewportH`/`overscan`;
- `deriveAnchor` total: any scrollTop ∈ [0, contentHeight] resolves to a real block with
  `0 ≤ offset < height`.

### Stage 3 — `test(pbt): model-based op machine (truth model)`
Family 4 (model-based testing). `fc.commands` with the Op ADT as commands; system under test =
real `Y.Doc` via `model.ts`; truth model = plain `{ id, text, type }[]` plus
`expectedAnchor: { idx-or-successor }`. After every command: `blockViews(doc)` ≡ model array;
resolved anchor ≡ model's expected anchor. This catches interaction bugs between ops
(split-then-merge-then-delete chains) that Stage 1's flat sequences underweight, and gives the
"what content should the user still be looking at" oracle its own permanent home. Also the
natural place to property-test `resolveRedirect` against adversarial redirect maps (arbitrary
chains + cycles: terminates, idempotent, offset zeroed iff hops > 0).

### Stage 4 — `test(pbt): Yjs convergence + anchor agreement`
Family 2 (collaborative convergence), **in-memory, no server, no provider** — feasible today
despite the app being single-user, because `Y.Doc` sync is a library operation:
two `createDoc()` instances, generated op scripts applied to each concurrently, updates
exchanged via `Y.encodeStateAsUpdate`/`Y.applyUpdate` in generated interleavings/duplications
(update application is commutative + idempotent, so arbitrary schedules are valid). Assert:
- `blockViews(a) ≡ blockViews(b)` after full exchange (document convergence);
- `redirects` maps converge (validates the "merge + redirect written in the same transaction,
  per-key deterministic resolution" claim in the architecture doc **before** P3 builds on it);
- both replicas resolve a shared pre-divergence anchor to the same block (anchor agreement —
  the Scroll-specific convergence property, stronger than "same document").
Deliberately excluded until P3 exists: provider/network chaos, awareness, reconnects — there is
no such code to test yet.

### Stage 5 — `test(pbt): viewport chaos sequences + main-tier budget`
Family 3 (viewport chaos) + CI tiering (§6). Extends the Stage 1 generator with the remaining
chaos dimensions that exist in the shipped editor's pure core: interleave anchor *movement*
(user scrolls: re-derive anchor via `deriveAnchor` at arbitrary scrollTop) with mutations and
remeasurement, asserting the invariant at every step, not just the end. Adds the main-push
heavier budget to `ci.yml`. Optional, explicitly **not** default-in: a single Playwright chaos
spec replaying one short generated trace through the real DOM — only if the adjudicator judges
the flakiness cost acceptable given the existing `retries: 2` debt; the plan's default is to
keep PBT out of the browser entirely.

Not planned (right-sized out): nightly/RC mega-campaigns (the notes' author's own conclusion —
"always-on adversarial tests inside normal CI, not a giant nightly farm"), mutation testing,
AI-driven generator evolution (idea notes place it after foundations; revisit post-Stage 5).

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

## 7. Risks and tradeoffs (honest)

- **Flakiness.** The design keeps PBT purely in the node environment — no DOM, no timers, no
  async — so the classic PBT-flake vector (timing-sensitive properties) is structurally absent.
  The repo's real flake debt is Playwright `retries: 2` (already flagged in CONTEXT.md §4);
  this plan deliberately does **not** add browser-level PBT (Stage 5's e2e replay is opt-in and
  adjudicator-gated) so it cannot deepen that debt. Residual risk: an over-tight numeric
  assertion (e.g. exact-equality on summed heights) failing on a rare generated shape — that is
  a genuine spec bug to fix, not a flake to retry, and the artifact makes it cheap.
- **Time budget.** fast-check on pure functions runs ~10³–10⁴ cases/sec; 200 runs × ~6
  properties is seconds. The Yjs-backed interpreter is slower (doc construction per case);
  Stage 1 caps initial doc size at 300 blocks and op sequences at ~30 ops to hold the ≤60s PR
  budget. If `verify` creeps past ~3 min total, drop `PBT_RUNS` before dropping properties.
- **Determinism hazards.** `ids.ts` randomness (accepted, handled relationally, §4.1);
  fast-check version bumps can change generation for a fixed seed (pin `fast-check` exact in
  `package.json`; regression fixtures are immune since they replay explicit ops);
  `environmentMatchGlobs` keeps PBT files out of happy-dom as long as they are not named
  `*.dom.test.ts` — keep the `.pbt.test.ts` suffix.
- **Shrinking through stateful Yjs.** Interpreting shrunk op lists against a fresh `Y.Doc` per
  attempt is the correct pattern (ops-as-data, §3.2); the cost is that op fields like `rel` are
  clamped at interpretation time, so a shrunk case can differ semantically from the original
  failure's shape. Mitigation: clamp deterministically and record the *post-clamp* effective
  targets in the artifact.
- **Yjs convergence testing before multi-user exists.** Stage 4 tests the library + Scroll's
  schema (blocks array, redirects map, transaction boundaries), not networking. That is real
  value (it de-risks the P3 architecture claims now) but it must not be sold as "collaboration
  is tested" — provider chaos, reconnect, and awareness testing remain P3 work, and the plan
  says so where it will be read (this file, the Stage 4 PR description).
- **Oracle drift.** Properties B/D encode `computeLayout`'s current contract; if the layout
  model changes (e.g. P6 residency work), properties must be updated with it. That is by
  design — the properties *are* the spec — but it means a layout refactor now touches
  `src/test/pbt/` too, and the adjudicator should treat a property loosened during a refactor
  as a red flag.
- **Coverage honesty.** 200 seeds per PR is regression-catching, not exhaustive exploration.
  The main-push rotating seed accumulates coverage over time; nobody should read a green PR
  check as "the state space is clear".

## 8. Immediate next action (Stage 1 checklist)

1. `npm i -D fast-check` (pin exact).
2. Extract `resolveEffectiveAnchor` → `src/doc/anchor.ts`; wire `Editor.tsx`; existing tests
   stay green.
3. Add `insertBelow`/`deleteBelow`/`setBlockType` helpers (in `src/dev/synthetic.ts` /
   `src/doc/model.ts`).
4. `src/test/pbt/pbt.ts` (seed/runs env + artifact writer), `src/test/pbt/ops.ts` (Op ADT,
   arbitraries, interpreter), `src/test/pbt/anchoring.pbt.test.ts` (properties A–D),
   `src/test/pbt/regressions/` loader.
5. Sabotage-check each property catches its target bug; restore.
6. Add the `pbt-failures` upload-artifact step to `verify` (adjudicator-gated CI edit).
7. Inspectors → adjudicator → PR `test(pbt): anchoring model properties + fast-check` with
   `automerge` label.
