# CONTEXT.md

_Last updated: 2026-07-26 · branch: main · session: P4.1 contract-7 room-scoped peer tokens landed — **P4 underway (1/5)**_

## 1. What changed this session
- **Program status correction (landed first).** Status board (https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2) refreshed to current reality: **Recall_Seed 95%→100% of its north-star role**, P3 **CLOSED 6/6**, P4 now the active critical path, north-star ~46%→~68%. **Online portability explicitly parked under P4/beyond** — every seam is localhost/single-server today (Recall_Seed binds `127.0.0.1`; one Yjs authority per process); making it work online (non-localhost callbacks, single-authority-per-room under real deployment, tokens over the wire) is deferred deliberately and is NOT counted against any repo's role score. That carve-out is exactly why Recall_Seed reads 100%. Program-map memory updated to match (and its stale `PersonalServer_` path corrected to `Recall-Seed`).
- **P4.1 (#42, PR #43)** — the P4 on-ramp becomes a real **contract-7 trust root**. P3.6 left a flag-gated `onAuthenticate` **stub**; P4.1 makes Scroll the sole issuer+verifier of room-scoped peer tokens.
  - **`server/auth/peerToken.ts`** (new): `mintPeerToken` + `verifyPeerToken` + `createPeerAuthenticator`. HMAC-SHA256 compact token (`payload.sig`), dependency-free (`node:crypto`) — symmetric because Scroll is both sole issuer and sole verifier (asymmetric buys nothing). Claims `{ v, sub, role: 'human'|'agent', caps, room, iat, exp }` live inside the MAC ⇒ role/caps/room are Scroll-asserted, never self-declared. Verify enforces timing-safe (length-guarded) signature, version, role enum, **expiry**, **room-scope**; returns typed `PeerIdentity`. **contract-3 baked in**: mint throws for `mode:'on' + role:'agent'` ("admits no AI peer" in code). Non-finite `ttlMs` rejected at mint (F-01 hardening).
  - **`server/db/ingressExtension.ts`**: widened `authenticate` seam to `(token, { documentName }) => ...` and pass `documentName` through `onAuthenticate` ⇒ room-scope enforced against the **real joined room**, not a peer claim. Resolves the P3.6 typed-`onAuthenticate` carry-forward.

## 2. Decisions made and why
- **Symmetric HMAC, not asymmetric.** contract-7: Scroll validates only tokens it issued; no third party verifies. A single secret is the whole trust root — asymmetric keys add machinery for a verifier that doesn't exist.
- **Room-scope keyed on Hocuspocus `documentName`.** The connection's room is authoritative server-side; enforcing scope against it (not a peer-supplied field) is what makes "token scope is one room" un-spoofable. Confirmed in the dist that `documentName` is spread after the hook payload, so it's the actual joined room.
- **contract-3 gate at issuance, `mode` as a parameter (for now).** The token primitive takes `mode`; binding `mode` to authoritative room/schema state is the admission handler's job (next stage) — the primitive is the right altitude. `mint`/`verify` have zero production callers yet, so nothing shippable can violate §3 today.
- **F-01 hardened early, not deferred.** Non-finite `ttlMs`→`exp`=NaN/Infinity would never expire; unreachable today (literal callers) but arms the instant P4.2 computes `ttlMs`. Closed at the source per the adjudicator's recommendation.

## 3. What was tested and how
- `npm run typecheck` clean · **full suite 125/125** (was 115 pre-P4.1; +9 unit in `server/auth/peerToken.test.ts`, +1 over-the-wire integration in `src/doc/ingress.test.ts`) against local `postgres:16-alpine`.
- **Sabotage/revert (four teeth):** signature check off → tamper+wrong-secret RED · room-scope off → wrong-room RED · expiry off → expired RED · contract-3 gate off → agent-mint RED. Each reverted to green.
- **Gate:** 3 parallel `inspector` agents (crypto-forgery / contract-7+3 conformance / seam-wiring+test-rigor) → `adjudicator` → **PASS-WITH-CARRYFORWARD, zero blocking**. F-01 hardened in-tree before merge. `simplifier` pass applied (hoisted a duplicated `connectWithToken` test helper).

## 4. Files needing attention
- **Carry-forward to P4.2 (logged by the adjudicator, non-blocking):**
  - **F-02** — the admission/issuance handler must derive `mode` from authoritative room/schema state (never a caller arg), and consider stamping `mode` into `PeerClaims` for a verify-side backstop. §3 "on provably admits no AI peer" becomes load-bearing the instant a real minter exists.
  - **F-03/F-04** (nits) — element-type checks on `sub`/`caps` in verify; namespace the `PeerIdentity` context spread if a second extension ever writes connection context.
- **Still open from P3.6/P3.5 (deployment-epic latent):** oversized-but-legit refuse (size-aware), `store.loadDocument` two-read transaction, dedupe double `extractSyncUpdate`; F-02 `unhandledRejection`, F-04 reentrant same-owner compaction, F-05 `onStoreDocument` ordering.
- fable still rate-limited → this session's gate used Opus stand-in inspectors + adjudicator (same red/green discipline as P3.2–P3.6); optional fable re-stamp later.
- Program status board (single source of truth): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2

## 5. Next step
**P4.1 landed (P4 1/5).** Next is **P4.2** — thread the authenticated `PeerIdentity` (role/caps) from `onAuthenticate` into the ingress path so `beforeHandleMessage` op-validation is role-aware, add the room-enforced grain (per-peer write-rate + awareness rate-limit/TTL caps), and stand up the admission/issuance handler that mints tokens with a room-derived `mode` (closes F-02). Then P4.3 propose/commit, P4.4 headless-peer harness, P4.5 milestone e2e.
