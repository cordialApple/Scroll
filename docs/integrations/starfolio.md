# Integration: STARfolio

STARfolio is a private Electron app (the career-experience / interview product). It is the second
Scroll consumer and the one that brings AI-enhanced behavior.

## STARfolio as a second user

Once Scroll's multi-user mode works (roadmap P3), STARfolio joins a Scroll session **as a second
peer**. Its AI interviewer reads the shared document live, the same way any human collaborator would.
Reading the document as a peer is trivial once multi-user exists; the hard part (relative-viewport
anchoring, one-layout-N-cameras) is already done by then.

## Config: programmatic off (AI-enhanced)

STARfolio calls the endpoint with `programmatic: off`, the AI-enhanced tutoring path. Scroll provides
the surfaces and the shared document; STARfolio brings its own AI layer and voice infrastructure to
coach against them.

The flag itself is **Scroll-owned** (a Strategy over Scroll-side capability gates: grader, external-AI-
peer admission, aux surfaces — which STARfolio uses as coaching surfaces; the Scroll-side name stays
generic). STARfolio does not define the mode; it **selects** a Scroll-defined
one, and may surface a user-facing "bare vs coached" toggle that picks which value to send. `off` is
what admits STARfolio's interviewer as a peer. See
[../architecture/boundaries.md](../architecture/boundaries.md) contract 3.

## Open fork: who owns the notepad / whiteboard surfaces

Two branches:

- **Native to Scroll** — Scroll ships notepad and whiteboard surfaces, and STARfolio just observes
  them as a peer. Cleaner boundary; Scroll owns all editing surfaces.
- **STARfolio adds them + observability provisioning** — STARfolio contributes the extra surfaces and
  provisions its own observability into them.

**Leaning (recorded): native to Scroll.** The boundary model forces it: the seven contracts in
[../architecture/boundaries.md](../architecture/boundaries.md) claim to cover everything that
crosses, and STARfolio-provided surfaces would be consumer code living inside Scroll's room with no
contract governing it — taking that branch means drafting a new "consumer-contributed surface"
contract first, not a smaller decision. Native keeps every surface behind the existing peer protocol.
The tooling side is researched in
[../architecture/whiteboard.md](../architecture/whiteboard.md): a server-side AI cannot read an
end-to-end-encrypted canvas (Excalidraw's default), so the shapes must live in a store the server
decodes. Leaning is **custom on Konva + Yjs** (native Yjs, native server-side readability, MIT), with
Excalidraw-as-a-component-on-Yjs the runner-up; tldraw is best-in-class but $6,000/yr and a second
sync engine. What stays undecided here is only **ownership** (native to Scroll vs STARfolio-provided),
not the tech. See [open-questions.md](../open-questions.md) item 2.

## The agent as a peer

The AI interviewer is a **headless peer** in the Scroll room: it holds the same `Y.Doc`, observes
`Y.Text` deltas and awareness (each camera's `{blockId, offset}` and cursor), and writes back through
CRDT mutations plus its own awareness state ("looking at lines 10-14"). This is the same peer model
the native attention-anchored agent uses; here the agent is external (STARfolio) instead of native.

The peer protocol is Scroll-owned and consumer-blind: the interviewer is *an instance*, not a
first-class Scroll concept. STARfolio wraps its own interviewer/voice intelligence to speak the
protocol (an Adapter), and at the room boundary it is indistinguishable from a human. The ownership
rules, the discipline every peer obeys, and the review checklist are in
[../architecture/boundaries.md](../architecture/boundaries.md).

## Voice

Scroll should have **app-native voice typing** (roadmap P5). STARfolio has its own voice / ASR
infrastructure for the coaching side. The two are separate: Scroll's voice typing is an input method;
STARfolio's voice is the interviewer speaking and listening.
