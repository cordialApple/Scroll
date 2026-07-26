import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Pool } from 'pg'

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')

// Arbitrary fixed key so concurrent server boots (e.g. two CI test files bootstrapping against one
// fresh DB) serialize instead of racing Postgres's own non-atomic CREATE ... IF NOT EXISTS.
const SCHEMA_LOCK_KEY = 954100427

export async function bootstrapSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY])
    await client.query(schemaSql)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY])
    client.release()
  }
}

export interface LoadedDocument {
  docEpoch: number
  snapshot: Uint8Array | null
  stateVector: Uint8Array | null
  updates: Uint8Array[]
}

export interface DocumentStore {
  loadDocument(docId: string): Promise<LoadedDocument>
  // Bumps owner_epoch for the room and returns the new value — the fencing token the caller passes to
  // compact(). A new owner acquires a strictly higher epoch than any prior owner, so a paused zombie's
  // late compaction (carrying the stale epoch) fails the WHERE clause in compact() below.
  acquireLease(docId: string): Promise<number>
  // Returns the row's seq (as a string — Postgres bigint) so the caller can track exactly which
  // updates are durably applied, for compact()'s exact-set fold below.
  appendUpdate(docId: string, docEpoch: number, update: Uint8Array): Promise<string>
  // ownerEpoch is the lease from acquireLease(); the snapshot write is conditional on it, so a
  // stale-epoch caller updates 0 rows and this throws before deleting anything (durability rule 4).
  // seqs must be the EXACT set of rows the caller has independently confirmed are already reflected
  // in the snapshot bytes (not a "<= max" bound) — see persistenceExtension.ts's onChange tracking for
  // why a numeric threshold isn't safe here.
  compact(docId: string, docEpoch: number, ownerEpoch: number, snapshot: Uint8Array, stateVector: Uint8Array, seqs: string[]): Promise<void>
}

// A connection can land after the server has already started shutting down (a client's in-flight
// reconnect racing server.destroy()); pool.end() has already run at that point. Fail with an
// intentional, readable reason instead of surfacing pg's raw "pool already ended" internals.
function assertPoolOpen(pool: Pool): void {
  if (pool.ended) throw new Error('[scroll-store] rejected: server is shutting down (pool closed)')
}

// Snapshot + replay: base blob (if any) plus every update appended since the last compaction, in
// append order. Byte-compatible with Y.applyUpdate — the caller just folds them onto a fresh Y.Doc.
export function createPostgresStore(pool: Pool): DocumentStore {
  return {
    async loadDocument(docId) {
      assertPoolOpen(pool)
      const docRow = await pool.query<{ doc_epoch: string; snapshot: Buffer | null; state_vector: Buffer | null }>(
        'SELECT doc_epoch, snapshot, state_vector FROM documents WHERE doc_id = $1',
        [docId],
      )
      const updatesRes = await pool.query<{ update: Buffer }>(
        'SELECT update FROM document_updates WHERE doc_id = $1 ORDER BY seq ASC',
        [docId],
      )
      const row = docRow.rows[0]
      return {
        docEpoch: row ? Number(row.doc_epoch) : 0,
        snapshot: row?.snapshot ? new Uint8Array(row.snapshot) : null,
        stateVector: row?.state_vector ? new Uint8Array(row.state_vector) : null,
        updates: updatesRes.rows.map((r) => new Uint8Array(r.update)),
      }
    },

    // A lease grant: bump owner_epoch (create the row at epoch 1 if absent) and hand back the new
    // value. Unfenced by design — taking the lease is exactly the act of superseding the prior owner.
    async acquireLease(docId) {
      assertPoolOpen(pool)
      const res = await pool.query<{ owner_epoch: string }>(
        `INSERT INTO documents (doc_id, owner_epoch)
         VALUES ($1, 1)
         ON CONFLICT (doc_id) DO UPDATE SET owner_epoch = documents.owner_epoch + 1
         RETURNING owner_epoch::text`,
        [docId],
      )
      return Number(res.rows[0].owner_epoch)
    },

    // Called from beforeHandleMessage, strictly before Hocuspocus's MessageReceiver.apply runs (see
    // node_modules/@hocuspocus/server's Connection.handleMessage: it chains
    // `beforeHandleMessage(...).then(() => apply())`, so this INSERT is committed before the update
    // ever touches the in-memory Y.Doc or gets broadcast) — that upstream await is the entire
    // durability guarantee; nothing here needs to (or should try to) re-derive it.
    async appendUpdate(docId, docEpoch, update) {
      assertPoolOpen(pool)
      await pool.query(
        `INSERT INTO documents (doc_id, doc_epoch)
         VALUES ($1, $2)
         ON CONFLICT (doc_id) DO NOTHING`,
        [docId, docEpoch],
      )
      const res = await pool.query<{ seq: string }>(
        'INSERT INTO document_updates (doc_id, doc_epoch, update) VALUES ($1, $2, $3) RETURNING seq::text',
        [docId, docEpoch, Buffer.from(update)],
      )
      return res.rows[0].seq
    },

    // One transaction: write the merged snapshot, drop exactly the rows the caller vouches for. A
    // crash mid-transaction rolls back whole, so a partially-folded log never happens (durability
    // rule 2). Deleting by explicit seq list (not "seq <= max") is deliberate: a naive MAX(seq) read
    // can outrun a concurrent appendUpdate whose row already committed but whose apply() hasn't run
    // yet, which would delete an update the snapshot never actually captured — silent data loss with
    // no crash involved. See persistenceExtension.ts's onChange-driven seq tracking.
    async compact(docId, docEpoch, ownerEpoch, snapshot, stateVector, seqs) {
      assertPoolOpen(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // The whole read-modify-write is fenced on owner_epoch. If a new owner has bumped the epoch,
        // the DO UPDATE's WHERE excludes this row, rowCount is 0, and we throw — the DELETE below never
        // runs, so a stale owner can neither clobber the snapshot nor drop log rows the new owner has
        // not folded (distributed-systems.md's concrete two-owner trace).
        const res = await client.query(
          `INSERT INTO documents (doc_id, doc_epoch, owner_epoch, snapshot, state_vector, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (doc_id) DO UPDATE SET snapshot = $4, state_vector = $5, updated_at = now()
           WHERE documents.owner_epoch = $3`,
          [docId, docEpoch, ownerEpoch, Buffer.from(snapshot), Buffer.from(stateVector)],
        )
        if (res.rowCount === 0) {
          throw new Error(`[scroll-store] compaction fenced: stale owner_epoch ${ownerEpoch} for ${docId}`)
        }
        if (seqs.length > 0) {
          await client.query('DELETE FROM document_updates WHERE doc_id = $1 AND seq = ANY($2::bigint[])', [docId, seqs])
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
  }
}
