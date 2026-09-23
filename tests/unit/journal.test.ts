import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrainError } from '../../src/contracts/errors.js';
import type { Clock, IdSource, MutationReceipt, PlannedWrite } from '../../src/core/types.js';
import {
  Journal,
  MIGRATIONS_DIRECTORY,
  applyMigrations,
  loadMigrations,
  type FeedbackWrite,
  type RetrievalEventInput
} from '../../src/storage/journal.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';

const temporaryRoot = join('/tmp/opencode', 'brain-journal-tests');
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'case-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

class TestClock implements Clock {
  private current: Date;

  constructor(start: string) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class SequenceIds implements IdSource {
  private count = 0;

  constructor(private readonly prefix: string = 'operation') {}

  next(): string {
    this.count += 1;
    return `${this.prefix}-${this.count}`;
  }
}

const reservation = (overrides: Partial<Parameters<typeof Journal.prototype.reserve>[0]> = {}) => ({
  principal_id: 'agent-a',
  idempotency_key: 'c1',
  tool: 'brain_capture',
  scope: 'freellmapi',
  payload_hash: 'a'.repeat(64),
  payload_json: '{}',
  ...overrides
});

const samplePlan = (revisionId: string): PlannedWrite => ({
  revision: {
    id: fixtureIds.note,
    revision_id: revisionId,
    parents: [],
    scope: 'freellmapi',
    status: 'candidate',
    note: lessonFixture,
    created_at: '2026-09-20T00:00:00.000Z',
    modified_at: '2026-09-20T00:00:00.000Z',
    operation_id: 'op-fixture',
    extra_frontmatter: {},
    extra_markdown: ''
  },
  backend_project: 'freellmapi',
  directory: 'lessons/0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  storage_title: 'Compare direct and proxied TTFT r1',
  permalink: 'freellmapi/lessons/compare-direct-and-proxied-ttft',
  body: 'First token latency looked worse after streaming traffic was routed through the proxy.',
  metadata: { kind: 'lesson' }
});

const receiptFor = (operationId: string): MutationReceipt => ({
  operation_id: operationId,
  id: fixtureIds.note,
  revision_id: fixtureIds.revision,
  outcome: 'stored',
  materialized: true,
  indexed: false,
  possible_duplicates: [],
  warnings: []
});

const errorFrom = (action: () => unknown): BrainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('expected the action to throw a BrainError');
};

test('rejects different payloads under the same idempotency key', () => {
  const journal = Journal.open(':memory:');
  const input = {
    principal_id: 'agent-a',
    idempotency_key: 'c1',
    tool: 'brain_capture',
    scope: 'freellmapi',
    payload_hash: 'a'.repeat(64),
    payload_json: '{}'
  };
  journal.reserve(input);
  expect(() => journal.reserve({ ...input, payload_hash: 'b'.repeat(64) })).toThrow(
    /IDEMPOTENCY_CONFLICT/
  );
  journal.close();
});

test('rejects the same key under a different scope', () => {
  const journal = Journal.open(':memory:');
  journal.reserve(reservation());
  expect(() => journal.reserve(reservation({ scope: 'other-scope' }))).toThrow(
    /IDEMPOTENCY_CONFLICT/
  );
  journal.close();
});

test('replays an identical reservation and reuses the durable receipt', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const first = journal.reserve(reservation());
  expect(first.kind).toBe('new');
  expect(first.record.state).toBe('prepared');

  const receipt = receiptFor(first.record.operation_id);
  journal.savePlan(first.record.operation_id, samplePlan(fixtureIds.revision));
  journal.mark(first.record.operation_id, 'submitted');
  journal.mark(first.record.operation_id, 'complete', receipt);

  const replay = journal.reserve(reservation());
  expect(replay.kind).toBe('replay');
  expect(replay.record.operation_id).toBe(first.record.operation_id);
  expect(replay.record.state).toBe('complete');
  expect(replay.record.receipt_json).toBe(JSON.stringify(receipt));
  expect(journal.pending()).toHaveLength(0);
  journal.close();
});

test('persists a submitted operation and its plan across close and reopen', () => {
  const path = join(temporaryDirectory(), 'operations.sqlite');
  const clock = new TestClock('2026-09-20T00:00:00.000Z');
  const ids = new SequenceIds();
  const plan = samplePlan(fixtureIds.revision);

  const journal = Journal.open(path, { clock, ids });
  const created = journal.reserve(reservation());
  const operationId = created.record.operation_id;
  journal.savePlan(operationId, plan);
  journal.mark(operationId, 'submitted');
  journal.close();

  const reopened = Journal.open(path, { clock, ids });
  const pending = reopened.pending();
  expect(pending).toHaveLength(1);
  expect(pending[0].operation_id).toBe(operationId);
  expect(pending[0].state).toBe('submitted');
  expect(pending[0].plan_json).toBe(JSON.stringify(plan));
  expect(pending[0].payload_hash).toBe('a'.repeat(64));
  expect(reopened.get('missing-operation')).toBeUndefined();

  reopened.savePlan(operationId, plan);
  reopened.mark(operationId, 'complete', receiptFor(operationId));
  reopened.close();

  const final = Journal.open(path, { clock, ids, requireExisting: true });
  const recovered = final.get(operationId);
  expect(recovered?.state).toBe('complete');
  expect(recovered?.plan_json).toBe(JSON.stringify(plan));
  final.close();
});

