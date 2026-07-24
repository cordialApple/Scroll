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
| 1 | **Split-brain**: two server instances accept writes for one room, and the persistence layer clobbers (read-modify-write of one blob) | Single-writer-per-room. Actor-per-room (Cloudflare Durable Object) or a distributed lock with fencing tokens — and the token is checked **by the store**: snapshot/compaction writes are conditional on `owner_epoch` (see [storage-and-persistence.md](storage-and-persistence.md)). Sticky routing is necessary but not sufficient. |
| 2 | **Ack-before-durable crash**: server broadcasts/acks an update it has not persisted, then crashes; the store loses it but live clients still hold it | Write-ahead: persist to the append-only log **before** ack/broadcast. Recover by snapshot + log-tail replay. |
| 3 | **Shared-blob clobbering** | Append-only update log + async compaction. Never overwrite one serialized row from two writers. |
| 4 | **GC + offline divergence**: tombstones GC'd while a peer holds a pre-GC state vector | Defer/disable GC while lagging peers may exist. GC only below the min-state-vector watermark across all peers, the agent included. The watermark is computable only because offline age is bounded (#6): a peer past the bound is invalidated-with-salvage, which closes the peer set. Uniform GC policy per room. See below. |
| 5 | **Reconnection storm** | Jittered backoff; per-room sync-work cap/queue. |
| 6 | **Large-diff on long-offline reconnect** | Chunk large updates; bound max offline age; past the bound, **salvage then reload**: push the peer's unsynced ops if mergeable, export the rest (fork/diff), then force a full reload. Never silently discard local edits. |
| 7 | **Agent self-feedback loop** | Filter self-originated updates by **durable self-identity** (persisted `clientID` or a recorded set of own op ids — `transaction.origin` is process-local and never crosses the wire; a restart randomizes `clientID`); debounce; act only on quiescence. Peer-obligated, not room-enforceable; the room backstops with per-peer write-rate and churn caps. |
| 8 | **Agent stale-position write** | Capture `Y.RelativePosition` at read time; abort if it resolves to `null`; never write by a stale absolute index. |
| 9 | **Unbounded agent awareness** | Rate-limit the agent's awareness; short TTL; clear on disconnect. |
| 10 | **Malicious/invalid crafted update** (Yjs has no built-in op validation or authZ) | Authenticated connections; validate/authorize decoded updates **at ingress, before the authority applies them**. Rejection is refuse-and-resync, never a silent drop — see "Rejecting an update" below. |
| 11 | **Unbounded growth**: tombstones, history, accumulated clientIDs | Epoch reset protocol (below); size monitoring to trigger it. There is no in-place clientID pruning in Yjs — the reset *is* the pruning. |

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

**Fencing only counts if the store enforces it.** A lease that lives in the server process does not
stop a paused zombie owner from writing after a new owner took over. Append-only log rows commute, so
two owners' *appends* are harmless; snapshot and compaction writes are read-modify-write and clobber
(concrete trace: old owner folds log rows 1–100 into the snapshot while the new owner folds 1–150 and
deletes them; the old owner commits last and ops 101–150 are gone from both snapshot and log). So the
owner's `owner_epoch` is a column the store checks: every snapshot write and every compaction
transaction is conditional on the current epoch, and a stale-epoch write fails loudly. On the Durable
Object branch, the attached DO storage is the store and the platform's one-instance guarantee is the
fence; if a DO fronts an external store (Postgres/S3), the epoch check must live at that store,
because the DO guarantee does not extend to it. Store shapes for both branches are in
[storage-and-persistence.md](storage-and-persistence.md).

## Persistence durability (the ordering contract)

The rule is **never ack an update you have not durably persisted.** The default `y-websocket`
persistence is write-behind (flush on last disconnect), which loses a whole session on a mid-session
crash. Figma shipped exactly this bug and closed a 60-second data-loss window by adding a
write-ahead journal. So: persist each incoming update to the append-only log before broadcasting it;
compaction (fold updates into a snapshot, truncate the log) is one atomic transaction; replay is safe
because updates are idempotent. A durable client-side queue (y-indexeddb) makes a dropped server
write self-heal on the next state-vector sync, as long as some peer still holds the op.

Two precisions, or the rule ships broken. First, the Yjs sync protocol has **no per-update acks**, so
the enforceable rule is persist-before-**broadcast-and-apply**: the authority appends the raw update
to the log before applying it to the canonical doc or fanning it out. Second, the Hocuspocus Database
extension is the *opposite* of this — a debounced write-behind whole-blob store, i.e. the Figma bug
with the citation still warm. It may hold the snapshot only; the write-ahead append is custom code in
a synchronous ingress hook (`beforeHandleMessage`-level), not the extension. Details and the store
shapes are in [storage-and-persistence.md](storage-and-persistence.md).

## Rejecting an update (ingress semantics)

