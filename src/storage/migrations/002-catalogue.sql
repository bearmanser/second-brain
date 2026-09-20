CREATE TABLE catalogue_revisions (
  scope TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  revision_id TEXT,
  logical_id TEXT,
  raw_hash TEXT NOT NULL,
  title TEXT,
  kind TEXT,
  stored_status TEXT,
  effective_status TEXT,
  state TEXT NOT NULL,
  is_head INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  PRIMARY KEY (scope, relative_path)
);

CREATE INDEX catalogue_revisions_logical_idx ON catalogue_revisions (scope, logical_id);
CREATE INDEX catalogue_revisions_state_idx ON catalogue_revisions (scope, state);

CREATE TABLE catalogue_parents (
  scope TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_id TEXT NOT NULL,
  parent_raw_hash TEXT NOT NULL,
  PRIMARY KEY (scope, revision_id, parent_revision_id)
);
