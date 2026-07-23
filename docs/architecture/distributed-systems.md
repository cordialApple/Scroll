# Distributed-systems correctness (the hard core)

This is the doc to attack. Scroll is a CRDT collaborative editor with server persistence and, later,
a headless agent that writes to the same document. Everything below states what the design can rely
on, what it must handle, and the questions an expert reviewer will ask so they are answered before
they are asked. Substrate is Yjs (see [relative-viewport-anchoring.md](relative-viewport-anchoring.md)
for why); storage is [storage-and-persistence.md](storage-and-persistence.md).

## What the design CAN rely on

1. **Strong Eventual Consistency.** Any two replicas that have received and applied the same set of
   updates observe the same state. No coordination, no global order required. This is the only
   convergence guarantee, and it is enough for a document.
2. **Update algebra.** Yjs updates are commutative, associative, and idempotent. Apply them in any
   order, more than once, and still converge. This is what makes replay and de-dup safe.
3. **Deterministic concurrent-insert resolution (YATA).** Every item has an id `(clientID, clock)`
   and records its left/right origin at insert time. Concurrent inserts in the same window sort
   deterministically (lower `clientID` sorts left) on every replica, and the dual-origin design
   prevents one user's run from being shredded by another's.
4. **Delta sync from a state vector.** On reconnect a peer sends `encodeStateVector`; the other side
   replies with `encodeStateAsUpdate(doc, remoteSV)`, only the missing ops. Heals arbitrary offline
   gaps without a full transfer.
5. **Causal correctness via buffering.** `applyUpdate` holds updates whose dependencies have not
   arrived (`PendingStructs`) until they integrate. Out-of-order arrival is tolerated; the model is
   causal, not arbitrary.
6. **Stable positional references.** `Y.RelativePosition` points at a character identity, not an
   index, so an anchor survives concurrent edits. This is the same primitive the viewport anchoring
   and the agent's writes both depend on.

## What the design does NOT get (and must not assume)

- **No global total order, no linearizability.** There is no "the server decided A before B" truth.
  Do not design any feature that needs a real-time happens-before or a global "latest wins."
- **No invariant preservation across concurrent ops.** SEC guarantees state convergence, not that the
  converged state satisfies an application rule. Two locally valid edits can converge to a globally
  invalid document (a uniqueness constraint, "exactly one owner," "sums to 100"). Enforce hard
  invariants in an authoritative validator outside the CRDT, or design the data model to have none.
- **Convergence is not intent preservation.** Two concurrent edits to the same sentence merge to a
  valid but possibly garbled result. No CRDT fixes semantics.

## Failure modes the design MUST handle

| # | Failure mode | Mitigation |
|---|---|---|
| 1 | **Split-brain**: two server instances accept writes for one room, and the persistence layer clobbers (read-modify-write of one blob) | Single-writer-per-room. Actor-per-room (Cloudflare Durable Object) or a distributed lock with fencing tokens. Sticky routing is necessary but not sufficient. |
| 2 | **Ack-before-durable crash**: server broadcasts/acks an update it has not persisted, then crashes; the store loses it but live clients still hold it | Write-ahead: persist to the append-only log **before** ack/broadcast. Recover by snapshot + log-tail replay. |
| 3 | **Shared-blob clobbering** | Append-only update log + async compaction. Never overwrite one serialized row from two writers. |
| 4 | **GC + offline divergence**: tombstones GC'd while a peer holds a pre-GC state vector | Defer/disable GC while lagging peers may exist. GC only below the min-state-vector watermark across all peers, the agent included. Uniform GC policy per room. See below. |
| 5 | **Reconnection storm** | Jittered backoff; per-room sync-work cap/queue. |
| 6 | **Large-diff on long-offline reconnect** | Chunk large updates; bound max offline age; force a full reload past a threshold. |
| 7 | **Agent self-feedback loop** | Filter self-originated updates by `transaction.origin` / own `clientID`; debounce; act only on quiescence. |
| 8 | **Agent stale-position write** | Capture `Y.RelativePosition` at read time; abort if it resolves to `null`; never write by a stale absolute index. |
| 9 | **Unbounded agent awareness** | Rate-limit the agent's awareness; short TTL; clear on disconnect. |
| 10 | **Malicious/invalid crafted update** (Yjs has no built-in op validation or authZ) | Authenticated connections; validate/authorize decoded updates in the authoritative process before persist/broadcast; reject bad ops. |
| 11 | **Unbounded growth**: tombstones, history, accumulated clientIDs | Versioning/snapshot resets; prune stale clientIDs; monitor doc size. |

