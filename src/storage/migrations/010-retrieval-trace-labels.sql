ALTER TABLE retrieval_events ADD COLUMN trace_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE retrieval_events ADD COLUMN fallback_reason TEXT;
ALTER TABLE retrieval_events ADD COLUMN candidate_positions_json TEXT;
ALTER TABLE retrieval_events ADD COLUMN query_id TEXT;
ALTER TABLE retrieval_events ADD COLUMN question_id TEXT;
ALTER TABLE retrieval_events ADD COLUMN question_version TEXT;
ALTER TABLE retrieval_events ADD COLUMN model_fingerprint TEXT;

CREATE TABLE retrieval_labels (
  label_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('human_reviewed', 'agent_proposed', 'synthetic')),
  query_id TEXT NOT NULL,
  question_id TEXT,
  question_version TEXT,
  model_fingerprint TEXT,
  logical_id TEXT,
  path TEXT,
  revision_id TEXT,
  source_hash TEXT NOT NULL,
  candidate_position INTEGER,
  label INTEGER NOT NULL CHECK (label IN (0, 1, 2)),
  rubric_version TEXT NOT NULL,
  evidence_ref TEXT,
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  voided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX retrieval_labels_query_idx ON retrieval_labels (query_id, source_hash);
CREATE INDEX retrieval_labels_source_idx ON retrieval_labels (logical_id, revision_id);
CREATE INDEX retrieval_labels_created_idx ON retrieval_labels (created_at, label_id);