test('enables write-ahead logging on file-backed storage', () => {
  const path = join(temporaryDirectory(), 'operations.sqlite');
  const journal = Journal.open(path);
  journal.close();
  const probe = new Database(path);
  expect(probe.pragma('journal_mode', { simple: true })).toBe('wal');
  probe.close();
  expect(existsSync(path)).toBe(true);
});

test('treats SQL metacharacters as literal identifiers', () => {
  const journal = Journal.open(':memory:');
  const principal = "p'; DELETE FROM operations; --";
  const key = "x'); DROP TABLE operations; --";
  const first = journal.reserve(
    reservation({
      principal_id: principal,
      idempotency_key: key,
      payload_json: "{\"quote\":\"O'Brien\"}"
    })
  );
  expect(first.record.idempotency_key).toBe(key);
  expect(first.record.principal_id).toBe(principal);
  expect(first.record.payload_json).toBe("{\"quote\":\"O'Brien\"}");

  const replay = journal.reserve(reservation({ principal_id: principal, idempotency_key: key }));
  expect(replay.kind).toBe('replay');
  expect(replay.record.operation_id).toBe(first.record.operation_id);
  expect(journal.pending()).toHaveLength(1);
  journal.close();
});

test('recovers submitted records but excludes terminal states from pending', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const prepared = journal.reserve(reservation({ idempotency_key: 'prepared' }));
  const submitted = journal.reserve(reservation({ idempotency_key: 'submitted' }));
  const materialized = journal.reserve(reservation({ idempotency_key: 'materialized' }));
  const complete = journal.reserve(reservation({ idempotency_key: 'complete' }));
  const conflict = journal.reserve(reservation({ idempotency_key: 'conflict' }));
  const failed = journal.reserve(reservation({ idempotency_key: 'failed' }));

  const plan = samplePlan(fixtureIds.revision);

  journal.savePlan(submitted.record.operation_id, plan);
  journal.mark(submitted.record.operation_id, 'submitted');
  journal.savePlan(materialized.record.operation_id, plan);
  journal.mark(materialized.record.operation_id, 'submitted');
  journal.mark(materialized.record.operation_id, 'materialized');
  journal.savePlan(complete.record.operation_id, plan);
  journal.mark(complete.record.operation_id, 'submitted');
  journal.mark(complete.record.operation_id, 'complete', receiptFor(complete.record.operation_id));
  journal.mark(conflict.record.operation_id, 'conflict');
  journal.mark(failed.record.operation_id, 'failed');

  const pendingIds = journal.pending().map((record) => record.operation_id);
  expect(pendingIds).toEqual([
    prepared.record.operation_id,
    submitted.record.operation_id,
    materialized.record.operation_id
  ]);
  journal.close();
});

test('prunes only terminal payloads older than seven days', () => {
  const clock = new TestClock('2026-09-01T00:00:00.000Z');
  const journal = Journal.open(':memory:', { clock, ids: new SequenceIds() });
  const plan = samplePlan(fixtureIds.revision);

  const oldComplete = journal.reserve(reservation({ idempotency_key: 'old-complete' }));
  journal.savePlan(oldComplete.record.operation_id, plan);
  journal.mark(oldComplete.record.operation_id, 'submitted');
  journal.mark(oldComplete.record.operation_id, 'complete', receiptFor(oldComplete.record.operation_id));

  const oldFailed = journal.reserve(reservation({ idempotency_key: 'old-failed' }));
  journal.savePlan(oldFailed.record.operation_id, plan);
  journal.mark(oldFailed.record.operation_id, 'failed');

  const oldConflict = journal.reserve(reservation({ idempotency_key: 'old-conflict' }));
  journal.savePlan(oldConflict.record.operation_id, plan);
  journal.mark(oldConflict.record.operation_id, 'conflict');

  clock.advance(8 * 24 * 60 * 60 * 1000);

  const youngComplete = journal.reserve(reservation({ idempotency_key: 'young-complete' }));
  journal.savePlan(youngComplete.record.operation_id, plan);
  journal.mark(youngComplete.record.operation_id, 'submitted');
  journal.mark(youngComplete.record.operation_id, 'complete', receiptFor(youngComplete.record.operation_id));

  const active = journal.reserve(reservation({ idempotency_key: 'active' }));
  journal.savePlan(active.record.operation_id, plan);
  journal.mark(active.record.operation_id, 'submitted');

  const pruned = journal.pruneTerminalPayloads(clock.now());
  expect(pruned).toBe(2);
  expect(journal.pruneTerminalPayloads(clock.now())).toBe(0);

  const prunedComplete = journal.get(oldComplete.record.operation_id);
  expect(prunedComplete?.payload_json).toBe('');
  expect(prunedComplete?.plan_json).toBeUndefined();
  expect(prunedComplete?.payload_hash).toBe('a'.repeat(64));
  expect(prunedComplete?.receipt_json).toBe(JSON.stringify(receiptFor(oldComplete.record.operation_id)));

  expect(journal.get(oldFailed.record.operation_id)?.payload_json).toBe('');
  expect(journal.get(oldConflict.record.operation_id)?.payload_json).not.toBe('');
  expect(journal.get(oldConflict.record.operation_id)?.plan_json).toBe(JSON.stringify(plan));
  expect(journal.get(youngComplete.record.operation_id)?.payload_json).not.toBe('');
  expect(journal.get(active.record.operation_id)?.plan_json).toBe(JSON.stringify(plan));
  journal.close();
});