## Single-authority-per-room (the topology decision)

A document needs exactly one process that owns its canonical `Y.Doc` at a time. CRDT math says two
in-memory copies would converge if every update reached both, but the danger is the store, not the
merge: two writers doing read-modify-write on the same serialized document clobber each other, and
that is not a CRDT merge, it is lost data. Two authorities also produce two broadcast fan-outs,
flapping state, and racing GC decisions.

The standard answer is actor-per-room. Cloudflare **Durable Objects** give it structurally: a Durable
Object for a given id exists in exactly one location at one time, is single-threaded, has attached
durable storage, and a dropped socket reconnects to the same object. `y-durableobjects` implements
this for Yjs. Hocuspocus / a plain `y-websocket` server are the self-host equivalents, but then it is
on us to guarantee one owner per room (sticky routing plus a lease with fencing tokens). Sticky
sessions alone leave a split-brain window during deploys, scale events, and partitions.

This resolves [open-questions.md](../open-questions.md) item 6: for the two-localhost test (roadmap
P3) `y-websocket` is fine because there is one server. For any real multi-user deployment the choice
is a single-authority mechanism, and Durable Objects are the lowest-effort correct one.

## Persistence durability (the ordering contract)

The rule is **never ack an update you have not durably persisted.** The default `y-websocket`
persistence is write-behind (flush on last disconnect), which loses a whole session on a mid-session
crash. Figma shipped exactly this bug and closed a 60-second data-loss window by adding a
write-ahead journal. So: persist each incoming update to the append-only log before broadcasting it;
compaction (fold updates into a snapshot, truncate the log) is one atomic transaction; replay is safe
because updates are idempotent. A durable client-side queue (y-indexeddb) makes a dropped server
write self-heal on the next state-vector sync, as long as some peer still holds the op. Details and
the store shapes are in [storage-and-persistence.md](storage-and-persistence.md).

## GC / tombstone safety

Deletes in Yjs are additive: a delete adds a tombstone; the delete-set ids are immortal because they
preserve total order for concurrent inserts. GC (on by default) discards deleted *content*, replacing
it with a length-only struct. The merge stays correct after GC. What breaks is anything needing the
deleted content:

- **Snapshots and version-restore require `gc: false`.** With GC on, restoring a version that touched
  deleted content returns corrupt/empty content. Decide per-document at creation and never flip it
  for an existing history.
- **Do not GC content a lagging peer or a retained version still needs.** An offline peer's stale
  state vector merges fine after GC, but you lose the ability to reconstruct the history it might view
  or revert. GC a region only when order-irrelevance and history-irrelevance both hold and every
  relevant peer, the agent included, has synced past it.
- **All peers of a room must share one GC policy.** Mixed gc/non-gc replicas can serialize the same
  logical document to different bytes, breaking snapshot-equality and hashing.

Scroll's stance: run rooms `gc: false` while version history or lagging peers matter (the attention-
anchored offshoot wants history), and trim memory via snapshot/version resets rather than per-
tombstone GC. This tightens [open-questions.md](../open-questions.md) item 4 beyond "CRDT vs OT": the
substrate is Yjs, and the live sub-decision is the GC watermark policy, not the algorithm.

## The agent as a peer (extra hazards)

The agent is a second writer and owes the same convergence, causal-sync, GC, and durability
discipline as a human. It is not a privileged oracle. The room's peer protocol, who owns it, and why
the interviewer is just another peer are specified in [boundaries.md](boundaries.md); the discipline
below is what that protocol enforces on every peer. The specific traps:

