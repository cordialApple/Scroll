# CONTEXT.md

_Last updated: 2026-07-26 · branch: main · session: P4.2 role-aware ingress authZ + room-derived admission handler landed — **P4 underway (2/5)**_

## 1. What changed this session
- **Program status correction landed first.** Status board (https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2): Recall_Seed **100% of role**, P3 **CLOSED 6/6**, P4 the active critical path, north-star ~68%. **Online portability parked under P4/beyond** — localhost/single-server is a deliberate deferral, NOT a role gap; that carve-out is why Recall_Seed reads 100%.
- **P4.1 (#42, PR #43)** — contract-7 trust root: HMAC room-scoped peer tokens (`server/auth/peerToken.ts`), role/caps inside the MAC, room-scope on `documentName`, contract-3 gate, non-finite-ttl hardening.
- **P4.2 (#44, PR #45)** — the room now *acts* on the authenticated identity, and `mint` gets its first real caller.
  - **Role-aware ingress authZ (contract-1 "AuthZ at the seam").** `server/db/ingressExtension.ts`: the authenticated `PeerIdentity` (spread into connection context at `onAuthenticate`, read via `peerFromContext`) is checked at `beforeHandleMessage` — a **state-mutating** update from an authenticated peer lacking the `write` cap is refused (4400) before persist. `mutatesState` (guarded `Y.decodeUpdate`) lets a read-only peer's empty handshake `syncStep2` through; only real structs/deletes count as a write. Tokenless localhost is unaffected (no `peer` in context → gate no-ops).
  - **Room-derived admission (closes carry-forward F-02).** `server/auth/admission.ts` — `issueRoomToken(secret, resolveRoomConfig, req)` derives `programmatic` mode from authoritative room config via the resolver, never from the request. `AdmissionRequest` has **no `mode` field**, so contract-3 ("on admits no AI peer") is provable by construction (agent token for an `on` room throws; a compiled `@ts-expect-error` test pins it).
  - **`server/auth/peerToken.ts`**: `CAP_WRITE`, shape-validated `peerFromContext` (closes nit F-03 on the read path), authenticator return namespaced under `.peer` (closes nit F-04).

## 2. Decisions made and why
- **Write is a capability (`CAP_WRITE`), not a role.** Read-only peers exist without a separate role; propose/commit (P4.3) adds more caps through the same mechanism.
- **`mutatesState` allows the empty handshake.** A read-only peer still sends one no-op `syncStep2` (its empty diff); refusing it would loop-reconnect. So the gate fires only on updates that carry structs/deletes — not on the framing (both `syncStep2` and `messageYjsUpdate` are gated identically, since either can carry content).
- **Connection-grain backstop (4400), for now.** contract-1 §"two enforcement grains" sanctions a room-side backstop; op-grain rejection (drop the op, keep the connection) is exactly what P4.3 propose/commit provides. A well-behaved read-only peer never sends a mutating frame, so it observes uninterrupted.
- **Typecheck now covers `server/`.** `tsconfig include: ["src","server"]` — `admission.ts` was outside the tsc program (imported only by its server-side test), so it shipped unchecked and its contract-3 `@ts-expect-error` guard was inert. This was the adjudicator's one BLOCKING finding; fixed + probe-confirmed. No pre-existing server-tree type errors surfaced.

## 3. What was tested and how
- `npm run typecheck` clean (now covering `server/`) · **full suite 134/134** (was 125 pre-P4.2; +peerFromContext, +admission ×4 incl. compiled `@ts-expect-error`, +ingress ×3) against local `postgres:16-alpine`.
- **Sabotage/revert (four teeth):** write-cap gate off → no-write content not refused RED · `mutatesState` always-true → empty handshake refused/looped RED · admission mode hardcoded → on-room agent mints RED · `peerFromContext` role-check off → malformed context trusted RED. Each reverted green. (The empty-handshake tooth first exposed a racy assertion — fixed to a deterministic settle-window.)
- **Gate:** 3 parallel `inspector` agents (authZ-bypass / contract-1+3+7 conformance / wiring+test-rigor) → `adjudicator` → **BLOCK** (typecheck hole) → fixed (tsconfig, guarded decode, syncStep2 test) → re-verified **PASS-WITH-CARRYFORWARD, zero blocking**. `simplifier`: no changes warranted.

## 4. Files needing attention
- **Carry-forward to P4.3 (logged by the adjudicator, non-blocking):**
  - **F-04** — op-grain rejection (propose/commit) instead of connection-grain 4400 for write-cap violations. This is the core of P4.3.
  - **F-05** — room-derived cap-granting policy at the admission call site (who gets `CAP_WRITE`); zero prod callers today, so `issueRoomToken` forwards `req.caps` as-is for now.
  - **F-03** — type `IngressOptions.authenticate`'s return as `{ peer: PeerIdentity }` so a non-conforming authenticator (fail-open) becomes a compile error (now that `server/` is typechecked). Inert today (only `createPeerAuthenticator`; prod wires no `authenticate`).
  - The real spawn-store-backed `resolveRoomConfig` wiring (P4.2's resolver is injected/stubbed).
- **Test flake (pre-existing, not P4.2):** `src/doc/ingress.test.ts` P3.6 "structurally-corrupt payload" test failed once under full-suite pool contention, passes in isolation + re-runs; it wires no `authenticate` so the P4.2 gate no-ops for it (not causally reachable). Latent shared-Postgres-pool timing sensitivity across files.
- **Still open from P3.6/P3.5:** oversized-but-legit refuse (size-aware), `store.loadDocument` two-read txn, dedupe double `extractSyncUpdate`; `unhandledRejection` belt, reentrant same-owner compaction, `onStoreDocument` ordering.
- fable still rate-limited → Opus stand-in inspectors + adjudicator this session (same red/green discipline). Optional fable re-stamp later.
- Program status board (single source of truth): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2

## 5. Next step
**P4.2 landed (P4 2/5).** Next is **P4.3 — propose/commit as a generic peer capability**: a peer submits an update as a proposal the authority checks at apply time (spatial guard, pinned blocks, lease content-hash) instead of applying locally first — op-grain rejection that doesn't tear down the connection (closes F-04). Fold in the P4.2 carry-forwards: type `authenticate`'s return (F-03), and the cap-granting policy seam (F-05). Then P4.4 native headless-peer harness, P4.5 milestone e2e.