test('keeps compact approval provenance after pruning recovery payloads', () => {
  const clock = new TestClock('2026-09-01T00:00:00.000Z');
  const journal = Journal.open(':memory:', { clock, ids: new SequenceIds() });
  const operation = journal.reserve(reservation({ idempotency_key: 'approved' }));
  const base = samplePlan(fixtureIds.revision);
  const approval = {
    principal_id: '00000000-0000-4000-8000-000000000002',
    rationale: 'reviewed',
    payload_hash: 'b'.repeat(64)
  };
  const plan = { ...base, revision: { ...base.revision, status: 'active' as const, approval } };
  journal.savePlan(operation.record.operation_id, plan);
  journal.mark(operation.record.operation_id, 'submitted');
  journal.mark(operation.record.operation_id, 'complete', receiptFor(operation.record.operation_id));
  clock.advance(8 * 24 * 60 * 60 * 1000);

  expect(journal.pruneTerminalPayloads(clock.now())).toBe(1);
  expect(journal.getApprovalProvenance(operation.record.operation_id)).toMatchObject({
    operation_id: operation.record.operation_id,
    principal_id: '00000000-0000-4000-8000-000000000002',
    payload_hash: 'b'.repeat(64)
  });
  expect(journal.reserve(reservation({ idempotency_key: 'approved' })).record.receipt_json).toBe(
    JSON.stringify(receiptFor(operation.record.operation_id))
  );
  journal.close();
});

test('retains explicit operational-loss acknowledgement until real history begins', () => {
  const journal = Journal.open(':memory:');
  expect(journal.hasOperationalLossAcknowledgement()).toBe(false);
  journal.acknowledgeOperationalLoss();
  expect(journal.hasOperationalLossAcknowledgement()).toBe(true);
  journal.reserve(reservation());
  expect(journal.hasOperationalLossAcknowledgement()).toBe(false);
  expect(() => journal.acknowledgeOperationalLoss()).toThrow(/history exists/);
  journal.close();
});

test('uses injected deterministic providers and random UUID defaults', () => {
  const clock = new TestClock('2026-09-20T12:34:56.000Z');
  const journal = Journal.open(':memory:', { clock, ids: new SequenceIds('op') });
  const result = journal.reserve(reservation());
  expect(result.record.operation_id).toBe('op-1');
  expect(result.record.created_at).toBe('2026-09-20T12:34:56.000Z');
  expect(result.record.updated_at).toBe('2026-09-20T12:34:56.000Z');
  journal.close();

  const system = Journal.open(':memory:');
  const generated = system.reserve(reservation());
  expect(generated.record.operation_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  system.close();
});

test('applies versioned migrations in order and reruns them idempotently', () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, '001-first.sql'), 'CREATE TABLE first (id TEXT PRIMARY KEY);', 'utf8');
  writeFileSync(join(directory, '002-second.sql'), 'CREATE TABLE second (id TEXT PRIMARY KEY);', 'utf8');
  writeFileSync(join(directory, 'notes.txt'), 'not a migration', 'utf8');

  const migrations = loadMigrations(directory);
  expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);

  const database = new Database(':memory:');
  const applied = applyMigrations(database, directory, '2026-09-20T00:00:00.000Z');
  expect(applied).toEqual([1, 2]);
  expect(applyMigrations(database, directory, '2026-09-21T00:00:00.000Z')).toEqual([]);
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
  database.close();

  const journalPath = join(temporaryDirectory(), 'operations.sqlite');
  const first = Journal.open(journalPath);
  const record = first.reserve(reservation());
  first.close();
  const second = Journal.open(journalPath);
  const probe = new Database(journalPath);
  const versionsAfterRerun = probe
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[];
  expect(versionsAfterRerun).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 6 },
    { version: 7 },
    { version: 8 },
    { version: 9 }
  ]);
  expect(second.get(record.record.operation_id)?.idempotency_key).toBe('c1');
  probe.close();
  second.close();
});

