# Scroll — concept

Scroll is the seed of a large app idea. This doc captures the whole idea as stated, before it gets
carved into phases. Treat it as the source of truth for intent; the roadmap and architecture docs
are derived from it.

## What Scroll is

A document app whose core primitive is **relative viewport anchoring**. In a collaborative editor,
concurrent edits above your viewport should never move your screen. Scroll treats the camera as a
first-class anchored object, not just the caret.

The app has a single-user mode where **endpoint spawning is a feature exposed in the app**. Two
spawners exist:

- **doc-es** — a document endpoint spawner (prose editor surface).
- **ide-es** — an IDE endpoint spawner (code editor surface) with **schema attachability** and a
  `create_ide_es` function, or similar spawn logic ("sl"), that spawns the endpoint.

The app is responsible for creating the single-person version of both ide-es and doc-es. A
programmatic consumer such as PersonalServer does not open an editor; it just **seeds the schema**
(goal condition, problem, test-case with a TLE budget, hints, and so on) and Scroll spawns the
endpoint from that schema.

## How it grows

1. **Single-user** editor with the relative-anchoring core, plus the doc-es / ide-es spawners.
2. **PersonalServer integration**: PersonalServer seeds an ide-es schema programmatically and gets a
   spawned endpoint back. This is the interview-problem path (see the separate interview-app design:
   Claude seeds a problem, Scroll hosts and grades it).
3. **Multi-user mode**, testable with two localhost instances on one laptop, to exercise the
   relative-anchoring viewport (rel anch vwprt) functionality with real concurrent edits.
4. **STARfolio as a second user**: extend multi-user so an AI interviewer can read the document.
   Open question: add native Scroll notepad / whiteboard surfaces for STARfolio to view, or let
   STARfolio add them and provision its own observability. The listening (reading the shared
   document as a peer) is trivial once multi-user works.
5. **App-native voice typing** in Scroll.
6. **Attention-anchored collaborative editor** as an offshoot and native value prop: users write, an
   agent reorganizes cold regions, and no one's viewport ever moves under them.

## Scoping note (which surfaces need which spawner)

- Only **single-user** and **multi-user-with-a-second-user-AI** need `ide_es` and `doc-es`.
- The **Scroll AI-editor value prop** (attention-anchored editing) only needs `doc-es`.
- Honestly, `doc-es` does not have to be an endpoint for the AI editor or for any part that only
  Scroll controls. It is an endpoint for **Open/Closed-principle adherence**: PersonalServer and
  STARfolio are expected to best control **endpoints**, not Scroll's native app processes. That is a
  thesis, not proven. See [open-questions.md](open-questions.md).

## Why this is worth preserving

Two independently valuable, publishable ideas fall out of the same anchoring primitive:

- Solving Google's long-standing multi-collaborator "jump" problem (camera anchoring, not just caret
  anchoring).
- An attention-anchored agent editor where an agent can reorganize a document without ever moving a
  human's screen, with legible provenance.

Both are captured in full in the architecture docs so the idea is not lost to a single conversation.
