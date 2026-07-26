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
  // Returns the row's seq (as a string — Postgres bigint) so the caller can track exactly which
  // updates are durably applied, for compact()'s exact-set fold below.
  appendUpdate(docId: string, docEpoch: number, update: Uint8Array): Promise<string>
  // seqs must be the EXACT set of rows the caller has independently confirmed are already reflected
  // in the snapshot bytes (not a "<= max" bound) — see persistenceExtension.ts's onChange tracking for
  // why a numeric threshold isn't safe here.
  compact(docId: string, docEpoch: number, snapshot: Uint8Array, stateVector: Uint8Array, seqs: string[]): Promise<void>
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
    async compact(docId, docEpoch, snapshot, stateVector, seqs) {
      assertPoolOpen(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO documents (doc_id, doc_epoch, snapshot, state_vector, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (doc_id) DO UPDATE SET snapshot = $3, state_vector = $4, updated_at = now()`,
          [docId, docEpoch, Buffer.from(snapshot), Buffer.from(stateVector)],
        )
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