test('reserves projects idempotently with stable ids and companion metadata', () => {
  const clock = new TestClock('2026-09-21T09:00:00.000Z');
  const journal = Journal.open(':memory:', { clock });
  const input = {
    repository_identity: 'github.com/bearmanser/second-brain',
    project_id: 'second-brain',
    created_by_actor_id: 'actor-a',
    creation_operation_id: fixtureIds.idempotencyKey
  };

  const first = journal.reserveProject(input);
  expect(first.kind).toBe('new');
  expect(first.project).toMatchObject({
    project: {
      id: 'second-brain',
      display_name: 'second-brain',
      relative_root: 'Projects/second-brain',
      repository_identity: 'github.com/bearmanser/second-brain'
    },
    state: 'provisioning',
    provisioning: {
      created_by_actor_id: 'actor-a',
      creation_operation_id: fixtureIds.idempotencyKey
    },
    updated_at: '2026-09-21T09:00:00.000Z'
  });
  expect(first.project).not.toHaveProperty('permissions');
  expect(journal.reserveProject(input)).toEqual({ kind: 'replay', project: first.project });
  expect(journal.getProjectByIdentity(input.repository_identity)).toEqual(first.project);
  expect(journal.getProjectById(input.project_id)).toEqual(first.project);
  expect(journal.getProjectBinding('second-brain')).toEqual({
    backend_project: 'second-brain',
    backend_relative_root: 'Projects/second-brain'
  });
  journal.close();
});

test('persists a normalized repository identity whose path contains an at-sign', () => {
  const journal = Journal.open(':memory:');
  try {
    const reserved = journal.reserveProject({
      repository_identity: 'github.com/owner/repo@v2',
      project_id: 'repo-v2',
      created_by_actor_id: 'actor-v2',
      creation_operation_id: fixtureIds.idempotencyKey
    });
    expect(reserved.project.project.repository_identity).toBe('github.com/owner/repo@v2');
  } finally {
    journal.close();
  }
});

test('enforces unique repository identity and project bindings', () => {
  const journal = Journal.open(':memory:');
  journal.reserveProject({
    repository_identity: 'github.com/bearmanser/second-brain',
    project_id: 'second-brain',
    created_by_actor_id: 'actor-a',
    creation_operation_id: fixtureIds.idempotencyKey
  });
  expect(() =>
    journal.reserveProject({
      repository_identity: 'github.com/other/different',
      project_id: 'second-brain',
      created_by_actor_id: 'actor-a',
      creation_operation_id: fixtureIds.revision
    })
  ).toThrow(/CONFLICT/);
  expect(() =>
    journal.reserveProject({
      repository_identity: 'github.com/bearmanser/second-brain',
      project_id: 'different',
      created_by_actor_id: 'actor-a',
      creation_operation_id: fixtureIds.revision
    })
  ).toThrow(/CONFLICT/);
  journal.close();
});

test('persists ready projects and their legacy binding across reopen without a grant', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'journal.db');

  const journal = Journal.open(path);
  journal.reserveProject({
    repository_identity: 'github.com/bearmanser/second-brain',
    project_id: 'second-brain',
    created_by_actor_id: 'actor-a',
    creation_operation_id: fixtureIds.idempotencyKey
  });
  const ready = journal.markProjectReady('github.com/bearmanser/second-brain');
  expect(ready.state).toBe('ready');
  expect(journal.listReadyProjects()).toEqual([ready]);
  journal.close();

  const reopened = Journal.open(path, { requireExisting: true });
  expect(reopened.listReadyProjects()).toHaveLength(1);
  expect(reopened.listReadyProjects()[0].project).toEqual({
    id: 'second-brain',
    display_name: 'second-brain',
    relative_root: 'Projects/second-brain',
    repository_identity: 'github.com/bearmanser/second-brain'
  });
  expect(reopened.getProjectBinding('second-brain')).toEqual({
    backend_project: 'second-brain',
    backend_relative_root: 'Projects/second-brain'
  });
  reopened.close();
});

test('stores bounded project recovery diagnostics', () => {
  const journal = Journal.open(':memory:');
  journal.reserveProject({
    repository_identity: 'github.com/bearmanser/second-brain',
    project_id: 'second-brain',
    created_by_actor_id: 'actor-a',
    creation_operation_id: fixtureIds.idempotencyKey
  });

  const recovery = journal.markProjectRecoveryRequired(
    'github.com/bearmanser/second-brain',
    'backend_verify',
    'PATH_MISMATCH'
  );
  expect(recovery).toMatchObject({ state: 'recovery_required' });
  expect(recovery.provisioning).toMatchObject({
    failure_stage: 'backend_verify',
    failure_code: 'PATH_MISMATCH'
  });
  expect(journal.listReadyProjects()).toEqual([]);
  expect(() =>
    journal.markProjectRecoveryRequired(
      'github.com/bearmanser/second-brain',
      'backend_verify',
      'token=secret-value'
    )
  ).toThrow(/INVALID_INPUT/);
  journal.close();
});