Yjs peers apply their own ops locally before sending. So "reject the bad op" is not free: a rejected
op already lives in the sender's doc, every later local op causally depends on it
(`PendingStructs`), and every reconnect's state-vector sync re-offers it. Post-hoc rejection of an
already-applied op forks the peer permanently and silently. The rules:

- **Validation runs at ingress**, before the authority applies or persists anything. An accepted
  update is applied, persisted, and broadcast — all or nothing.
- **Rejection is refuse-and-resync, never silent drop.** The authority refuses the update,
  disconnects the peer with a reason, and the peer must discard local Yjs state and reload server
  truth. Salvage applies first (failure mode 6): unsynced local ops are exported (fork/diff) before
  the discard, so rejection is lossy only for the rejected content, and visibly so.
- Because rejection is that heavy, it is reserved for authZ, size, and malformed-update violations.
  Application invariants that need finer-grained enforcement (pinned blocks, the spatial guard) use
  **propose/commit** instead (below), which checks *before* the writer applies anything locally.

## Propose/commit (check-at-commit capability)

A plain peer cannot get check-at-commit: it applies locally, sends, and anything the room dislikes
lands in the heavy rejection path above. That is unusable for the attention-anchored actor, whose
spatial lease must hold at *apply* time — between the actor's revalidation and the op's arrival, a
camera can flick-scroll four blocks into the target region. So the peer protocol carries an optional,
**generic** propose/commit capability: a peer submits an update as a proposal without applying it
locally; the single-threaded authority evaluates the guard predicate (spatial bands, pinned blocks,
lease content-hash) at apply time and either commits — applies, persists, broadcasts; the proposer
receives it back like any remote update — or refuses with a reason, which costs the proposer nothing
because it never self-applied. Any peer may use it; agents **must** use it for guarded writes; humans
never need it. This is part of the one protocol, not a privileged path: the native agent and an
external agent use the same capability through the same seam
(see [boundaries.md](boundaries.md) contract 1).

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
anchored offshoot wants history), and reclaim memory via the **epoch reset protocol** below rather
than per-tombstone GC. Note the watermark is computable only because offline age is bounded (failure
mode 6); an unbounded "min state vector across all peers" never advances — one laptop in a drawer
pins it at zero forever. This tightens [open-questions.md](../open-questions.md) item 4 beyond "CRDT
vs OT": the substrate is Yjs, and the remaining tuning knobs are the offline bound and the reset
trigger, not the algorithm.

## Epoch reset protocol (the unbounded-growth answer)

A reset materializes current content into a fresh `Y.Doc` and retires the old identity space
(`clientID, clock` pairs, tombstones, delete sets). Done naively this is exactly the
"you can't delete Yjs documents" failure Liveblocks documents: old-epoch peers interleave garbage or
lose edits, and every stored `Y.RelativePosition` dies. So a reset is a first-class protocol — and it
is legal in a system whose foundation is "no coordination required" precisely because the room
already has a single authority: it is a coordination point executed by the one process allowed to
coordinate.

1. Every document carries a monotonic `doc_epoch`, stored on every persistence row and exchanged in
   the connection handshake.
2. The authority pauses ingress, drains in-flight updates, folds the log, archives the old epoch's
   snapshot + state vector (history survives, read-only), builds the new doc from current content,
   writes new snapshot + bumped epoch atomically, resumes.
3. Live peers receive an epoch-bump message: discard local Yjs state, reload. Their pending ops were
   drained in step 2, so nothing is lost.
4. A peer returning with a stale epoch fails the handshake and enters salvage: its unsynced old-epoch
   ops are applied server-side to an archived copy of the old doc, the resulting content diff is
   exported to the user (fork/paste), then the client reloads the new epoch. Never a silent discard.
5. Anchors survive by construction: `{blockId, offsetWithinBlock}` uses **app-level stable block ids**
   stored as block attributes, which the reset carries over verbatim. Yjs-internal
   `Y.RelativePosition`s are epoch-local; during step 2 the authority remaps live cameras and leases
   (resolve to absolute in the old doc, re-anchor in the new). This is a hard requirement on the P0
   block model: `blockId` must not be a Yjs internal id.
6. Version restore across a reset materializes the archived epoch read-only; re-importing it into the
   live doc is a content import, not a CRDT merge.

Sizing note: on the Durable Object branch the room authority has roughly 128 MB of memory, and the
resident `gc: false` doc — content plus every tombstone since the last reset — must fit. That cap, not
"multi-year", is what sets the reset trigger in practice: monitor serialized doc size and reset well
below it.

## The agent as a peer (extra hazards)

