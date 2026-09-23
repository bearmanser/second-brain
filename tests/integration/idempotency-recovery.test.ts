import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createRuntime } from '../../src/runtime.js';
import { FakeBackend } from '../support/fake-backend.js';
import { startHttpHarness } from '../support/harness.js';

const KEY = '00000000-0000-4000-8000-000000000131';
const CONTROL_KEY = '00000000-0000-4000-8000-000000000132';
const OPERATION_A = '00000000-0000-4000-8000-000000000041';
const OPERATION_B = '00000000-0000-4000-8000-000000000042';
const OPERATION_CONTROL = '00000000-0000-4000-8000-000000000043';
const TIMESTAMP = '2026-09-23T09:00:00.000Z';

function insertLegacyPending(database: Database.Database, id: string, key: string, project: string): void {
  const identity = `github.com/example/${project}`;
  database.prepare(
    `INSERT INTO operations (
      operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
      payload_json, plan_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, id, key, 'brain_project_ensure', project, 'a'.repeat(64),
    JSON.stringify({ repository_identity: identity }),
    JSON.stringify({
      repository_identity: identity, project_id: project, display_name: project,
      relative_root: `Projects/${project}`, backend_project: project,
      backend_relative_root: `Projects/${project}`, created_by_actor_id: 'system',
      creation_operation_id: id
    }),
    'submitted', TIMESTAMP, TIMESTAMP
  );
  database.prepare(
    "INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id) VALUES (?, 'operation', ?)"
  ).run(key, id);
}

test('startup submits a unique planned project but never writes an ambiguous planned legacy group', async () => {
  const h = await startHttpHarness();
  await h.runtime.close();
  const database = new Database(join(h.config.mounts.state, 'journal.db'));
  try {
    for (const key of [KEY, CONTROL_KEY]) {
      database.prepare(
        "INSERT INTO brain_idempotency_keys (idempotency_key, origin, resolution) VALUES (?, 'legacy', 'unresolved')"
      ).run(key);
    }
    insertLegacyPending(database, OPERATION_A, KEY, 'ambiguous-first');
    insertLegacyPending(database, OPERATION_B, KEY, 'ambiguous-second');
    insertLegacyPending(database, OPERATION_CONTROL, CONTROL_KEY, 'unique-control');
  } finally {
    database.close();
  }
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((scope) => scope.backend_project)
  });
  const ensureCalls: string[] = [];
  const ensure = backend.ensureProject.bind(backend);
  backend.ensureProject = async (project, path) => {
    ensureCalls.push(project);
    return ensure(project, path);
  };
  try {
    const reopened = await createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest });
    try {
      expect(reopened.ready).toBe(true);
      expect(reopened.deps.journal.isKeyBlocked(KEY)).toBe(true);
      expect(reopened.deps.journal.getProjectById('unique-control')?.state).toBe('ready');
      expect(ensureCalls).toEqual(['unique-control']);
      expect(reopened.deps.journal.getProjectById('ambiguous-first')).toBeUndefined();
      expect(reopened.deps.journal.getProjectById('ambiguous-second')).toBeUndefined();
      expect(backend.create_calls).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  } finally {
    await backend.close().catch(() => undefined);
    await h.close();
  }
});
