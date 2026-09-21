CREATE TABLE repository_projects (
  repository_identity TEXT PRIMARY KEY,
  scope TEXT NOT NULL UNIQUE,
  backend_project TEXT NOT NULL,
  relative_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'recovery_required')),
  created_by_principal_id TEXT NOT NULL,
  creation_operation_id TEXT NOT NULL,
  failure_stage TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (backend_project = scope),
  CHECK (relative_root = 'Projects/' || scope),
  CHECK (
    (failure_stage IS NULL AND failure_code IS NULL)
    OR (failure_stage IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX repository_projects_state_idx
  ON repository_projects (state, created_at, repository_identity);

CREATE TABLE dynamic_project_grants (
  principal_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK (can_read = 1),
  can_write INTEGER NOT NULL CHECK (can_write IN (0, 1)),
  can_review INTEGER NOT NULL CHECK (can_review IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, scope),
  FOREIGN KEY (scope) REFERENCES repository_projects(scope) ON DELETE RESTRICT
);

CREATE INDEX dynamic_project_grants_scope_idx
  ON dynamic_project_grants (scope, principal_id);
