# Fable review brief

Hand this to Fable: "Read docs/fable-review-brief.md and do it."

You are reviewing the planning-doc set for **Scroll**, a CRDT collaborative document app. No code
exists yet. These are plans. Your job is an **adversarial review**, not a summary and not
encouragement. Assume the plans are wrong until they survive your attack. Priority order of what
matters: (1) distributed-systems soundness, (2) boundary / decoupling integrity, (3) whether the two
value props are actually buildable as described.

## Read first

- `docs/architecture/distributed-systems.md` — the hard core. It ends with **8 pre-answered reviewer
  questions**. Try to break each pre-answer, do not accept them.
- `docs/architecture/boundaries.md` — **five interface contracts + a 7-item review checklist**. Run
  the checklist against the whole doc set; hunt for cross-app interactions the five contracts do not
  cover.
- `docs/architecture/storage-and-persistence.md` — durability and GC rules.
- `docs/architecture/relative-viewport-anchoring.md` and `attention-anchored-editor.md` — the two
  value props.
- `docs/open-questions.md` — live forks. Do **not** re-flag these as findings; instead judge whether
  any is mis-leaning, and whether the plan commits to something a still-open fork should gate.

## Attack these specifically

1. **Single-authority-per-room.** Is the split-brain window actually closed or only named? Trace a
   Durable Object migration, a rolling deploy, and a network partition. Where can two owners accept
   writes for one room, and what exactly corrupts?
2. **Persist-before-ack.** Trace a crash between broadcast and durable write. Does the self-heal story
   hold if the only client still holding the lost op disconnects before reconnecting?
3. **GC watermark.** Is `gc:false` forever the real plan? What reclaims memory over a multi-year,
   heavily-edited document? Does the snapshot/version-reset story contradict anything in
   storage-and-persistence.md, and can history survive a reset?
4. **Agent-as-peer.** Are the self-observation, stale-position, and awareness mitigations sufficient
   or hand-waved? The native agent and the STARfolio interviewer are claimed to share one discipline
   enforced at the room boundary — is that actually enforceable, or does one of them need a privileged
   path the plan denies exists?
5. **Dependency direction.** Find any place a plan implies Scroll must know a consumer concept, or any
   contract that leaks Scroll internals to a consumer. This is the load-bearing rule; break it if you
   can.
6. **Relative viewport anchoring.** Offscreen/collaborator cameras run on estimated heights that drift
   (open-question #5). Is the value prop viable before that is solved, and is the drift-correction gap
   under-specified?
7. **Contradictions.** Any two docs that disagree. Any invariant stated in one place and violated by a
   design choice in another.

## Output format

For each finding:
- **Doc + section.**
- **Flaw** in one sentence.
- **Failure scenario**: concrete inputs / state leading to a wrong outcome.
- **Severity**: blocking / serious / minor.
- **Fix or open question** that must be answered.

Rank blocking first. End with **one verdict**: is the distributed-systems core iron-tight enough to
start P0 (single-user editor + relative-anchoring core), or not, and name the single most important
thing to fix before any code.

Do not soften findings to be agreeable. A finding you are only 60% sure of is still worth raising,
labeled **plausible**.
