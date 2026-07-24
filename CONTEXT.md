# CONTEXT.md

_Last updated: 2026-07-23 · branch: main · session: P0 built from the brief, verified live in browser, committed_

## 1. What changed this session
- **P0 shipped.** Built the full single-user anchored editor from `docs/p0-build-brief.md`: React + TS + Vite, Yjs (`gc:false`) + y-indexeddb, custom virtualized block layer. ~1200 LOC under `src/`.
- Core anchoring split into pure, tested modules: `src/layout/layout.ts` (anchor-centric window + `computeLayout`/`deriveAnchor`/`windowFor`), `src/doc/model.ts` (block projection over `Y.Doc`), `src/doc/redirects.ts` (transitive consumed-id table, cycle guard), `src/doc/camera.ts` (`{blockId,offset}` persist), `src/doc/persistence.ts` (`'synced'` gate).
- `src/editor/Editor.tsx`: virtualized render window + pre-paint anchor hold (`useLayoutEffect` scrollTop correction), height measurement/settle loop, split/merge, redirect fallback for the anchor.
- Chrome: `MenuBar` + `Toolbar` styled to Google M3 dark; `src/theme.css` = the brief's exact token set; `index.html` sets `color-scheme:dark` + dark bg inline (no white flash).
- Dev-only: `src/dev/synthetic.ts` (insert/delete/merge above), `window.__scroll` handle, three toolbar test buttons.

## 2. Decisions made and why
- Carried the brief's 7 hard requirements verbatim — no trades. Block model is a projection of the `Y.Doc`, not a parallel store.
- Anchor held pre-paint by measuring the anchor block's live `getBoundingClientRect().top` and correcting `scrollTop` in `useLayoutEffect` (suppressing the resulting scroll event), rather than trusting estimated heights — estimates only feed scrollbar geometry.
- Height settle loop capped at 4 passes per window key to avoid infinite measure→re-render.

## 3. What was tested and how
- `npm test` — 12/12 pass, incl. all four milestone criteria (insert-above, delete-above, merged-anchor redirect, reload restore) in `src/test/milestone.test.ts`. `npm run typecheck` clean.
- **Verified live in Chrome:** seeded 400 blocks, scrolled mid-doc (top = "Paragraph 38" @5px), clicked "+50 above camera" → top stayed exactly "Paragraph 38" @5px, scrollTop 1108→3398, only ~147/452 blocks in DOM. Virtualization + anchoring confirmed in the real DOM. No console errors. Visual = convincing Google Docs M3 dark. Cleared the test IndexedDB after.

## 4. Files needing attention
- `docs/architecture/boundaries.md` — wire schemas still prose only; pin as versioned files **before P1**, not needed for P0.
- Nothing broken. Build is green and committed.

## 5. Next step
P0 is done and committed — **stop per the brief.** P1 (endpoint spawners / schemas) starts only after the wire schemas in `endpoint-spawners.md` + `boundaries.md` are pinned as versioned files. If continuing to polish P0 instead: real caret/selection styling and menu/dropdown behavior are stubbed.
