# Relative viewport anchoring for multi-user documents

**A collaborative editor where remote edits above your viewport never move your screen.**

## The gap

Google Docs, Confluence, and Overleaf all transform the caret correctly through concurrent edits:
your cursor stays attached to the right text. None of them reliably transform the **camera**. Someone
inserting three paragraphs above your viewport shoves you down a screen. In paginated mode it is
worse, because an upstream insertion reflows page breaks. This is a long-standing complaint and it is
a separate problem from cursor anchoring, which is why solving the first did not solve the second.

## The mechanism

Store scroll position as `{blockId, offsetWithinBlock}`: an identity and an offset, never a pixel
value. On every remote operation, capture before the mutation, resolve to pixels after layout, and
write to `scrollTop` in the same frame before paint. Content under the camera stays fixed while the
document grows around it.

## What makes it non-trivial

- **Merges and deletions orphan anchors.** If your anchor block gets merged away, you snap to the top
  of the document. Consumed ids need to redirect to their successor so anchors resolve through the
  rename.
- **Browser scroll anchoring fights you.** Chromium and Firefox ship `overflow-anchor` and will
  compensate on their own. Usually you agree; when you do not, the browser wins and the artifact is
  worse than the original jump. Set `overflow-anchor: none` explicitly.
- **Variable-height content breaks the math.** You can measure the DOM for the pane you are
  rendering. For collaborators' positions you are working from estimated heights, and estimates
  drift.
- **Restore must be pre-paint.** Use `useLayoutEffect`, not `useEffect`, or there is a frame where
  the jump is visible.

## Substrate

CRDT relative positions (Yjs `RelativePosition`) give you an anchor that points at a character
identity rather than an index, so it survives concurrent edits without rebasing, at the cost of
carrying tombstones. OT position transformation is the alternative: cheaper storage, but every anchor
is a live object that needs the operation stream applied. Either way, the primitive gives you a
stable **anchor**, not a stable **viewport**. Height compensation is still yours to write.

### Substrate decision (from research)

The recommended substrate is **Yjs**, a CRDT, because:

- `Y.RelativePosition` gives the identity-based anchor above directly
  (`createRelativePositionFromTypeIndex` / `createAbsolutePositionFromRelativePosition`).
- The editor bindings already exist: `y-codemirror.next` for CodeMirror 6, `y-monaco` for Monaco.
- Presence rides a separate ephemeral channel (`y-protocols/awareness`) that never bloats the
  document, which is exactly what "one layout, N cameras" needs (see Extension).
- A headless agent can join the same room as a peer, which the attention-anchored offshoot depends on.

Google Docs uses Operational Transformation through a central server. That model is compact but hard
to inject a headless agent into, which is the opposite of what Scroll needs. See
[open-questions.md](open-questions.md) for the OT-vs-CRDT note.

## Extension: one layout, N cameras

Every collaborator's position anchors identically whether or not it is being rendered. That is what
**follow-mode** and **session replay** need underneath them: an offscreen collaborator stays anchored
exactly like the rendered one, so you can reconstruct or follow any camera at any time from the same
shared layout.
