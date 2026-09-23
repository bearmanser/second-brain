import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  Journal,
  MIGRATIONS_DIRECTORY,
  applyMigrations,
  loadMigrations
} from '../../src/storage/journal.js';
import {
  openLegacyDatabase,
  seedLegacyApproval,
  seedLegacyFeedback,
  seedLegacyGrant,
  seedLegacyOperation,
  seedLegacyProject
} from '../support/legacy-project-fixture.js';

const APPLIED_AT = '2026-09-23T10:00:00.000Z';

test('migration 009 copies projects into projects_v2 with stable IDs and companion metadata', () => {
  const database = openLegacyDatabase(8);
  try {
    seedLegacyProject(database, {
      repository_identity: 'github.com/example/freellmapi',
      scope: 'freellmapi',
      state: 'ready',
      created_by_principal_id: 'creator-a',
      creation_operation_id: 'operation-a',
      created_at: '2026-09-20T08:00:00.000Z',
      updated_at: '2026-09-20T09:00:00.000Z'
    });
    seedLegacyProject(database, {
      repository_identity: 'github.com/example/recovering',
      scope: 'recovering',
      state: 'recovery_required',
      failure_stage: 'backend_verification',
      failure_code: 'CONFLICT'
    });
    seedLegacyProject(database, {
      repository_identity: 'github.com/example/pending',
      scope: 'pending',
      state: 'provisioning'
    });
    seedLegacyGrant(database, {
      principal_id: 'legacy-principal',
      scope: 'freellmapi',
      can_write: 1,
      can_review: 1
    });
    seedLegacyOperation(database, {
      operation_id: '00000000-0000-4000-8000-0000000000f1',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      scope: 'freellmapi'
    });
    seedLegacyApproval(database, {
      operation_id: '00000000-0000-4000-8000-0000000000f1',
      scope: 'freellmapi',
      logical_id: '00000000-0000-4000-8000-0000000000a1',
      revision_id: '00000000-0000-4000-8000-0000000000b1',
      principal_id: 'legacy-principal',
      payload_hash: 'c'.repeat(64)
    });

    const applied = applyMigrations(database, MIGRATIONS_DIRECTORY, APPLIED_AT);
    expect(applied).toContain(9);

    const projects = database.prepare('SELECT * FROM projects_v2 ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(projects.map((row) => row.id)).toEqual(['freellmapi', 'pending', 'recovering']);
    expect(projects.find((row) => row.id === 'freellmapi')).toMatchObject({
      repository_identity: 'github.com/example/freellmapi',
      display_name: 'freellmapi',
      relative_root: 'Projects/freellmapi',
      legacy_scope: 'freellmapi',
      state: 'ready',
      created_at: '2026-09-20T08:00:00.000Z',
      updated_at: '2026-09-20T09:00:00.000Z'
    });
    expect(projects.find((row) => row.id === 'recovering')?.state).toBe('recovery_required');

    const provisioning = database
      .prepare('SELECT * FROM project_provisioning WHERE project_id = ?')
      .get('freellmapi') as Record<string, unknown> | undefined;
    expect(provisioning).toMatchObject({
      created_by_actor_id: 'creator-a',
      creation_operation_id: 'operation-a'
    });
    const recovering = database
      .prepare('SELECT * FROM project_provisioning WHERE project_id = ?')
      .get('recovering') as Record<string, unknown> | undefined;
    expect(recovering).toMatchObject({
      failure_stage: 'backend_verification',
      failure_code: 'CONFLICT'
    });

    const bindings = database
      .prepare('SELECT * FROM legacy_project_backend_bindings ORDER BY project_id')
      .all() as Record<string, unknown>[];
    expect(bindings.find((row) => row.project_id === 'freellmapi')).toMatchObject({
      backend_project: 'freellmapi',
      backend_relative_root: 'Projects/freellmapi'
    });

    const audit = database
      .prepare('SELECT * FROM project_migration_audit ORDER BY source_table, source_key')
      .all() as Record<string, unknown>[];
    expect(audit.some((row) => row.source_table === 'repository_projects' && row.source_key === 'freellmapi')).toBe(
      true
    );
    expect(audit.some((row) => row.source_table === 'dynamic_project_grants')).toBe(true);

    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repository_projects'").get()
    ).toBeUndefined();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_project_grants'").get()
    ).toBeUndefined();
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database.close();
  }
});

