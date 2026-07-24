# Boundaries and interface contracts

Decoupling that lives only in prose is not reviewable. This doc pins every cross-app interaction to a
**named contract** with an owner, an interface, an invariant, and a dependency direction, plus the
design pattern behind it. A reviewer checks the code against these contracts instead of reasoning from
vibes. Scroll, PersonalServer, and STARfolio are separate apps; the only things that may cross between
them are the contracts below.

## The one load-bearing rule: dependency direction

**Scroll depends on nothing. PersonalServer and STARfolio depend on Scroll's contracts.**

This is Dependency Inversion. Scroll defines the interfaces; consumers implement/consume them. The
arrow only ever points at Scroll. The single most checkable violation: if Scroll's code ever imports,
names, or branches on a consumer concept ("if interviewer", "if PersonalServer"), the arrow reversed
and the boundary is broken. Scroll must be buildable and testable with no knowledge that PersonalServer
or STARfolio exist.

## The contracts

| Contract | Owner | Consumers / implementers | Pattern | Invariant |
|---|---|---|---|---|
| **Peer protocol** | Scroll | native agent, STARfolio interviewer, humans | OCP + Adapter | The room is consumer-blind; every peer obeys the same discipline. |
| **Endpoint spawn schema** (doc-es / ide-es) | Scroll | PersonalServer, STARfolio | Factory + OCP | Neither side changes the schema alone; consumers seed, Scroll spawns/hosts/grades. |
| **Programmatic config** | Scroll | PersonalServer (on), STARfolio (off/on) | Strategy | Scroll owns the capability gates; a consumer only selects a preset. |
| **Grader / oracle** | Scroll | consumers propose problems only | trust boundary | The authoritative oracle is native and never consumer-controllable. |
| **Persistence / room ownership** | Scroll | (internal) | single-authority | Persist-before-ack; one owner per room; GC watermark. |
| **Result notification** | Scroll | PersonalServer, STARfolio | poll / opaque callback | Consumer-initiated; payload leaks no Scroll internals; the arrow never reverses. |
| **Peer credentials** | Scroll | any peer's operator | token issuance | Scroll is the sole trust root; roles are Scroll-asserted, never self-declared. |

## 1. Peer protocol (OCP)

The room defines what any peer may do: authenticate and join, observe (`Y.Doc` deltas + read
awareness), write (CRDT ops under the discipline in
[distributed-systems.md](distributed-systems.md)), and publish its own awareness. Scroll owns this
protocol. It does not own who the peers are or what intelligence drives them.

- **Closed to modification, open to peers.** Nobody edits Scroll to add a kind of agent. A new agent
  is a new peer that joins via the protocol. The interviewer is an extension, not a modification.
- **Consumer-blind.** No "interviewer" concept exists in Scroll. If a consumer's peer needs a
  capability, Scroll adds it as *a peer capability* any peer can use, never as a named special channel.
- **One discipline, two enforcement grains.** Room-enforced: auth, roles, ingress validation
  (refuse-and-resync — see "Rejecting an update" in
  [distributed-systems.md](distributed-systems.md)), propose/commit guards, awareness rate-limit/TTL,
  size and burst caps. Peer-obligated (the room cannot see intent): self-observation filtering by
  durable identity, quiescence, lease-guarded writes — backstopped room-side by per-peer write-rate
  and churn caps. Both grains apply to the native agent and the interviewer identically; the claim is
  never that the room enforces what only the peer's process can.
- **Propose/commit is a generic peer capability.** A peer may submit an update as a proposal the
  authority checks at apply time (spatial guard, pinned blocks, lease content-hash) instead of
  applying locally first. Any peer may use it; guarded agent writes must. It is part of the protocol,
  not a privileged path — the native agent and an external agent invoke the same capability through
  the same seam.
- **AuthZ at the seam.** Yjs has no built-in op validation, so a peer is authenticated, carries a
  role, and has its decoded ops validated in Scroll's authoritative process at ingress, before they
  are applied. Decoupled is not unauthenticated.
- **Scroll's own agent dogfoods the protocol.** The native attention-anchored agent joins through the
  exact seam consumers use, with no privileged in-process shortcut. This is what keeps the protocol
  from silently assuming in-process access and rotting.

The consumer side is an **Adapter**: STARfolio wraps its interviewer/voice intelligence to speak the
peer protocol. At the room boundary the interviewer is indistinguishable from a human, because there
is no privileged path for it to couple through.

Reviewer check: grep Scroll for any consumer name; confirm the native agent and an external peer take
the same join path (including propose/commit); confirm the room-enforced grain lives room-side, not
per-consumer, and that peer-obligated discipline has room-side backstops rather than being assumed.

## 2. Endpoint spawn schema (Factory + OCP)

`doc-es` and `ide-es` are the spawn seam. A consumer seeds a schema (for ide-es: goal condition,
problem, test-case + TLE budget, hints per [endpoint-spawners.md](endpoint-spawners.md)); Scroll's
`create_ide_es` produces the running endpoint and returns its URL. Scroll owns spawning, hosting, and
grading; the consumer owns seeding.

Invariant: neither side changes the schema unilaterally (the same discipline PersonalServer already
uses for the STARfolio config handshake). The schema is the entire contract; a consumer never reaches
past it into the app.

Reviewer check: the schema is the only input a consumer provides; the return is an endpoint URL, a
result URL (contract 6), and staged hints, nothing that leaks Scroll internals.

