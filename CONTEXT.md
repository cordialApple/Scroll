# CONTEXT.md

_Last updated: 2026-07-26 · branch: p5.3-dictation-ui (PR #57 open, `Closes #56`, CI running) · session: P5.3 dictation UI + wiring + e2e — closes P5_

## 1. What changed this session
- **P5.3 (#56, PR #57) — dictation at the real UI surface. Closes P5.** The P5.1 in-memory composition + P5.2 headless adapter now meet a real mic behind shipping UI, with a milestone e2e.
  - **`src/chrome/MicButton.tsx`** — mic button (idle/listening/error) + interim preview overlay (preview-only, italic + dashed, `pointer-events:none`) + hard-error toast. Mounted via a new `extra` slot on `Toolbar`.
  - **`src/voice/useVoice.ts`** — React hook composing `createDictation` + `createWebSpeechTranscriber` (or the fake under DEV `?voice=fake`). Holds the advancing `activeTarget` (snapshot from `editor.dictationTarget()` on `→listening`, advanced by `observeCommit`), and **self-heals** to the live editor caret when the target block no longer resolves. Cleanup calls `transcriber.stop()` (mic release on unmount).
  - **`src/editor/Editor.tsx`** — tracks the live caret via a `document` `selectionchange` listener (walks to the nearest `[data-block-id]`), exposes `dictationTarget()` on `EditorApi`. The target survives focus leaving for the mic button.
  - **[C2] DECIDED** — the UI subscribes to the **raw `Transcriber`** for lifecycle/state/errors; `Dictation` stays text-only. Engine lifecycle ≠ doc mutation; keeps the P5.1 interface clean.
  - **P5.2 carry-forwards [B1]–[B5]/[A1] folded in** (real recognizer now reaches them): [B1] narrowed `start()` catch (+ [F-04] `isInvalidState` duck-types `.name`, since a real InvalidStateError is a DOMException, not `instanceof Error`); [B2] instance-identity guard (`detach()` nulls handlers + `abort()`s, all handlers wrapped `recognition === rec`); [B3] transient-restart backoff/cap/dedup; [B4] `audio-capture` kind + hard-path; [B5] suppress `aborted` emit on intentional stop; [A1] append-only fail-safe test.
  - **`e2e/voice.spec.ts`** — fake injected via DEV `?voice=fake`, driven through `window.__scroll.voice`. Proves: interim overlay shows and never mutates the doc; the final lands at the caret in the correct block (asserted via the **doc**, since a focused block skips DOM sync); an off-screen block demonstrably **grows** while the on-screen anchored camera holds (non-vacuous anti-jump).

## 2. Decisions made and why
- **[C2]: UI ↔ raw Transcriber; Dictation stays text-only.** Lifecycle/error belong to the engine; `Dictation` is doc mutation (interim + commit). A `MicButton` given both objects composes them in the React layer — the P5.1 "prove the composition" philosophy — instead of growing `Dictation` with an error passthrough that just proxies two concerns.
- **e2e asserts via the doc, not the DOM.** A contentEditable block that is focused skips `innerText` sync (`Block.tsx`), so dictated text only appears in Yjs while focused. The milestone reads `blockTextString(doc, id)`; to prove real layout growth it blurs the target first.
- **Anti-jump scoped to the below-camera case (on purpose).** Dictation happens at an on-screen caret → the caret block sits at/below the anchor. The e2e edits an off-screen block **below** the camera and proves the anchor holds. Editing **above** the camera hits a pre-existing measurement lag (see §4) — out of scope for a voice PR.
- **Restart-cancellation via `epoch`, not timer handles.** `start()`/`stop()` bump `epoch`; a scheduled restart captures its epoch and no-ops if it moved. Simpler than threading `clearTimeout` handles, and `detach()` aborting the superseded instance is belt-and-suspenders against an orphaned live mic.

## 3. What was tested and how
- `npm run typecheck` clean · `npm run build` clean · **unit 188/188** (voice suite 28: adapter incl. new [B1]/[B2]/[B3]/[B4]/[B5]/[A1]/[F-02]/[F-04] teeth + dictation) · **e2e 12/12** incl. the new P5 milestone. CI (#57): typecheck/test/build + playwright e2e running at handoff.
- **Sabotage teeth (F-02, RED→GREEN, adjudicator-verified):** drop the `epoch` guard → the stale-restart-orphan test goes RED; drop `detach()`'s `abort()` → the belt test goes RED.
- **Gate:** simplifier (nothing to tidy, twice) → 3 parallel `inspector`s (transcriber carry-forwards / wiring+caret / UI+e2e) → `adjudicator`: **2 blockers + 5 warnings → all fixed → re-adjudicated PASS-WITH-CARRYFORWARD.** The two blockers were both orphaned-live-mic leaks (teardown missing `stop()`; uncancelled restart timer).

## 4. Files needing attention (carry-forward, adjudicator-logged, non-blocking)
- **[Editor layer — above-camera measurement lag]** `Block.tsx` syncs a non-focused block's `innerText` in a passive `useEffect` (after paint); the Editor measures/corrects in `useLayoutEffect` (before paint). A programmatic text-grow of a rendered **above-camera** block is measured stale → the camera drifts by the growth until the next unrelated render. **Pre-existing** (Block.tsx untouched by P5.3); reachable by any above-camera programmatic mutation (remote-peer edit, undo, synthetic insert), not just voice. Fix direction: move the sync to `useLayoutEffect`, or per-block `ResizeObserver`, or force a re-measure render after sync. Pin with a skipped/`fixme` e2e so it isn't later mistaken as covered.
- **[Test debt]** No `useVoice.test.ts`. [F-01]'s mic-release-on-unmount is a one-line fix with no dedicated tooth — add a `renderHook` test: start → unmount → assert `transcriber.stop()` called / state idle.
- **[Coverage]** The e2e never drives the error/toast path end-to-end (network give-up / unknown-throw → toast). [F-03] is unit-covered only.
- **Still open from prior phases:** [I3-F2] shared-pool flake (P4 infra debt, green when Postgres is up), [I3-F6] `sinkSocketError` private-`webSocket` cast in `headlessPeer.ts`, and the P6-deferred `resolveRoomConfig`/`grantCaps` + concrete `ProposalGuard` + agent→propose-only cap policy.
- Program status board (single source of truth): https://claude.ai/code/artifact/594fb42d-ae43-44e9-b903-acc5d33e9de2 — **refreshed this session** (P4 CLOSED 5/5, P5 building 2/3, north-star ~90%). Bump P5 → CLOSED 3/3 once #57 merges.

## 5. Next step
**P5 is closing (#57 merging).** Two directions, both Scroll-owned:
- **P6 — attention-anchored agent editor** (the native expression of agent-as-peer): Scroll's own dogfooded agent reorganizing cold regions while no human viewport moves. This is where the **above-camera measurement lag** (§4) becomes load-bearing — an agent editing above the human caret is exactly the flow that lag breaks — so fix that Editor-layer defect first (it also hardens remote-peer/undo edits). Depends on the P6-deferred `resolveRoomConfig`/`grantCaps` + `ProposalGuard` + agent→propose-only cap policy.
- **P5 hardening** (optional, quick): land the three carry-forward test/coverage items above before moving on.
