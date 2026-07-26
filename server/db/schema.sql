-- P3.4 durable store. Snapshot + append-only log, byte-compatible with the Y.Doc wire format.
-- owner_epoch/doc_epoch columns exist now but are unfenced until P3.5 wires the lease check.
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,
  doc_epoch BIGINT NOT NULL DEFAULT 0,
  owner_epoch BIGINT NOT NULL DEFAULT 0,
  snapshot BYTEA,
  state_vector BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_updates (
  seq BIGSERIAL PRIMARY KEY,
  doc_id TEXT NOT NULL,
  doc_epoch BIGINT NOT NULL,
  update BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_updates_doc_id_seq_idx ON document_updates (doc_id, seq);
