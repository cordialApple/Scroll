# CONTEXT.md

_Last updated: 2026-07-25 · branch: main · session: Scroll P3.3 awareness (presence) landed + merged — P3 now 3/6; P3.4 infra fork open_

## 1. What changed this session
- **P3.3 (#32, merged `47c84e2` via PR #38)** — peer **awareness/presence**. New `src/doc/awareness.ts`: pure `resolveRemoteCamera` (redirect-aware) + `createPresence` — throttled publish (leading+trailing, injectable `Clock` seam), self-filtered `remotes()`, `setLocalState(null)` ghost-clear on `destroy()`, `isAnchor`/`isUser` guards on remote state. New `src/chrome/PresenceBar.tsx` (collaborator overlay; re-renders on awareness change AND doc mutation so resolved anchors stay fresh). New `src/doc/presenceUser.ts` (per-tab name+color). `src/App.tsx` wires editor `onAnchorChange` → publish + renders the bar when a network provider exists (offline ⇒ presence null, no crash).
- **Additive invariant held** — zero diff in `Editor.tsx` / `layout/*` / `doc/anchor.ts` / `doc/redirects.ts` / `doc/model.ts`. Presence rides the existing origin-blind `resolveEffectiveAnchor` pipeline ("N cameras, one layout").
- Issue #32 closed manually (Scroll squash doesn't auto-close on `Closes #N`); both branches pruned.

## 2. Decisions made and why
- **Awareness = ephemeral presence, not a toggleable camera.** Each peer keeps its own camera; awareness only broadcasts *where each peer looks*, resolved per-viewer through the shared pipeline. Non-persisted, auto-clears on disconnect.
- **Resolution correctness lives in a pure function** (`resolveRemoteCamera`) with unit teeth; the overlay is a thin renderer. Load-bearing guarantee (redirect-successor after concurrent merge) is deterministically testable without a browser.
- **Hocuspocus over plain y-websocket** (unchanged) — P3.4 persist-before-broadcast needs the synchronous `beforeHandleMessage` ingress hook; `onAuthenticate` is the P4 on-ramp.
- **Gate:** fable still rate-limited → **Opus stand-in** adjudicator (same red/green discipline). PASS, zero blocking; two non-blocking notes folded in (ghost-clear tooth + `isUser` narrow).

## 3. What was tested and how
- **Scroll:** tsc clean · vitest **100/100** (5 new awareness teeth) · playwright **11/11** (new `e2e/presence.spec.ts` proves the socket→awareness→resolve wire: B renders A's camera at A's exact block) · build clean · CI green (typecheck/build + playwright) → auto-merged.
- **Gate red/green (sabotage-then-revert, tree left clean):** resolve-by-raw → 2 redirect-successor teeth RED (got vanished `x`, want successor `p0`); throttle passthrough → rate-cap tooth RED (3 writes vs 1 leading+1 trailing); no-clear-on-destroy → ghost-clear tooth RED. Adjudicator independently re-ran a sabotage + confirmed additive invariant, offline-safety, self-filter, trailing-flush, type-safe remote state.

## 4. Files needing attention
- **P3.4 (#33) needs a Postgres service in Scroll CI** — the one open infra decision before persist-before-broadcast (snapshot/log). Blocks nothing else in P3 except its own start.
- **fable rate-limited** — P3.3 rode an Opus stand-in gate; optional fable re-stamp of P3.2/P3.3 later.
- `@hocuspocus/server` sits in `dependencies` (used by `server/` + tests) — could be a devDependency (cosmetic).
- Remaining P3: #33 P3.4 persistence, #34 P3.5 epoch fence, #35 P3.6 provider-chaos PBT. Dep shape: `{P3.4→P3.5} → P3.6`.
- Program status board (single source of truth): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2

## 5. Next step
**Awaiting user's P3.4 (#33) infra decision** — the persistence-in-CI fork, surfaced with a recommendation:
- **(A, recommended) embedded/SQLite store behind the `beforeHandleMessage` seam** — CI stays dependency-free; the persist-before-broadcast *guarantee* + teeth are identical, real Postgres deferred to P4/deploy. The localhost "agent-as-user" milestone needs the ordering guarantee, not a specific engine.
- **(B) Postgres service container in Scroll CI** — truest to prod, adds a service + migration to the CI job.
Once the user picks, implement P3.4: a synchronous `beforeHandleMessage` ingress seam that persists each update *before* it broadcasts, with red/green teeth proving a crash between persist-and-broadcast loses nothing. Then P3.5 (epoch fence) chains off it; P3.6 (provider-chaos PBT) gates the whole track. User may instead redirect to a different stage.
