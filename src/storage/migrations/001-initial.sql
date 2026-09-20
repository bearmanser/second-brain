CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  plan_json TEXT,
  state TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(principal_id, idempotency_key)
);

CREATE INDEX operations_state_updated_idx ON operations (state, updated_at);