## 3. Programmatic config (Strategy)

`programmatic` is a Scroll-owned capability gate, and it is the Strategy pattern: the flag selects a
preset over Scroll-side capabilities (grader-gate, external-AI-peer admission, aux-surface
exposure). Capability names are generic on purpose — "coaching" is a consumer concept; STARfolio uses
the aux surfaces *for* coaching, but no Scroll identifier may say so. Scroll owns each capability and
each preset; a consumer only picks one.

- `on` (PersonalServer): bare seed-and-grade. No external AI peer may join, because Claude-in-
  conversation must be the only intelligence. Scroll *enforces* this; it is not a promise the consumer
  makes.
- `off` (STARfolio): AI-enhanced. An external AI peer may join.

The flag gates Scroll-side capabilities only. It does not reach into what STARfolio's own AI does in
`off` mode; STARfolio owns its interviewer/voice behavior. Long-term the flag is likely a composition
of capability gates, not a binary, but each gate stays Scroll-owned. See
[integrations/starfolio.md](../integrations/starfolio.md).

Reviewer check: the mode's effects are enforced in Scroll, not assumed by a consumer; `on` provably
admits no AI peer.

## 4. Grader / oracle (trust boundary)

The authoritative graded oracle (hidden tests, reference solution, TLE budget) and the untrusted-code
sandbox are native to Scroll, in-app **by necessity, to keep them out of a consumer's reach**. A
consumer may *propose* problems that get vetted into a bank; an unvetted AI-authored oracle never hard-
gates a real submission. See [open-questions.md](../open-questions.md) item 3 and
[integrations/personalserver.md](../integrations/personalserver.md).

Reviewer check: no path lets a consumer's seeded schema drive the grading verdict; the sandbox lives
in Scroll, never in the C# MCP server.

## 5. Persistence / room ownership (single-authority)

Internal, but a contract the store upholds: persist-before-ack, single-authority-per-room, and the GC
watermark. Consumers never touch it. See
[storage-and-persistence.md](storage-and-persistence.md) and
[distributed-systems.md](distributed-systems.md).

## 6. Result notification (consumer-initiated)

A spawned endpoint's outcome — the ide-es verdict, lifecycle events — must reach the consumer
(Claude needs to know the user passed to continue the conversation) without reversing the arrow.
`create_ide_es` returns, alongside the endpoint URL, a **result URL** the consumer polls (or holds an
SSE subscription against). Optionally the seed schema may carry an opaque callback URL; Scroll POSTs
the same payload there fire-and-forget. An opaque consumer-supplied URL is data, not a dependency:
Scroll gains no consumer concept by calling it. The payload is endpoint id, verdict (pass/fail,
within-budget), and timestamps — nothing that leaks Scroll internals.

Reviewer check: notification is pull-by-default; any push target is consumer-supplied opaque data
from the seed schema; the payload exposes no internal state; Scroll retries/aborts blind, never
special-cases a consumer.

## 7. Peer credentials (trust root)

Contract 1 says a peer is authenticated and carries a role; this contract says who issues that
credential — the missing handshake is itself a cross-app interaction. **Scroll is the sole trust
root.** A consumer that wants its peer admitted (STARfolio's interviewer) requests a **room-scoped
peer token** through the spawn/admission seam; the token carries identity, a Scroll-asserted role
(`human` / `agent`), capability grants (e.g. propose/commit), and an expiry. Scroll validates only
tokens it issued: no federation, no consumer-issued identity, no self-declared roles. This is also
how contract 3 becomes mechanical: a `programmatic: on` preset simply never issues an `agent`-role
token, which is what "admits no AI peer" means in code.

Reviewer check: no path admits a peer whose credential Scroll did not issue; role and capabilities
come from the token, not from the peer's claims; token scope is one room.

## Patterns, named

- **Dependency Inversion** — Scroll defines interfaces; consumers depend on them; the arrow never
  reverses. The root rule.
- **Open/Closed** — the room and the spawn seam are closed to modification, open to extension (peers
  join, consumers seed schemas).
- **Strategy** — `programmatic` selects a Scroll-owned capability preset.
- **Factory** — `create_ide_es` builds an endpoint from a schema.
- **Adapter** — a consumer wraps its own intelligence to speak Scroll's peer protocol.

## Review checklist (for Fable)

1. Does any Scroll source name or branch on a consumer concept? (Must be no.)
2. Do the native agent and an external peer share one join path and one discipline?
3. Is every consumer interaction expressible through one of the seven contracts, with nothing
   reaching past a contract into app internals? (Including the return path: results reach a consumer
   only via contract 6, credentials only via contract 7.)
4. Is `programmatic` enforced Scroll-side, and does `on` admit no AI peer?
5. Can a consumer's seeded schema ever influence the grading verdict? (Must be no.)
6. Is the schema/protocol changed only bilaterally, never by one side alone?
7. Is Scroll buildable and testable with zero knowledge that PersonalServer or STARfolio exist?

## Anti-patterns (smells that mean a boundary broke)

- A consumer name inside Scroll.
- A privileged in-process path for the native agent that the peer protocol does not expose.
- A capability added "for the interviewer" instead of as a generic peer capability.
- A consumer able to change the ide-es schema or the graded oracle on its own.
- `programmatic` semantics defined or enforced on the consumer side.