test('migration 009 is idempotent across reopen and preserves foreign keys', () => {
  const database = openLegacyDatabase(8);
  try {
    seedLegacyProject(database, {
      repository_identity: 'github.com/example/second-brain',
      scope: 'second-brain',
      state: 'ready'
    });
    applyMigrations(database, MIGRATIONS_DIRECTORY, APPLIED_AT);
    const second = applyMigrations(database, MIGRATIONS_DIRECTORY, '2026-09-23T11:00:00.000Z');
    expect(second).not.toContain(9);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM projects_v2').get() as { count: number }).count
    ).toBe(1);
  } finally {
    database.close();
  }
});

test('a new project may use an independent root and legacy backend mapping', () => {
  const journal = Journal.open(':memory:');
  try {
    const reserved = journal.reserveProject({
      repository_identity: 'github.com/example/readable',
      project_id: 'readable',
      display_name: 'Readable project',
      relative_root: 'Knowledge/Readable',
      created_by_actor_id: 'actor-a',
      creation_operation_id: '00000000-0000-4000-8000-0000000000d2'
    });
    expect(reserved.project.project).toMatchObject({
      id: 'readable',
      display_name: 'Readable project',
      relative_root: 'Knowledge/Readable',
      repository_identity: 'github.com/example/readable'
    });
    expect(journal.getProjectBinding('readable')).toEqual({
      backend_project: 'readable',
      backend_relative_root: 'Knowledge/Readable'
    });
  } finally {
    journal.close();
  }
});

