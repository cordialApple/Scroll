# Whiteboard: build vs buy

The STARfolio coaching path (roadmap P4) wants a notepad and a whiteboard the AI interviewer can read.
That imposes three hard constraints that interact, and they eliminate most options fast:

1. **The AI reads shapes server-side.** This kills any end-to-end-encrypted canvas and any option
   where the server only holds an opaque blob it cannot decode into shapes.
2. **Yjs-native document elsewhere.** Scroll is Yjs everywhere (see
   [distributed-systems.md](distributed-systems.md)). A whiteboard on its own non-Yjs sync engine is a
   second engine to run.
3. **Commercial-friendly licensing.** This is where the most polished option gets expensive.

## The options

- **tldraw + tldraw sync.** Best editor, cleanest shape model: every shape is a plain typed JSON
  record (`TLRecord`), so server-side AI-readability is excellent. But tldraw sync is its own
  protocol, not Yjs (a second engine), and the license is the problem: production needs a license key,
  the free tier forces a "made with tldraw" watermark, and removing it for commercial use costs
  **$6,000/yr per team** (SDK 4.0, Sept 2025). Community and Liveblocks bindings can put tldraw shapes
  into a `Y.Doc`, but the fee still applies and you maintain the binding.
- **Excalidraw.** MIT, free, clean element-array JSON, drop-in React component. But its built-in
  collaboration is end-to-end encrypted (the key lives in the URL fragment, never reaches the server),
  so a server-side AI literally cannot read the canvas. The workaround is to not use Excalidraw's
  collab at all: embed `<Excalidraw/>` as a controlled component and sync elements through your own
  Yjs stack. At that point it is the "build custom" path with a nicer default editor and the hand-drawn
  look for free.
- **Custom on Konva.js + Yjs.** Represent the scene as a `Y.Map<shapeId, shape>` (or `Y.Array` of
  shape records), render with Konva (scene graph, hit-testing, serialization), sync with the existing
  Yjs stack. Server-side AI-readability is native, Yjs is native, licensing is MIT/$0. The cost is
  editor UX: selection, resize/rotate handles, snapping, z-order, undo (Yjs `UndoManager` helps), text
  editing, zoom. Months of work that tldraw and Excalidraw already solved. Add `perfect-freehand`
  (MIT, tldraw's freehand primitive) for the pencil and `rough.js` (MIT) for the sketchy look.
- **Liveblocks (managed).** Solves sync plus server-readable shape state via its API, at a usage-based
  cost and a hosting dependency. You still pick an editor on top.
- **React Flow (MIT).** If the "whiteboard" is really a node-and-edge graph, this is a cheaper, better
  fit than any of the above and stores plain JSON you can back with Yjs. Not freeform.
- **Miro / FigJam.** Non-options: no embeddable SDK, no server-side shape access.

## Recommendation

**Build custom on Konva.js + Yjs, with Excalidraw-on-your-own-Yjs as the strong runner-up.**

The reasoning: constraints (1) and (2) together mean the shapes should live in a `Y.Doc` the server
reads. Once you accept that, you want the shape store to *be* Yjs, not bolted onto a foreign engine.
Konva + Yjs gives native server-side readability and native Yjs for $0. tldraw is the best product but
the worst license fit here: you would pay $6,000/yr and still run a second sync engine or maintain a
Yjs binding, paying a premium to re-plumb the thing you paid for. Excalidraw's MIT license is great,
but its headline collab feature is E2E-encrypted and therefore useless to a server-side AI; stripped
to a controlled component on your own Yjs it is essentially the build path with a nicer starting
editor, so it is the runner-up and possibly the faster build.

**What would flip it:**
- Editor polish matters more than $6k/yr and Yjs-nativeness: adopt tldraw with a Liveblocks/community
  Yjs binding so shapes land in a `Y.Doc`.
- Want a finished editor for free and can redo sync: Excalidraw as a controlled component on Yjs.
- The surface is really a node/edge graph: React Flow on Yjs.
- Do not want to run sync infra at all: Liveblocks under whichever editor.

This resolves the research constraint noted in [open-questions.md](../open-questions.md) item 2 and in
[../integrations/starfolio.md](../integrations/starfolio.md): the earlier note said "use a plaintext
record store (tldraw), not E2E (Excalidraw)." The correction: tldraw's plaintext store is right for
AI-readability, but its license makes custom-on-Konva or Excalidraw-on-Yjs the better fit, and
Excalidraw is only disqualified in its *default E2E collab mode*, not as a component.

## Benefits / disadvantages

| Option | AI reads shapes server-side | Yjs-native | License / cost | Key disadvantage |
|---|---|---|---|---|
| tldraw + tldraw sync | Yes (TLRecord JSON) | No (own store) | $6,000/yr/team, or watermark | Cost + a 2nd sync engine |
| tldraw on Yjs (binding) | Yes | Yes | $6,000/yr still applies | You maintain the binding; fee remains |
| Excalidraw (built-in collab) | No (E2E ciphertext) | No | MIT, free | E2E blocks server AI; disqualified as-is |
| Excalidraw + own Yjs sync | Yes | Yes | MIT, free | You rebuild multiplayer |
| Custom Konva/Fabric + Yjs | Yes (native) | Yes | MIT, free | Months of editor UX |
| Liveblocks | Yes (REST/node) | Yes (Yjs option) | Paid SaaS | Hosting dependency; still need an editor |
| React Flow | Yes (JSON nodes) | Yes (you wire it) | MIT, free | Node-graph only |
| Miro / FigJam | No | No | SaaS | No embeddable SDK |

## Sources

- tldraw license (watermark, prod key): https://tldraw.dev/community/license
- tldraw license key requirement: https://tldraw.dev/sdk-features/license-key
- tldraw SDK 4.0 $6,000/yr pricing + backlash: https://biggo.com/news/202509190115_tldraw_SDK_4.0_Licensing_Debate
- tldraw sync (own protocol, TLRecord, self-host): https://tldraw.dev/docs/sync
- Liveblocks tldraw + Yjs example: https://github.com/liveblocks/liveblocks/tree/main/examples/nextjs-tldraw-whiteboard-yjs
- Excalidraw E2E encryption: https://plus.excalidraw.com/blog/end-to-end-encryption
- Excalidraw self-host vs collab-on-top: https://github.com/excalidraw/excalidraw/discussions/3879
- perfect-freehand (MIT): https://github.com/steveruizok/perfect-freehand
- rough.js (MIT): https://github.com/rough-stuff/rough
- Konva vs Fabric vs PixiJS: https://www.pkgpulse.com/guides/fabricjs-vs-konva-vs-pixijs-canvas-2d-graphics-2026