test('upgrades a migration-7 database without changing prior operation rows', () => {
  const root = temporaryDirectory();
  const legacyMigrations = join(root, 'migrations');
  mkdirSync(legacyMigrations);
  for (let version = 1; version <= 7; version += 1) {
    const migration = loadMigrations(MIGRATIONS_DIRECTORY).find((item) => item.version === version);
    if (migration === undefined) throw new Error(`missing migration ${version}`);
    copyFileSync(join(MIGRATIONS_DIRECTORY, migration.name), join(legacyMigrations, migration.name));
  }
  const path = join(root, 'journal.db');
  const database = new Database(path);
  applyMigrations(database, legacyMigrations, '2026-09-20T00:00:00.000Z');
  database
    .prepare(
      `INSERT INTO operations (
        operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
        payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'legacy-operation',
      'agent-a',
      'legacy-key',
      'brain_capture',
      'freellmapi',
      'a'.repeat(64),
      '{}',
      'prepared',
      '2026-09-20T00:00:00.000Z',
      '2026-09-20T00:00:00.000Z'
    );
  database.close();

  const upgraded = Journal.open(path, { requireExisting: true });
  expect(upgraded.get('legacy-operation')).toMatchObject({ idempotency_key: 'legacy-key' });
  const probe = new Database(path);
  expect(probe.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({
    version: 9
  });
  expect(
    probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects_v2'").get()
  ).toEqual({ name: 'projects_v2' });
  expect(
    probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repository_projects'").get()
  ).toBeUndefined();
  probe.close();
  upgraded.close();
});

test('fails closed when a stored project state or provenance is malformed', () => {
  const path = join(temporaryDirectory(), 'journal.db');
  const journal = Journal.open(path);
  journal.reserveProject({
    repository_identity: 'github.com/bearmanser/second-brain',
    project_id: 'second-brain',
    created_by_actor_id: 'actor-a',
    creation_operation_id: fixtureIds.idempotencyKey
  });
  const corruptor = new Database(path);
  corruptor.pragma('ignore_check_constraints = ON');
  corruptor.prepare("UPDATE projects_v2 SET state = 'alien'").run();
  expect(() => journal.getProjectByIdentity('github.com/bearmanser/second-brain')).toThrow(
    /RECOVERY_REQUIRED/
  );
  corruptor.prepare("UPDATE projects_v2 SET state = 'provisioning'").run();
  corruptor.prepare("UPDATE project_provisioning SET created_by_actor_id = ''").run();
  expect(() => journal.getProjectById('second-brain')).toThrow(/RECOVERY_REQUIRED/);
  corruptor.close();
  journal.close();
});

test('requires explicit recovery instead of silently starting fresh', () => {
  const directory = temporaryDirectory();
  const vault = join(directory, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'lesson.md'), '# Existing knowledge', 'utf8');

  const missingPath = join(directory, 'operations.sqlite');
  let thrown: unknown;
  try {
    Journal.open(missingPath, { requireExisting: true });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BrainError);
  expect((thrown as BrainError).code).toBe('RECOVERY_REQUIRED');
  expect(existsSync(missingPath)).toBe(false);

  const emptyPath = join(directory, 'empty.sqlite');
  writeFileSync(emptyPath, '', 'utf8');
  expect(() => Journal.open(emptyPath, { requireExisting: true })).toThrow(/RECOVERY_REQUIRED/);

  const journal = Journal.open(missingPath);
  journal.reserve(reservation());
  journal.close();
  const recovered = Journal.open(missingPath, { requireExisting: true });
  expect(recovered.pending()).toHaveLength(1);
  recovered.close();
});

test('surfaces storage failures and rejects use after close', () => {
  const directory = temporaryDirectory();
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory', 'utf8');
  expect(() => Journal.open(join(blocker, 'operations.sqlite'))).toThrow(/RECOVERY_REQUIRED/);

  const journal = Journal.open(':memory:');
  const record = journal.reserve(reservation());
  journal.close();
  expect(() => journal.reserve(reservation({ idempotency_key: 'after-close' }))).toThrow(
    /INVALID_INPUT/
  );
  expect(() => journal.mark(record.record.operation_id, 'submitted')).toThrow(/INVALID_INPUT/);
  journal.close();
});

test.skipIf(!existsSync('/dev/full'))('reports a full-disk write failure instead of continuing', () => {
  expect(() => Journal.open('/dev/full')).toThrow(/RECOVERY_REQUIRED/);
});

test('rejects writes to unknown operations and unknown states', () => {
  const journal = Journal.open(':memory:');
  expect(() => journal.savePlan('missing', samplePlan(fixtureIds.revision))).toThrow(/NOT_FOUND/);
  expect(() =>
    journal.mark('missing', 'submitted')
  ).toThrow(/NOT_FOUND/);
  const record = journal.reserve(reservation());
  expect(() =>
    journal.mark(record.record.operation_id, 'unknown' as never)
  ).toThrow(/INVALID_INPUT/);
  journal.close();
});

test('rejects submission before a plan has been saved', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const created = journal.reserve(reservation());
  const failure = errorFrom(() => journal.mark(created.record.operation_id, 'submitted'));
  expect(failure.code).toBe('CONFLICT');
  expect(journal.get(created.record.operation_id)?.state).toBe('prepared');
  journal.close();
});

test('stores the first plan, no-ops an identical plan, and rejects a different plan', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const created = journal.reserve(reservation());
  const operationId = created.record.operation_id;
  const plan = samplePlan(fixtureIds.revision);

  journal.savePlan(operationId, plan);
  expect(journal.get(operationId)?.plan_json).toBe(JSON.stringify(plan));

  journal.savePlan(operationId, plan);
  expect(journal.get(operationId)?.plan_json).toBe(JSON.stringify(plan));

  const replacement = samplePlan('3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
  const failure = errorFrom(() => journal.savePlan(operationId, replacement));
  expect(failure.code).toBe('CONFLICT');
  expect(journal.get(operationId)?.plan_json).toBe(JSON.stringify(plan));
  journal.close();
});

test('rejects non-monotonic transitions and terminal regressions', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const plan = samplePlan(fixtureIds.revision);

  const skipped = journal.reserve(reservation({ idempotency_key: 'skipped' }));
  journal.savePlan(skipped.record.operation_id, plan);
  expect(errorFrom(() => journal.mark(skipped.record.operation_id, 'materialized')).code).toBe(
    'CONFLICT'
  );
  expect(errorFrom(() => journal.mark(skipped.record.operation_id, 'complete')).code).toBe(
    'CONFLICT'
  );

  const complete = journal.reserve(reservation({ idempotency_key: 'terminal' }));
  journal.savePlan(complete.record.operation_id, plan);
  journal.mark(complete.record.operation_id, 'submitted');
  journal.mark(complete.record.operation_id, 'complete', receiptFor(complete.record.operation_id));

  expect(errorFrom(() => journal.mark(complete.record.operation_id, 'submitted')).code).toBe(
    'CONFLICT'
  );
  expect(errorFrom(() => journal.mark(complete.record.operation_id, 'materialized')).code).toBe(
    'CONFLICT'
  );
  expect(journal.get(complete.record.operation_id)?.state).toBe('complete');

  const differentPlan = samplePlan('4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e');
  expect(errorFrom(() => journal.savePlan(complete.record.operation_id, differentPlan)).code).toBe(
    'CONFLICT'
  );
  expect(journal.get(complete.record.operation_id)?.plan_json).toBe(JSON.stringify(plan));

  const conflicted = journal.reserve(reservation({ idempotency_key: 'conflicted' }));
  journal.mark(conflicted.record.operation_id, 'conflict');
  expect(errorFrom(() => journal.savePlan(conflicted.record.operation_id, plan)).code).toBe(
    'CONFLICT'
  );
  journal.close();
});

test('rejects replacement of a durable terminal receipt', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const created = journal.reserve(reservation());
  const operationId = created.record.operation_id;
  journal.savePlan(operationId, samplePlan(fixtureIds.revision));
  journal.mark(operationId, 'submitted');
  const receipt = receiptFor(operationId);
  journal.mark(operationId, 'complete', receipt);

  const replacement = { ...receipt, indexed: true, warnings: ['mutated'] };
  const failure = errorFrom(() => journal.mark(operationId, 'complete', replacement));
  expect(failure.code).toBe('CONFLICT');
  expect(journal.get(operationId)?.receipt_json).toBe(JSON.stringify(receipt));
  journal.close();
});

test('refreshes only the availability flags of a durable terminal receipt', () => {
  const journal = Journal.open(':memory:', { ids: new SequenceIds() });
  const created = journal.reserve(reservation());
  const operationId = created.record.operation_id;
  const plan = samplePlan(fixtureIds.revision);
  journal.savePlan(operationId, plan);
  journal.mark(operationId, 'submitted');
  journal.mark(operationId, 'complete', receiptFor(operationId));

  const refreshed = journal.refreshReceiptAvailability(operationId, { indexed: true });
  expect(refreshed.state).toBe('complete');
  const stored = JSON.parse(refreshed.receipt_json ?? '{}') as MutationReceipt;
  expect(stored.indexed).toBe(true);
  expect(stored.materialized).toBe(true);
  expect(stored.operation_id).toBe(operationId);
  expect(stored.id).toBe(fixtureIds.note);
  expect(stored.revision_id).toBe(fixtureIds.revision);
  expect(stored.outcome).toBe('stored');
  expect(stored.possible_duplicates).toEqual([]);
  expect(stored.warnings).toEqual([]);

  const second = journal.refreshReceiptAvailability(operationId, { materialized: false });
  const secondStored = JSON.parse(second.receipt_json ?? '{}') as MutationReceipt;
  expect(secondStored.materialized).toBe(false);
  expect(secondStored.indexed).toBe(true);
  expect(second.state).toBe('complete');

  const persisted = journal.get(operationId);
  expect(persisted?.state).toBe('complete');
  expect(persisted?.plan_json).toBe(JSON.stringify(plan));
  expect(persisted?.payload_hash).toBe('a'.repeat(64));

  const notTerminal = journal.reserve(reservation({ idempotency_key: 'not-terminal' }));
  expect(
    errorFrom(() => journal.refreshReceiptAvailability(notTerminal.record.operation_id, { indexed: true }))
      .code
  ).toBe('CONFLICT');

  const conflict = journal.reserve(reservation({ idempotency_key: 'terminal-no-receipt' }));
  journal.mark(conflict.record.operation_id, 'conflict');
  expect(
    errorFrom(() => journal.refreshReceiptAvailability(conflict.record.operation_id, { indexed: true }))
      .code
  ).toBe('CONFLICT');
  journal.close();
});

const retrievalInput = (overrides: Partial<RetrievalEventInput> = {}): RetrievalEventInput => ({
  retrieval_id: '11111111-1111-4111-8111-111111111111',
  principal_id: '00000000-0000-4000-8000-000000000001',
  scope: 'freellmapi',
  scope_ids: ['freellmapi'],
  returned_ids: [],
  item_count: 0,
  token_used: 0,
  token_limit: 1500,
  mode: 'hybrid',
  outcome: 'ok',
  partial: false,
  duration_ms: 1,
  ...overrides
});

test('projects retrieval metadata onto declared fields only', () => {
  const journal = Journal.open(':memory:');
  const polluted = {
    ...retrievalInput(),
    returned_ids: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        revision_id: '33333333-3333-4333-8333-333333333333',
        title: 'private title',
        excerpt: 'private excerpt',
        reasons: ['internal']
      }
    ],
    item_count: 1
  } as unknown as RetrievalEventInput;
  expect(errorFrom(() => journal.recordRetrieval(polluted)).code).toBe('INVALID_INPUT');

  const input = retrievalInput({
    returned_ids: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        revision_id: '33333333-3333-4333-8333-333333333333'
      }
    ],
    item_count: 1
  });
  const stored = journal.recordRetrieval(input);
  input.returned_ids.push({
    id: '44444444-4444-4444-8444-444444444444',
    revision_id: '55555555-5555-4555-8555-555555555555'
  });
  input.scope_ids.push('shared');
  const reread = journal.getRetrieval(stored.retrieval_id);
  expect(reread?.returned_ids).toEqual([
    {
      id: '22222222-2222-4222-8222-222222222222',
      revision_id: '33333333-3333-4333-8333-333333333333'
    }
  ]);
  expect(reread?.scope_ids).toEqual(['freellmapi']);
  expect(reread).not.toHaveProperty('title');
  expect(reread).not.toHaveProperty('excerpt');
  journal.close();
});

test('rejects malformed retrieval metadata', () => {
  const journal = Journal.open(':memory:');
  const failure = (overrides: Partial<RetrievalEventInput>): string => {
    try {
      journal.recordRetrieval(retrievalInput(overrides));
    } catch (error) {
      if (error instanceof BrainError) return error.code;
      throw error;
    }
    throw new Error('expected the retrieval record to be rejected');
  };
  expect(failure({ retrieval_id: 'not-a-uuid' })).toBe('INVALID_INPUT');
  expect(failure({ principal_id: 'not-a-uuid' })).toBe('INVALID_INPUT');
  expect(failure({ scope: 'Bad Scope' })).toBe('INVALID_INPUT');
  expect(failure({ scope_ids: ['shared'] })).toBe('INVALID_INPUT');
  expect(failure({ scope_ids: ['freellmapi', 'shared', 'profile'] })).toBe('INVALID_INPUT');
  expect(failure({ mode: 'semantic' as never })).toBe('INVALID_INPUT');
  expect(failure({ outcome: 'maybe' as never })).toBe('INVALID_INPUT');
  expect(failure({ partial: 'yes' as never })).toBe('INVALID_INPUT');
  expect(failure({ item_count: 2 })).toBe('INVALID_INPUT');
  expect(failure({ token_used: 2000, token_limit: 1500 })).toBe('INVALID_INPUT');
  expect(failure({ created_at: 'yesterday' })).toBe('INVALID_INPUT');
  expect(
    failure({ returned_ids: [{ id: 'x', revision_id: 'y' }] as never, item_count: 1 })
  ).toBe('INVALID_INPUT');
  journal.close();
});

test('prunes retrieval metadata only past the thirty-day cutoff', () => {
  const journal = Journal.open(':memory:');
  const now = new Date('2030-01-31T00:00:00.000Z');
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  journal.recordRetrieval(
    retrievalInput({
      retrieval_id: '66666666-6666-4666-8666-666666666666',
      created_at: '2029-12-31T23:59:59.000Z'
    })
  );
  journal.recordRetrieval(
    retrievalInput({
      retrieval_id: '77777777-7777-4777-8777-777777777777',
      created_at: cutoff
    })
  );
  expect(journal.pruneRetrievalEvents(now)).toBe(1);
  expect(journal.getRetrieval('66666666-6666-4666-8666-666666666666')).toBeUndefined();
  expect(journal.getRetrieval('77777777-7777-4777-8777-777777777777')).toBeDefined();
  journal.close();
});

test('replays pre-004 feedback rows by their bounded stored payload', () => {
  const path = join(temporaryDirectory(), 'journal.sqlite');
  const journal = Journal.open(path, { ids: new SequenceIds('fb') });
  const feedbackId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const principalId = '00000000-0000-4000-8000-000000000002';
  const idempotencyKey = '99999999-9999-4999-8999-999999999999';
  const logicalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const revisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const legacyReason = 'Prevented repeating the proxy-only benchmark';

  const database = new Database(path);
  database
    .prepare(
      `INSERT INTO feedback_records (
         feedback_id, principal_id, idempotency_key, scope, logical_id, revision_id,
         retrieval_id, related_id, verdict, reason, warning, payload_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      feedbackId,
      principalId,
      idempotencyKey,
      'freellmapi',
      logicalId,
      revisionId,
      'useful',
      legacyReason,
      '2026-09-01T00:00:00.000Z'
    );
  const legacyRow = database
    .prepare('SELECT payload_hash FROM feedback_records WHERE feedback_id = ?')
    .get(feedbackId) as { payload_hash: string | null };
  expect(legacyRow.payload_hash).toBeNull();
  database
    .prepare(
      `INSERT INTO brain_idempotency_keys (idempotency_key, origin, resolution)
       VALUES (?, 'legacy', 'unresolved')`
    )
    .run(idempotencyKey);
  database
    .prepare(
      `INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id)
       VALUES (?, 'feedback', ?)`
    )
    .run(idempotencyKey, feedbackId);
  database.close();

  const legacy: FeedbackWrite = {
    principal_id: principalId,
    idempotency_key: idempotencyKey,
    scope: 'freellmapi',
    logical_id: logicalId,
    revision_id: revisionId,
    verdict: 'useful',
    reason: legacyReason
  };

  const replay = journal.replayFeedback(legacy);
  expect(replay?.kind).toBe('replay');
  expect(replay?.entry.feedback_id).toBe(feedbackId);

  const stored = journal.recordFeedback(legacy);
  expect(stored.kind).toBe('replay');
  expect(stored.entry.feedback_id).toBe(feedbackId);
  expect(journal.listFeedback('freellmapi')).toHaveLength(1);

  expect(errorFrom(() => journal.replayFeedback({ ...legacy, verdict: 'stale' })).code).toBe(
    'IDEMPOTENCY_CONFLICT'
  );
  expect(errorFrom(() => journal.recordFeedback({ ...legacy, reason: 'other reason' })).code).toBe(
    'IDEMPOTENCY_CONFLICT'
  );

  const freshKey = '88888888-8888-4888-8888-888888888888';
  const fresh = journal.recordFeedback({ ...legacy, idempotency_key: freshKey });
  expect(fresh.kind).toBe('new');
  const probe = new Database(path);
  const freshRow = probe
    .prepare('SELECT payload_hash FROM feedback_records WHERE feedback_id = ?')
    .get(fresh.entry.feedback_id) as { payload_hash: string | null };
  probe.close();
  expect(freshRow.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  journal.close();
});

test('prunes audit events only past the thirty-day cutoff', () => {
  const clock = new TestClock('2030-01-01T00:00:00.000Z');
  const journal = Journal.open(':memory:', { clock });
  journal.appendAudit({
    request_id: 'req-1',
    tool: 'brain_recall',
    outcome: 'ok',
    duration_ms: 1,
    note_count: 0
  });
  clock.advance(30 * 24 * 60 * 60 * 1000);
  expect(journal.pruneAuditEvents(clock.now())).toBe(0);
  clock.advance(1);
  expect(journal.pruneAuditEvents(clock.now())).toBe(1);
  journal.close();
});