test('a failed migration rolls the project tables and schema version back together', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'migration-rollback-'));
  try {
    const migrations = join(root, 'migrations');
    mkdirSync(migrations);
    for (const migration of loadMigrations(MIGRATIONS_DIRECTORY)) {
      if (migration.version <= 8) {
        copyFileSync(join(MIGRATIONS_DIRECTORY, migration.name), join(migrations, migration.name));
      }
    }
    const real = readFileSync(join(MIGRATIONS_DIRECTORY, '009-single-brain-projects.sql'), 'utf8');
    writeFileSync(
      join(migrations, '009-single-brain-projects.sql'),
      `${real}\nINSERT INTO project_provisioning (project_id, created_by_actor_id, creation_operation_id) VALUES ('missing-project', 'actor', 'operation');\n`,
      'utf8'
    );

    const database = openLegacyDatabase(8);
    try {
      seedLegacyProject(database, {
        repository_identity: 'github.com/example/survivor',
        scope: 'survivor',
        state: 'ready'
      });
      seedLegacyGrant(database, { principal_id: 'legacy', scope: 'survivor', can_write: 1 });
      expect(() => applyMigrations(database, migrations, APPLIED_AT)).toThrow();

      expect(
        (database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
          version: number;
        }).version
      ).toBe(8);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repository_projects'").get()
      ).toEqual({ name: 'repository_projects' });
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dynamic_project_grants'").get()
      ).toEqual({ name: 'dynamic_project_grants' });
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects_v2'").get()
      ).toBeUndefined();
      expect(
        (database.prepare('SELECT COUNT(*) AS count FROM repository_projects').get() as { count: number })
          .count
      ).toBe(1);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening a migrated journal keeps the stable project identity', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'migration-reopen-'));
  try {
    const legacyMigrations = join(root, 'migrations');
    mkdirSync(legacyMigrations);
    for (const migration of loadMigrations(MIGRATIONS_DIRECTORY)) {
      if (migration.version <= 8) {
        copyFileSync(join(MIGRATIONS_DIRECTORY, migration.name), join(legacyMigrations, migration.name));
      }
    }
    const path = join(root, 'journal.db');
    const database = new Database(path);
    applyMigrations(database, legacyMigrations, APPLIED_AT);
    seedLegacyProject(database, {
      repository_identity: 'github.com/example/reopen',
      scope: 'reopen',
      state: 'ready'
    });
    database.close();

    const first = Journal.open(path, { requireExisting: true });
    expect(first.getProjectByIdentity('github.com/example/reopen')?.project).toEqual({
      id: 'reopen',
      display_name: 'reopen',
      relative_root: 'Projects/reopen',
      repository_identity: 'github.com/example/reopen'
    });
    expect(first.getProjectBinding('reopen')).toEqual({
      backend_project: 'reopen',
      backend_relative_root: 'Projects/reopen'
    });
    first.close();

    const second = Journal.open(path, { requireExisting: true });
    expect(second.getProjectById('reopen')?.project.relative_root).toBe('Projects/reopen');
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration 009 imports one legacy key per distinct key with membership for every record', () => {
  const database = openLegacyDatabase(8);
  try {
    const operationA = '00000000-0000-4000-8000-0000000000e1';
    const operationB = '00000000-0000-4000-8000-0000000000e2';
    const feedbackA = '00000000-0000-4000-8000-0000000000e3';
    const keyA = '00000000-0000-4000-8000-0000000000f1';
    const keyB = '00000000-0000-4000-8000-0000000000f2';
    seedLegacyOperation(database, { operation_id: operationA, idempotency_key: keyA });
    seedLegacyOperation(database, { operation_id: operationB, idempotency_key: keyB });
    seedLegacyFeedback(database, {
      feedback_id: feedbackA,
      idempotency_key: keyA,
      logical_id: '00000000-0000-4000-8000-0000000000a1',
      revision_id: '00000000-0000-4000-8000-0000000000b1'
    });

    applyMigrations(database, MIGRATIONS_DIRECTORY, APPLIED_AT);

    const keys = database
      .prepare('SELECT idempotency_key, origin, resolution FROM brain_idempotency_keys ORDER BY idempotency_key')
      .all() as { idempotency_key: string; origin: string; resolution: string }[];
    expect(keys.map((key) => key.idempotency_key)).toEqual([keyA, keyB]);
    expect(keys.every((key) => key.origin === 'legacy' && key.resolution === 'unresolved')).toBe(true);

    const members = database
      .prepare(
        'SELECT record_kind, record_id FROM legacy_idempotency_members WHERE idempotency_key = ? ORDER BY record_kind'
      )
      .all(keyA) as { record_kind: string; record_id: string }[];
    expect(members).toEqual([
      { record_kind: 'feedback', record_id: feedbackA },
      { record_kind: 'operation', record_id: operationA }
    ]);
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database.close();
  }
});

test('migration application does not touch vault bytes or directories', () => {
  const vaultRoot = mkdtempSync(join('/tmp/opencode', 'migration-vault-'));
  try {
    mkdirSync(join(vaultRoot, 'Projects', 'freellmapi'), { recursive: true });
    const notePath = join(vaultRoot, 'Projects', 'freellmapi', 'note.md');
    writeFileSync(notePath, '# Keep these bytes\n', 'utf8');
    const before = readFileSync(notePath);

    const database = openLegacyDatabase(8);
    try {
      seedLegacyProject(database, {
        repository_identity: 'github.com/example/freellmapi',
        scope: 'freellmapi',
        state: 'ready'
      });
      applyMigrations(database, MIGRATIONS_DIRECTORY, APPLIED_AT);
    } finally {
      database.close();
    }

    expect(readFileSync(notePath)).toEqual(before);
    expect(readdirSync(vaultRoot)).toEqual(['Projects']);
    expect(readdirSync(join(vaultRoot, 'Projects'))).toEqual(['freellmapi']);
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
});
