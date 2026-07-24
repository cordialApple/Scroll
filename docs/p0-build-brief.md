# P0 build brief (for the implementing agent)

You are building **P0 of Scroll only**: the single-user editor with the relative-anchoring core.
Read [roadmap.md](roadmap.md) P0, [architecture/relative-viewport-anchoring.md](architecture/relative-viewport-anchoring.md),
and [architecture/storage-and-persistence.md](architecture/storage-and-persistence.md) P0 section
before writing code. Everything else in the doc set is context, not scope.

## Scope

**In:** block-based prose editor, one user, one browser, local persistence, the anchoring core, the
P0 milestone test.

**Out — do not build, stub, or scaffold:** endpoint spawners (doc-es/ide-es), schemas, the grader,
`programmatic` config, rooms, websockets/Hocuspocus, awareness, peer tokens, the agent, multi-user
anything, consumer anything (PersonalServer, STARfolio). P1+ owns all of it. If a P0 choice would
make P3 multi-user a rewrite, stop and reconsider — the whole point of using Yjs now is that
multi-user later is additive.

## Hard requirements (from the reviewed architecture — do not trade these away)

1. **`Y.Doc` is the substrate**, constructed with `gc: false`. All document content lives in Yjs
   types; the block model is a projection of the doc, not a parallel store.
2. **`blockId` is an app-level stable id** stored as a block attribute — never a Yjs internal id,
   never derived from `(clientID, clock)`. Anchors must survive a future epoch reset.
3. **Camera = `{blockId, offsetWithinBlock}`**, never a pixel value, never document-top `scrollTop`.
   Resolve to pixels at layout time; restore pre-paint (`useLayoutEffect`); `overflow-anchor: none`
   set explicitly.
4. **Anchor-centric virtualized layout.** The render window is positioned from the anchor block
   outward. Estimated heights above the window may only affect scrollbar geometry — they must never
   move the anchor block on screen. Entering an estimated region measures and re-anchors.
5. **Consumed-id redirect table** is CRDT data in the same `Y.Doc`
   (`Y.Map<consumedId, successorId>`), written in the same transaction as the merge; resolution is
   transitive with a cycle guard.
6. **Persistence: y-indexeddb.** Gate first render on its `'synced'` event — no flash of empty doc.
7. **No consumer names anywhere in the code.** Grep-clean for "PersonalServer", "STARfolio",
   "interviewer" (boundaries.md checklist item 1 applies from the first commit).

## Milestone (acceptance test, automated)

With a synthetic op stream inserting and deleting variable-height content above the camera, the
viewport does not move — **with virtualization on**. An unvirtualized pass proves nothing. Also
cover: anchor block merged away (redirect resolves, no jump), reload restores camera from persisted
`{blockId, offset}`.

## Visual design: Google Docs dark mode, in every aspect

The app must read as Google Docs' dark theme throughout — chrome, canvas, menus, scrollbars, states.
No light-mode-first styling, no white flashes anywhere (set `color-scheme: dark`, dark loading
state, dark before-`'synced'` state).

Fidelity note: Google Docs *web* has no official dark mode; the reference is Google's **Material 3
dark** as shipped in Drive/Gmail/Docs-mobile, which is also what the highest-fidelity community
Docs-dark theme (dark-docs, M3 variant) replicates. The tokens below are that verified set — define
them as CSS custom properties and use nothing outside them.

**Surfaces (elevation ladder — every layer has its exact gray):**

- `--surface: #1f1f1f` — app canvas and base chrome
- `--surface-container-lowest: #0e0e0e` — deepest recesses (wells, code-block gutters)
- `--surface-container-low: #28282a` — the document page ("sheet"): centered column, max-width ≈
  816px (8.5in feel), generous top margin, Material level-2 shadow
- `--surface-container: #2d2e31` — toolbar pill, cards
- `--surface-container-high: #313336` — menus, dropdowns, dialogs
- `--surface-container-highest: #444746` — tooltips, text-field fills

**Text:**

- `--on-surface: #e3e3e3` — primary text (UI and default document text)
- `--on-surface-variant: #c4c7c5` — secondary/muted text, placeholder, inactive icons
- Disabled: `rgba(227,227,227,0.12)`

**Accent (Google Blue, M3 dark):**

- `--primary: #a8c7fa` — links, focus rings, active controls, filled-button background
- `--on-primary: #062e6f` — text/icons on a filled primary button
- `--primary-container: #004a77` / `--on-primary-container: #c2e7ff` — chips, selected states
- Legacy M2 blue `#8ab4f8` acceptable for caret/selection tint; selection highlight = translucent
  primary over the sheet
- Active-state ripple/tint: `#394457`

**Outline / dividers / semantic:**

- `--outline: #8e918f` — borders on outlined buttons, scrollbar thumb
- `--outline-variant: #444746` — hairline dividers, menu separators
- Error `#f2b8b5`; success/suggesting green `#6dd58c` (Docs' suggestion-mode color); comment yellow
  `#fdd663`

**State layers (M3 spec):** hover = 8% on-surface overlay, focus/pressed = 12%, dragged = 16%.
Menu-item hover concretely lands near `#4a4e51` on a `#313336` menu.

**Shape:** radius scale 4 / 8 / 12 / 16 / 28px — 4–8 for small controls and menu items, 12 for
cards/popovers, 28 for large dialogs. Toolbar is a full-width rounded pill of grouped controls with
thin `--outline-variant` separators.

**Elevation shadows (M3):**

- Menus/popovers: `0 2px 4px -1px rgba(0,0,0,.2), 0 4px 5px 0 rgba(0,0,0,.14), 0 1px 10px 0 rgba(0,0,0,.12)`
- Dialogs: `0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12)`

**Typography:** UI stack `'Google Sans', Roboto, RobotoDraft, Helvetica, Arial, sans-serif`
(system grotesque fallback fine — do not ship Google Sans itself, it is not freely licensed; Roboto
is). Document body defaults to Arial/Helvetica at Docs-like 11pt-equivalent with Docs-like
line-height (~1.5).

**Structure and feel:**

- Top chrome like Docs: slim menu-bar row (File/Edit/View…), then the toolbar pill row; Material
  icon style; compact density
- Document is a lit page on a dark desk — the sheet (`#28282a`) is *lighter* than the canvas
  (`#1f1f1f`), never white
- Scrollbars: thin, `--outline` thumb on transparent/dark track, visible-on-hover
- Caret and (future) collaborator affordances follow Docs conventions: colored caret, name flag —
  P0 needs only the local caret, but style it now
- Every state screen (empty doc, loading, error) stays in-palette; tooltips on
  `--surface-container-highest`

"Aesthetic in every aspect" means a screenshot of any corner of Scroll should be mistakable for a
Google M3 dark app. When a component has no token above, derive it from the elevation ladder, never
invent a new gray.

## Stack (suggested, not sacred)

React + TypeScript + Vite. Yjs + y-indexeddb. Custom block layer over `Y.Doc` (editor libraries are
fine underneath if they don't fight requirements 3–5; most virtualized-list libraries *will* fight
requirement 4 — expect to own the layout loop).

## When P0 is done

Stop. P1 (spawners/schemas) starts only after the milestone test passes and the wire schemas —
fields in [architecture/endpoint-spawners.md](architecture/endpoint-spawners.md), contract rules in
[architecture/boundaries.md](architecture/boundaries.md) — get pinned as versioned files.
