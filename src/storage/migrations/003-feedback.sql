CREATE TABLE feedback_records (
  feedback_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  retrieval_id TEXT,
  related_id TEXT,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  warning TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (principal_id, idempotency_key)
);

CREATE INDEX feedback_records_subject_idx
  ON feedback_records (scope, logical_id, revision_id);
CREATE INDEX feedback_records_retrieval_idx
  ON feedback_records (retrieval_id);

CREATE TABLE retrieval_events (
  retrieval_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_ids_json TEXT NOT NULL,
  returned_ids_json TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  token_used INTEGER NOT NULL,
  token_limit INTEGER NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  partial INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX retrieval_events_principal_idx
  ON retrieval_events (principal_id, created_at);
CREATE INDEX retrieval_events_created_idx
  ON retrieval_events (created_at);

CREATE TABLE audit_events (
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  note_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_created_idx
  ON audit_events (created_at);
