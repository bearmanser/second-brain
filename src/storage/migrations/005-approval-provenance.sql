CREATE TABLE operation_approvals (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE INDEX operation_approvals_revision
  ON operation_approvals(scope, logical_id, revision_id);