The agent is a second writer and owes the same convergence, causal-sync, GC, and durability
discipline as a human. It is not a privileged oracle. The room's peer protocol, who owns it, and why
the interviewer is just another peer are specified in [boundaries.md](boundaries.md). The discipline
has two enforcement grains: part is **room-enforced** (auth, ingress validation, propose/commit
guards, awareness rate/TTL, size and burst caps) and part is **peer-obligated** (self-filtering,
quiescence) — the room cannot see intent, so it backstops the obligated part with per-peer write-rate
and churn caps. The specific traps:

- **Self-observation loop.** It observes the doc to decide, then writes to the doc, then reads its own
  write as new input, and refines forever. Filter by **durable self-identity** — a persisted
  `clientID` or a recorded set of own op ids. `transaction.origin` is process-local (it never crosses
  the wire) and a restart randomizes `clientID`, so neither is a filter on its own. Require a
  quiescent signal before acting.
- **Stale-position writes.** An LLM reasons over a text snapshot and emits edits at absolute indices
  that were valid at read time and are wrong after concurrent human edits. Convert intent to a
  `Y.RelativePosition` at read time, resolve at write time, abort on `null`. Null-resolution catches a
  *dead anchor*, not *stale content*: the anchor can survive while the surrounding text changed
  meaning, and the write then overwrites fresh human intent while every check passes. A guarded write
  therefore carries a **lease = anchor + content hash** (or state-vector check) over the target span,
  evaluated at commit via propose/commit; either miss aborts. This is the same anchor primitive as
  the viewport.
- **Awareness spam.** Awareness is an ephemeral heartbeat channel. A misbehaving agent inflates
  presence traffic and leaks ghost cursors. Rate-limit it, short TTL, clear on disconnect.
- **Burst amplification.** The agent generates edits programmatically, so it is the worst-case peer
  for the large-diff, tombstone-growth, and reconnection-storm limits. Size those against it.

## Pre-answered reviewer questions

1. **What guarantees single-authority-per-room, and what happens during a deploy/failover/partition
   when two instances briefly own the room?** Durable Object (one location at a time) or a lease with
   fencing tokens — and the token is checked **by the store**: snapshot and compaction writes are
   conditional on `owner_epoch`, so a zombie owner's late write fails at the row, not at a promise.
   Append-only log rows are the only writes two owners can safely interleave; sticky routing alone is
   not the answer.
2. **Is an acked update durable before broadcast? Walk through a crash between broadcast and fsync.**
   Yjs has no per-update acks, so the enforceable rule is persist-before-broadcast-and-apply,
   implemented in a synchronous ingress hook — the debounced Hocuspocus Database extension holds
   snapshots only. Crash between append and broadcast: the op is durable and re-delivered by
   state-vector sync. Crash before append: the sender's y-indexeddb queue re-offers it on reconnect.
3. **How do you GC without corrupting a client offline since before the GC, and is the agent in the
   watermark?** Min-state-vector watermark across all peers including the agent — computable because
   offline age is bounded and a past-bound peer is invalidated with salvage, which closes the peer
   set. Uniform per-room policy; `gc: false` while history/lagging peers matter; memory is reclaimed
   by the epoch reset protocol, not tombstone GC.
4. **With no server-side op validation, how do you stop a malicious/buggy client or the agent from
   writing an arbitrary, oversized, or unauthorized update?** Connection auth plus decoded-update
   validation at ingress, before the authority applies anything. Rejection is refuse-and-resync with
   salvage — a post-hoc reject of an already-applied op would fork the peer permanently. Fine-grained
   invariants go through propose/commit instead.
5. **How does the agent avoid acting on its own writes and write at a still-correct position after
   concurrent edits?** Self-writes filtered by durable identity (persisted `clientID` / own op-id
   set — origin tags are process-local and do not survive restarts). Position correctness is a lease:
   `Y.RelativePosition` plus a content hash over the target span, checked at commit via
   propose/commit; a null anchor or a hash miss aborts. Abort-on-null alone misses stale content.
6. **What happens when a peer reconnects after a week: diff size, memory, GC boundary?** Chunked
   diffs. Past the offline bound or across an epoch: salvage first — push mergeable ops, export the
   rest — then full reload; never a silent discard. The bound is also what keeps the GC watermark
   computable (see 3).
7. **Which application invariants must the merged document hold, and where are they enforced given
   CRDTs do not preserve invariants across concurrent ops?** In the authority, at two grains: ingress
   validation (authZ / size / malformed, refuse-and-resync) and propose/commit for invariants that
   must hold at apply time (pinned-block immunity, the spatial guard). The ide-es grader is a third,
   offline validator (its oracle is authoritative, not CRDT-merged). Nothing relies on post-hoc
   rejection of an applied op.
8. **What is the multi-year unbounded-growth story for tombstones, history, and clientIDs?** The
   epoch reset protocol: archive the old epoch, rebuild, remap anchors, salvage stale peers; size
   monitoring triggers it. ClientID pruning is not a separate lever — the reset is the pruning.

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
