# Storage and persistence

How Scroll stores a document, from single-user to multi-user, and the durability rules that keep the
store consistent with live clients. Correctness of the sync layer is in
[distributed-systems.md](distributed-systems.md); this doc is the store shapes.

## Two ways to persist a Y.Doc

A `Y.Doc` is in-memory. Serializing it has exactly two shapes, and they are byte-compatible:

- **Snapshot / blob.** `Y.encodeStateAsUpdate(doc)` serializes the whole document to one
  `Uint8Array`. Load is one `Y.applyUpdate`. Simple, but every save rewrites the whole doc.
- **Append-only update log.** Subscribe to `doc.on('update', ...)`, append each small binary update as
  a row. Load replays them all. Writes are tiny; reads cost O(number of updates).

They mix because `Y.mergeUpdates([...])` losslessly squashes many updates into one, and
`Y.diffUpdate` / `encodeStateAsUpdate(doc, stateVector)` compute the delta a peer is missing straight
from stored bytes without instantiating a `Y.Doc`. This is what makes a hybrid log-plus-snapshot store
cheap: compaction never needs the doc in memory.

## How the canonical Yjs stores do it

- **y-indexeddb (client).** Hybrid. Writes each update as an auto-increment row; once un-merged
  updates cross `PREFERRED_TRIM_SIZE` (500) it writes one merged blob and deletes the prior rows.
  Steady state is one snapshot plus fewer than 500 recent deltas. Fires `'synced'` after initial load.
- **Hocuspocus Database extension (server).** Opaque blob. You provide `fetch({documentName})` and
  `store({documentName, state})` where `state = Y.encodeStateAsUpdate(doc)`; it stores the whole doc,
  debounced. Documented gotcha: `fetch` must return the exact bytes you stored, or the history forks
  and content duplicates.
- **y-leveldb (server, single-node).** Update log in LevelDB, merged on flush.

## How real doc apps store documents (for reference)

- **Notion**: relational row-per-block in sharded Postgres. Rich to query, partial updates cheap, but
  the merge logic is app-level.
- **Google Docs**: operation log appended durably before the ack, plus periodic full-document
  snapshots. Load is latest snapshot plus replayed ops.
- **Linear**: server-authoritative sync engine, monotonic `syncId` for total order, IndexedDB client
  queue. Not a CRDT: the server assigns order.
- **Figma**: last-writer-wins document, S3 checkpoints every ~30-60s plus a DynamoDB journal every
  ~0.5s (the write-ahead log that closed their 60-second data-loss window).

The three philosophies: relational-row-per-block (queryable, app-level merge), opaque-CRDT-blob
(cheapest to build, merge is free and offline-safe, but the doc is a black box to the DB), and
operation-log-plus-snapshots (log is the history). Scroll takes the opaque-CRDT-blob path because the
same `Uint8Array` format lives in IndexedDB, in Postgres, and on the wire, so single-user and
multi-user use one storage format and multi-user is additive rather than a rewrite.

## Recommended design for Scroll

**P0, single-user (roadmap P0).**
- `Y.Doc` with `gc: false` (the attention-anchored offshoot wants version history; see the GC rule
  below).
- Local store: `y-indexeddb`. Offline, instant load, auto-compaction at 500. Gate first render on
  `'synced'`.
- If a native/desktop build wants local SQL: SQLite with a `doc_updates(doc_id, seq, update BLOB)`
  table plus a `doc_snapshot(doc_id, snapshot BLOB, state_vector BLOB)` row; compact with
  `Y.mergeUpdates`.

**P3, add multi-user (drop-in, no client rewrite).**
- Server: Hocuspocus (or `y-websocket` for the two-localhost test) with a Database extension, behind a
  single-authority-per-room owner (see [distributed-systems.md](distributed-systems.md)).
- Postgres, two tables:
  - `documents(doc_id PK, snapshot BYTEA, state_vector BYTEA, updated_at)`: the compacted base blob,
    written on debounce and on last-disconnect, atomically.
  - `document_updates(doc_id, seq BIGSERIAL, update BYTEA, created_at)`: append-only hot log for
    durability between snapshots. Fold into `documents.snapshot` on a threshold inside one
    transaction, then delete the folded rows.
  - Optional `document_versions(doc_id, label, snapshot BYTEA, state_vector BYTEA, created_at)` for
    named history (needs `gc: false`).
- Client keeps `y-indexeddb` and adds the network provider. Still offline-capable; reconciles via
  state-vector diff on reconnect.
- Large docs: move `documents.snapshot` to S3, keep the pointer plus `state_vector` in Postgres.

## Durability rules (wire these in)

1. **Persist before ack.** Write each incoming update to `document_updates` before broadcasting it. In
   memory is not durable. This is the Figma journal lesson.
2. **Compaction is one atomic transaction.** Write the merged snapshot and delete the folded rows
   together, or a crash mid-compaction drops updates that were "already merged."
3. **A durable client queue heals dropped server writes.** y-indexeddb plus state-vector reconnect
   re-delivers any op the server lost, as long as a peer still holds it.

## GC / compaction safety (stated precisely)

1. Delete-set ids are immortal; GC may reclaim deleted content, never the id ranges that preserve
   order.
2. Snapshots / version-restore require `gc: false` on the origin doc. With GC on, a version touching
   deleted content cannot be materialized.
3. Do not GC content a retained version or an un-synced peer (the agent included) still references.
4. Compaction folds with `Y.mergeUpdates` / `encodeStateAsUpdate` and is atomic and lossless (a merged
   update is always byte-compatible and no larger than the inputs).
5. Never ack before persistence; pair with a durable client queue.

Scroll runs rooms `gc: false` and trims memory with snapshot/version resets, not per-tombstone GC.
This is the same call recorded in [open-questions.md](../open-questions.md) item 4.

## Sources

- Yjs document updates (encode/apply/merge/diff, state vectors): https://docs.yjs.dev/api/document-updates
- y-indexeddb source (PREFERRED_TRIM_SIZE=500): https://github.com/yjs/y-indexeddb/blob/master/src/y-indexeddb.js
- Hocuspocus Database extension: https://tiptap.dev/docs/hocuspocus/server/extensions/database
- Yjs INTERNALS (delete sets, GC struct): https://github.com/yjs/yjs/blob/main/INTERNALS.md
- Yjs snapshots require gc:false: https://deepwiki.com/yjs/yjs/6.3-snapshots
- Notion data model (block-as-row): https://www.notion.com/blog/data-model-behind-notion
- Notion sharding Postgres: https://www.notion.com/blog/sharding-postgres-at-notion
- Figma, making multiplayer more reliable (S3 checkpoints + DynamoDB journal): https://www.figma.com/blog/making-multiplayer-more-reliable/
- Evan Wallace, how Figma's multiplayer works: https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/
- Reverse-engineering Linear's sync engine: https://github.com/wzhudev/reverse-linear-sync-engine
