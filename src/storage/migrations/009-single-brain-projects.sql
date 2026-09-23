CREATE TABLE projects_v2 (
  id TEXT PRIMARY KEY,
  repository_identity TEXT UNIQUE,
  display_name TEXT NOT NULL,
  relative_root TEXT NOT NULL UNIQUE,
  legacy_scope TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'recovery_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO projects_v2 (
  id, repository_identity, display_name, relative_root, legacy_scope,
  state, created_at, updated_at
)
SELECT scope, repository_identity, scope, relative_root, scope,
       state, created_at, updated_at
FROM repository_projects;

CREATE TABLE project_migration_audit (
  migration_version INTEGER NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (migration_version, source_table, source_key)
);

INSERT INTO project_migration_audit (migration_version, source_table, source_key, row_json)
SELECT 9, 'repository_projects', scope,
       json_object(
         'repository_identity', repository_identity,
         'scope', scope,
         'backend_project', backend_project,
         'relative_root', relative_root,
         'state', state,
         'created_by_principal_id', created_by_principal_id,
         'creation_operation_id', creation_operation_id,
         'failure_stage', failure_stage,
         'failure_code', failure_code,
         'created_at', created_at,
         'updated_at', updated_at
       )
FROM repository_projects;

INSERT INTO project_migration_audit (migration_version, source_table, source_key, row_json)
SELECT 9, 'dynamic_project_grants', principal_id || ':' || scope,
       json_object(
         'principal_id', principal_id,
         'scope', scope,
         'can_read', can_read,
         'can_write', can_write,
         'can_review', can_review,
         'created_at', created_at,
         'updated_at', updated_at
       )
FROM dynamic_project_grants;

CREATE TABLE project_provisioning (
  project_id TEXT PRIMARY KEY REFERENCES projects_v2(id) ON DELETE CASCADE,
  created_by_actor_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL,
  failure_stage TEXT,
  failure_code TEXT,
  CHECK (
    (failure_stage IS NULL AND failure_code IS NULL)
    OR (failure_stage IS NOT NULL AND failure_code IS NOT NULL)
  )
);

INSERT INTO project_provisioning (
  project_id, created_by_actor_id, creation_operation_id, failure_stage, failure_code
)
SELECT scope, created_by_principal_id, creation_operation_id, failure_stage, failure_code
FROM repository_projects;

CREATE TABLE legacy_project_backend_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects_v2(id) ON DELETE CASCADE,
  backend_project TEXT NOT NULL,
  backend_relative_root TEXT NOT NULL
);

INSERT INTO legacy_project_backend_bindings (project_id, backend_project, backend_relative_root)
SELECT scope, backend_project, relative_root
FROM repository_projects;

DROP TABLE dynamic_project_grants;
DROP TABLE repository_projects;

CREATE INDEX projects_v2_state_idx ON projects_v2 (state, created_at, id);
CREATE INDEX projects_v2_identity_idx ON projects_v2 (repository_identity);
CREATE INDEX legacy_project_backend_bindings_backend_idx
  ON legacy_project_backend_bindings (backend_project);

CREATE TABLE brain_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('legacy', 'new')),
  resolution TEXT NOT NULL CHECK (
    resolution IN ('unresolved', 'bound', 'conflict', 'recovery_required', 'released')
  ),
  tool TEXT,
  project_id TEXT,
  payload_hash TEXT,
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('operation', 'feedback')),
  target_id TEXT,
  CHECK (
    resolution <> 'bound' OR (target_kind IS NOT NULL AND target_id IS NOT NULL)
  ),
  CHECK (
    resolution <> 'released'
    OR (tool IS NOT NULL AND project_id IS NOT NULL AND payload_hash IS NOT NULL)
  )
);

CREATE INDEX brain_idempotency_keys_target_idx
  ON brain_idempotency_keys (target_kind, target_id);

CREATE TABLE legacy_idempotency_members (
  idempotency_key TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('operation', 'feedback')),
  record_id TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, record_kind, record_id),
  FOREIGN KEY (idempotency_key) REFERENCES brain_idempotency_keys(idempotency_key)
);

INSERT INTO brain_idempotency_keys (idempotency_key, origin, resolution)
SELECT idempotency_key, 'legacy', 'unresolved' FROM operations
UNION
SELECT idempotency_key, 'legacy', 'unresolved' FROM feedback_records;

INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id)
SELECT idempotency_key, 'operation', operation_id FROM operations;

INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id)
SELECT idempotency_key, 'feedback', feedback_id FROM feedback_records;

ALTER TABLE retrieval_events RENAME TO retrieval_events_v1;

CREATE TABLE retrieval_events (
  retrieval_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  scope TEXT,
  scope_ids_json TEXT NOT NULL,
  returned_ids_json TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  token_used INTEGER NOT NULL,
  token_limit INTEGER NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  partial INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  filter_json TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO retrieval_events (
  retrieval_id, principal_id, scope, scope_ids_json, returned_ids_json,
  item_count, token_used, token_limit, mode, outcome, partial, duration_ms,
  filter_json, created_at
)
SELECT retrieval_id, principal_id, scope, scope_ids_json, returned_ids_json,
       item_count, token_used, token_limit, mode, outcome, partial, duration_ms,
       json_object('mode', 'project', 'identifier', scope), created_at
FROM retrieval_events_v1;

DROP TABLE retrieval_events_v1;

CREATE INDEX retrieval_events_principal_idx ON retrieval_events (principal_id, created_at);
CREATE INDEX retrieval_events_created_idx ON retrieval_events (created_at);