- **Self-observation loop.** It observes the doc to decide, then writes to the doc, then reads its own
  write as new input, and refines forever. Tag its `clientID`/origin and ignore self-originated update
  events; require a quiescent signal before acting.
- **Stale-position writes.** An LLM reasons over a text snapshot and emits edits at absolute indices
  that were valid at read time and are wrong after concurrent human edits. Convert intent to a
  `Y.RelativePosition` at read time, resolve at write time, abort on `null`. This is the same anchor
  primitive as the viewport.
- **Awareness spam.** Awareness is an ephemeral heartbeat channel. A misbehaving agent inflates
  presence traffic and leaks ghost cursors. Rate-limit it, short TTL, clear on disconnect.
- **Burst amplification.** The agent generates edits programmatically, so it is the worst-case peer
  for the large-diff, tombstone-growth, and reconnection-storm limits. Size those against it.

## Pre-answered reviewer questions

1. **What guarantees single-authority-per-room, and what happens during a deploy/failover/partition
   when two instances briefly own the room?** Durable Object (one location at a time) or a lease with
   fencing tokens; the split-brain window is bounded by the fencing mechanism, and sticky routing
   alone is not the answer.
2. **Is an acked update durable before broadcast? Walk through a crash between broadcast and fsync.**
   Write-ahead ordering: log-append precedes ack; otherwise the store silently diverges from clients.
3. **How do you GC without corrupting a client offline since before the GC, and is the agent in the
   watermark?** Min-state-vector watermark across all peers including the agent; uniform per-room
   policy; `gc: false` while history/lagging peers matter.
4. **With no server-side op validation, how do you stop a malicious/buggy client or the agent from
   writing an arbitrary, oversized, or unauthorized update?** Connection auth plus decoded-update
   validation/authorization in the authoritative process before persist/broadcast.
5. **How does the agent avoid acting on its own writes and write at a still-correct position after
   concurrent edits?** Origin filtering plus `Y.RelativePosition` with abort-on-null.
6. **What happens when a peer reconnects after a week: diff size, memory, GC boundary?** Chunked
   diffs, full-reload past a threshold, GC-boundary reset.
7. **Which application invariants must the merged document hold, and where are they enforced given
   CRDTs do not preserve invariants across concurrent ops?** In an authoritative validator, not the
   CRDT; the ide-es grader is one such validator (its oracle is authoritative, not CRDT-merged).
8. **What is the multi-year unbounded-growth story for tombstones, history, and clientIDs?**
   Versioning/snapshot resets, clientID pruning, size monitoring.

## Sources

- Shapiro et al., CRDTs (SEC): https://www.lip6.fr/Marc.Shapiro/papers/2011/CRDTs_SSS-2011.pdf
- Conflict-Aware Replicated Data Types (no invariant preservation): https://arxiv.org/pdf/1802.08733
- Yjs INTERNALS (ids, delete sets, GC struct): https://github.com/yjs/yjs/blob/main/INTERNALS.md
- Sypytkowski, YATA (concurrent-insert tiebreak, interleaving): https://www.bartoszsypytkowski.com/yata/
- Yjs sync protocol (SyncStep1/2, state-vector diff): https://deepwiki.com/yjs/y-protocols/2.1-sync-protocol
- y-websocket persistence (in-memory by default, use Hocuspocus/YHub): https://docs.yjs.dev/ecosystem/connection-provider/y-websocket
- Cloudflare Durable Objects (one location at a time): https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- y-durableobjects (actor-per-document): https://github.com/napolab/y-durableobjects
- Liveblocks, why you can't delete Yjs documents (tombstones additive, GC + offline data loss): https://liveblocks.io/docs/guides/why-you-cant-delete-yjs-documents
- Yjs, do I need to disable GC (policy uniformity): https://discuss.yjs.dev/t/do-i-need-to-disable-gc/2474
- Yjs relative positions (null on delete): https://docs.yjs.dev/api/relative-positions
- CodeCRDT, multi-agent LLM over Yjs (self-observation, stale position, non-determinism): https://arxiv.org/pdf/2510.18893
- Figma, making multiplayer more reliable (ack-before-durable window): https://www.figma.com/blog/making-multiplayer-more-reliable/
