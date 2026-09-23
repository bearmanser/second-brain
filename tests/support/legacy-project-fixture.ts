import Database from 'better-sqlite3';
import { MIGRATIONS_DIRECTORY, loadMigrations } from '../../src/storage/journal.js';

export const LEGACY_FIXTURE_TIMESTAMP = '2026-09-23T09:00:00.000Z';

export function openLegacyDatabase(targetVersion = 8): Database.Database {
  return openLegacyDatabaseAt(':memory:', targetVersion);
}

export function openLegacyDatabaseAt(path: string, targetVersion = 8): Database.Database {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
  const migrations = loadMigrations(MIGRATIONS_DIRECTORY).filter(
    (migration) => migration.version <= targetVersion
  );
  for (const migration of migrations) {
    if (
      database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version) !==
      undefined
    ) {
      continue;
    }
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, LEGACY_FIXTURE_TIMESTAMP);
    });
    apply.immediate();
  }
  return database;
}

export interface LegacyProjectSeed {
  repository_identity: string;
  scope: string;
  backend_project?: string;
  relative_root?: string;
  state?: 'provisioning' | 'ready' | 'recovery_required';
  created_by_principal_id?: string;
  creation_operation_id?: string;
  failure_stage?: string | null;
  failure_code?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function seedLegacyProject(database: Database.Database, seed: LegacyProjectSeed): void {
  database
    .prepare(
      `INSERT INTO repository_projects (
        repository_identity, scope, backend_project, relative_root, state,
        created_by_principal_id, creation_operation_id, failure_stage, failure_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seed.repository_identity,
      seed.scope,
      seed.backend_project ?? seed.scope,
      seed.relative_root ?? `Projects/${seed.scope}`,
      seed.state ?? 'ready',
      seed.created_by_principal_id ?? 'legacy-principal',
      seed.creation_operation_id ?? 'legacy-operation',
      seed.failure_stage ?? null,
      seed.failure_code ?? null,
      seed.created_at ?? LEGACY_FIXTURE_TIMESTAMP,
      seed.updated_at ?? LEGACY_FIXTURE_TIMESTAMP
    );
}

export interface LegacyGrantSeed {
  principal_id: string;
  scope: string;
  can_read?: 0 | 1;
  can_write?: 0 | 1;
  can_review?: 0 | 1;
  created_at?: string;
  updated_at?: string;
}

export function seedLegacyGrant(database: Database.Database, seed: LegacyGrantSeed): void {
  database
    .prepare(
      `INSERT INTO dynamic_project_grants (
        principal_id, scope, can_read, can_write, can_review, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seed.principal_id,
      seed.scope,
      seed.can_read ?? 1,
      seed.can_write ?? 0,
      seed.can_review ?? 0,
      seed.created_at ?? LEGACY_FIXTURE_TIMESTAMP,
      seed.updated_at ?? LEGACY_FIXTURE_TIMESTAMP
    );
}

export interface LegacyOperationSeed {
  operation_id: string;
  principal_id?: string;
  idempotency_key: string;
  tool?: string;
  scope?: string;
  payload_hash?: string;
  payload_json?: string;
  plan_json?: string | null;
  state?: string;
  receipt_json?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function seedLegacyOperation(database: Database.Database, seed: LegacyOperationSeed): void {
  database
    .prepare(
      `INSERT INTO operations (
        operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
        payload_json, plan_json, state, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seed.operation_id,
      seed.principal_id ?? 'legacy-principal',
      seed.idempotency_key,
      seed.tool ?? 'brain_capture',
      seed.scope ?? 'freellmapi',
      seed.payload_hash ?? 'a'.repeat(64),
      seed.payload_json ?? '{}',
      seed.plan_json ?? null,
      seed.state ?? 'complete',
      seed.receipt_json ?? null,
      seed.created_at ?? LEGACY_FIXTURE_TIMESTAMP,
      seed.updated_at ?? LEGACY_FIXTURE_TIMESTAMP
    );
}

export interface LegacyFeedbackSeed {
  feedback_id: string;
  principal_id?: string;
  idempotency_key: string;
  scope?: string;
  logical_id?: string;
  revision_id?: string;
  retrieval_id?: string | null;
  related_id?: string | null;
  verdict?: string;
  reason?: string;
  warning?: string | null;
  payload_hash?: string | null;
  created_at?: string;
}

export function seedLegacyFeedback(database: Database.Database, seed: LegacyFeedbackSeed): void {
  database
    .prepare(
      `INSERT INTO feedback_records (
        feedback_id, principal_id, idempotency_key, scope, logical_id, revision_id,
        retrieval_id, related_id, verdict, reason, warning, payload_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      seed.feedback_id,
      seed.principal_id ?? 'legacy-principal',
      seed.idempotency_key,
      seed.scope ?? 'freellmapi',
      seed.logical_id ?? '00000000-0000-4000-8000-0000000000a1',
      seed.revision_id ?? '00000000-0000-4000-8000-0000000000b1',
      seed.retrieval_id ?? null,
      seed.related_id ?? null,
      seed.verdict ?? 'useful',
      seed.reason ?? 'legacy feedback',
      seed.warning ?? null,
      seed.payload_hash ?? null,
      seed.created_at ?? LEGACY_FIXTURE_TIMESTAMP
    );
}

export interface LegacyApprovalSeed {
  operation_id: string;
  scope: string;
  logical_id: string;
  revision_id: string;
  principal_id: string;
  payload_hash: string;
}

export function seedLegacyApproval(database: Database.Database, seed: LegacyApprovalSeed): void {
  database
    .prepare(
      `INSERT INTO operation_approvals (
        operation_id, scope, logical_id, revision_id, principal_id, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(seed.operation_id, seed.scope, seed.logical_id, seed.revision_id, seed.principal_id, seed.payload_hash);
}
