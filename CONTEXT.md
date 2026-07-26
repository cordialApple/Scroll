# CONTEXT.md

_Last updated: 2026-07-25 · branch: main · session: Recall_Seed contract-6 receiver + Scroll P3.1/P3.2 (multi-user milestone reached)_

## 1. What changed this session
- **Recall_Seed (C#, local `PersonalServer_`, remote `Recall-Seed`) — 3 PRs merged.** #16 rename PersonalServer→Recall_Seed (34 files). #17 vault write hardening: `VaultStore.Write` now slug-validates the experience `id` (`^[a-z0-9]+(-[a-z0-9]+)*$`) before `Path.Combine` / YAML — closes a path-traversal + YAML-injection gap at the store choke point (covers update/confirm too); + a sqlite tool-layer test. #19 (closes #18) **`get_scroll_verdict` loopback receiver** — new `Scroll/` namespace (ScrollVerdict strict parser, VerdictLog ring, ScrollReceiverConfig, VerdictReceiver IHostedService on `127.0.0.1:{SCROLL_VERDICT_PORT}`, ScrollVerdictTools). **Contract-6 grade loop now closed end-to-end.**
- **Scroll P3 (multi-user) kicked off** — filed 6 gated issues #30–#35 (P3.1–P3.6), `P3`-labeled, dependency-shaped `P3.1 → {P3.2 ∥ P3.3 ∥ (P3.4→P3.5)} → P3.6`.
- **P3.1 (#30, merged `fa3e109`)** — `openDoc` attaches a `HocuspocusProvider` alongside `IndexeddbPersistence`; boot (`whenSynced`) gates on **local** indexeddb only (network = background self-heal). New `server/` minimal Hocuspocus relay (no DB); `?room=` + `VITE_SCROLL_WS_URL`; `dev:server`. Teeth: real-socket convergence + offline-boot in `src/doc/network.test.ts`.
- **P3.2 (#31, merged `b0adab9`)** — `e2e/multiuser.spec.ts`: two real browser peers, insert above each viewport, **neither jumps** (the P3 milestone). `src/App.tsx` gains a dev-only `?ws=` override (prod DCE-strips it). The anti-jump engine is byte-unchanged — additive.

## 2. Decisions made and why
- **Hocuspocus over plain y-websocket** — the P3.4 persist-before-broadcast rule needs a synchronous `beforeHandleMessage` ingress hook y-websocket doesn't expose, and `onAuthenticate` is the P4 on-ramp. "y-websocket is fine" in the roadmap is a *topology* statement (one server), which holds under Hocuspocus.
- **P3 additive invariant** — multi-user must not touch `Editor.tsx`/`layout/*`/`doc/anchor.ts`/`doc/redirects.ts`/`doc/model.ts`; the `observeDeep`→`holdCamera` correction is already origin-blind, so remote ops flow through it unchanged. Held for P3.1 + P3.2 (verified by git-stat + gate).
- **P3 scope boundary** — ship the store-side `owner_epoch` fence (P3.5) + a minimal ingress seam (P3.6); **defer** the lease-*acquisition* mechanism (Durable Object / distributed lock) and contract-7 **token issuance** to P4/deployment. The localhost milestone needs neither.
- **Adjudicator gate** — fable hit its session rate-limit (resets ~12:30pm America/Chicago); P3.2 was gated by an **Opus stand-in** (same red/green sabotage discipline). Optional fable re-stamp later. `preserveConnection:false` added after the P3.1 gate proved `destroy()` leaked the socket.

## 3. What was tested and how
- **Recall_Seed:** `dotnet build -c Release` 0-warn/0-err; `dotnet test` **71/71**. Fable gates PASS on #17 (slug guard + sqlite test proven via red/green) and #19 (receiver: 7 sabotages red→green, body cap exact at 4096/4097, loopback-only + opt-in-off verified live). Merged manually (repo has no automerge).
- **Scroll:** `tsc` clean · `vitest` **95/95** · `playwright` **10/10** (incl. `multiuser.spec.ts` + P0 `milestone.spec.ts`) · `build` clean. P3.1 fable = CHANGE REQUIRED (destroy leak) → fixed + regression tooth → green. P3.2 Opus = PASS; **decisive teeth**: remote-isolating sabotage made `multiuser` RED (B jumped 2344px) while P0 `milestone` stayed GREEN — proving real remote-path coverage.

## 4. Files needing attention
- **fable rate-limited** until ~12:30pm Chicago — P3.2 rode an Opus stand-in gate; re-stamp with fable if desired.
- **P3.4 (#33) needs a Postgres service in Scroll CI** — an infra decision to make before starting it (persist-before-broadcast + snapshot/log).
- Remaining P3: #32 P3.3 awareness (self-contained), #33 P3.4 persistence, #34 P3.5 epoch fence, #35 P3.6 provider-chaos PBT.
- `@hocuspocus/server` sits in `dependencies` (used by `server/` + tests) — could be a devDependency (cosmetic).
- Program status board (single source of truth): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2

## 5. Next step
Start **P3.3 (#32, awareness)** — publish each peer's camera `{blockId, offset}` + cursor over Yjs/Hocuspocus **awareness** (ephemeral, non-persisted presence channel), and render remote peers by feeding each remote anchor through the same `resolveEffectiveAnchor` pipeline (teeth: a remote camera must resolve to the redirect *successor* after a concurrent merge, never a raw index; + awareness rate-cap). Self-contained, no infra decision. (If durability is prioritized instead, first decide Postgres-in-CI for P3.4 — noted in §4.) Issue is already filed; implement → gate → `automerge` PR `Closes #32`.
