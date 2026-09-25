import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { PlannedWrite } from '../../src/core/types.js';
import { RevisionCatalogue } from '../../src/notes/catalogue.js';
import { renderRevision } from '../../src/notes/codec.js';
import { relativePathFor } from '../../src/notes/identity.js';
import { JournalApprovalProvenance } from '../../src/notes/reconcile.js';
import { buildManifest, verifyManifest } from '../../src/operations/backup.js';
import { assertRecoveryMode, recoverPending, requireRecoveryAuthorization } from '../../src/operations/recovery.js';
import { Journal } from '../../src/storage/journal.js';
import { recall } from '../../src/features/recall.js';
import { lessonFixture } from '../fixtures/content.js';
import { FakeBackend } from '../support/fake-backend.js';
import { reviewerContext } from '../fixtures/principals.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import {
  armFault,
  createCandidateIntent,
  createLegacyHarness,
  makeBackupFixture,
  startLegacyHttpHarness,
  type MemoryHarness
} from '../support/harness.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  };
}

async function planOf(harness: MemoryHarness): Promise<PlannedWrite> {
  const record = harness.deps.journal.pending()[0];
  expect(record?.plan_json).toBeDefined();
  return JSON.parse(record.plan_json ?? '') as PlannedWrite;
}

async function materialisePlan(harness: MemoryHarness, plan: PlannedWrite): Promise<void> {
  const scope = harness.deps.config.scopes.find((candidate) => candidate.id === plan.revision.scope);
  if (scope === undefined) throw new Error(`unknown scope ${plan.revision.scope}`);
  const relative = relativePathFor(
    scope.relative_root,
    plan.revision.note.content.kind,
    plan.revision.id,
    plan.revision.note.title,
    plan.revision.revision_id
  );
  const absolute = join(harness.deps.config.mounts.vault, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, renderRevision(plan.revision, scope), 'utf8');
}

test('recovers an interrupted write at every journal transition', async () => {
  const scenarios: {
    point: 'reserve' | 'save_plan' | 'mark';
    state?: 'submitted' | 'materialized' | 'complete';
    outcome: 'none' | 'released' | 'pending' | 'finalized';
  }[] = [
    { point: 'reserve', outcome: 'none' },
    { point: 'save_plan', outcome: 'released' },
    { point: 'mark', state: 'submitted', outcome: 'pending' },
    { point: 'mark', state: 'materialized', outcome: 'finalized' },
    { point: 'mark', state: 'complete', outcome: 'finalized' }
  ];

  for (const scenario of scenarios) {
    const h = await createLegacyHarness();
    const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
    if (scenario.point === 'mark') armFault(h, 'mark', { state: scenario.state });
    else armFault(h, scenario.point);
    await h.deps.mutations
      .commit(reviewerContext, request.intent, request.build)
      .catch(() => undefined);

    const report = await recoverPending(h.deps);
    if (scenario.outcome === 'none') {
      expect(report.inspected).toBe(0);
      expect(h.deps.journal.pending()).toHaveLength(0);
    } else {
      expect(report.operations).toHaveLength(1);
      expect(report.operations[0].outcome).toBe(scenario.outcome);
    }
    if (scenario.outcome === 'released') {
      expect(h.deps.journal.pending()).toHaveLength(0);
      expect(h.backend.create_calls).toHaveLength(0);
    }
    if (scenario.outcome === 'finalized') {
      const operation = report.operations[0];
      expect(operation.receipt?.outcome).toBe('stored');
      expect(h.deps.journal.get(operation.operation_id)?.state).toBe('complete');
      expect(h.backend.create_calls).toHaveLength(1);
      const replay = await h.deps.mutations.commit(
        reviewerContext,
        request.intent,
        request.build
      );
      expect(replay.outcome).toBe('stored');
      expect(replay.revision_id).toBe(operation.receipt?.revision_id);
      expect(h.backend.create_calls).toHaveLength(1);
    }
    await h.close();
  }
});

test('fails a conclusively absent write without replaying the backend create', async () => {
  const h = await createLegacyHarness();
  h.backend.fail_once = 'before_write';
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(first.outcome).toBe('pending');
  expect(h.backend.create_calls).toHaveLength(1);

  const report = await recoverPending(h.deps);
  expect(report.finalized).toBe(0);
  expect(report.conflicted).toBe(0);
  expect(report.failed).toBe(1);
  expect(report.operations[0].reason).toBe('materialization_absent');
  expect(report.blocking_operations).toHaveLength(0);
  expect(h.deps.journal.get(first.operation_id)?.state).toBe('failed');
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/operation failed definitively/);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('restarting Basic Memory finalizes a late Markdown materialization without resubmitting', async () => {
  const h = await createLegacyHarness();
  h.backend.fail_once = 'before_write';
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(first.outcome).toBe('pending');

  const restarted = new FakeBackend({
    root: h.deps.config.mounts.vault,
    projects: h.deps.config.scopes.map((scope) => scope.backend_project)
  });
  await restarted.connect();
  h.deps.backend = restarted;

  await materialisePlan(h, await planOf(h));
  const after = await recoverPending(h.deps);
  expect(after.finalized).toBe(1);
  expect(h.backend.create_calls).toHaveLength(1);

  await restarted.close();
  await h.close();
});

test('an unresolved write blocks new mutations while reads continue', async () => {
  const h = await createLegacyHarness();
  const readable = await h.seed(lessonFixture, { status: 'active' });
  h.backend.fail_once = 'before_write';
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await h.deps.mutations.commit(reviewerContext, request.intent, request.build);

  const originalList = h.deps.vault.list.bind(h.deps.vault);
  h.deps.vault.list = async () => {
    throw new Error('vault temporarily unavailable');
  };
  const blocked = await recoverPending(h.deps);
  expect(blocked.blocking_operations).toHaveLength(1);

  const head = await h.deps.catalogue.get('freellmapi', readable.source.id);
  expect(head.source.revision_id).toBe(readable.source.revision_id);

  const next = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await expect(
    h.deps.mutations.commit(reviewerContext, next.intent, next.build)
  ).rejects.toThrow(/RECOVERY_REQUIRED/);
  expect(h.backend.create_calls).toHaveLength(1);

  h.deps.vault.list = originalList;
  const cleared = await recoverPending(h.deps);
  expect(cleared.blocking_operations).toHaveLength(0);
  const stored = await h.deps.mutations.commit(reviewerContext, next.intent, next.build);
  expect(stored.materialized).toBe(true);
  await h.close();
});

test('rebuilding the catalogue from Markdown excludes archived and superseded heads', async () => {
  const h = await createLegacyHarness();
  const active = await h.seed(lessonFixture, { status: 'active' });
  const archived = await h.seed(lessonFixture, { status: 'archived' });
  const superseded = await h.seed(lessonFixture, { status: 'superseded' });

  const rebuilt = RevisionCatalogue.open(
    join(h.deps.config.mounts.state, 'catalogue-rebuilt.db'),
    {
      vault: h.deps.vault,
      scopes: h.deps.config.scopes,
      clock: h.deps.clock,
      approval_provenance: new JournalApprovalProvenance(h.deps.journal)
    }
  );
  try {
    for (const scope of h.deps.config.scopes) await rebuilt.reconcile(scope.id);
    h.deps.catalogue = rebuilt;
    const head = await rebuilt.get('freellmapi', active.source.id);
    expect(head.source.revision_id).toBe(active.source.revision_id);

    const result = await recall(
      reviewerContext,
      { scope: 'freellmapi', query: 'Compare direct and proxied TTFT' },
      h.deps
    );
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(active.source.id);
    expect(ids).not.toContain(archived.source.id);
    expect(ids).not.toContain(superseded.source.id);
  } finally {
    rebuilt.close();
  }
  await h.close();
});

test('marks unrecoverable operations as definitively failed', async () => {
  const h = await createLegacyHarness();
  const ghost = h.deps.journal.reserve({
    principal_id: SYSTEM_ACTOR.id,
    idempotency_key: randomUUID(),
    tool: 'brain_capture',
    scope: 'ghost',
    payload_hash: 'a'.repeat(64),
    payload_json: '{}'
  }).record;
  h.deps.journal.savePlan(ghost.operation_id, {
    revision: {
      id: randomUUID(),
      revision_id: randomUUID(),
      operation_id: ghost.operation_id,
      scope: 'ghost'
    }
  } as unknown as PlannedWrite);

  const broken = h.deps.journal.reserve({
    principal_id: SYSTEM_ACTOR.id,
    idempotency_key: randomUUID(),
    tool: 'brain_capture',
    scope: 'freellmapi',
    payload_hash: 'b'.repeat(64),
    payload_json: '{}'
  }).record;
  h.deps.journal.savePlan(broken.operation_id, {
    revision: { id: randomUUID() }
  } as unknown as PlannedWrite);

  const report = await recoverPending(h.deps);
  const byId = new Map(report.operations.map((operation) => [operation.operation_id, operation]));
  expect(byId.get(ghost.operation_id)?.outcome).toBe('failed');
  expect(byId.get(ghost.operation_id)?.reason).toBe('unknown_scope');
  expect(byId.get(broken.operation_id)?.outcome).toBe('failed');
  expect(byId.get(broken.operation_id)?.reason).toBe('unreadable_plan');
  expect(h.deps.journal.get(ghost.operation_id)?.state).toBe('failed');
  expect(h.deps.journal.get(broken.operation_id)?.state).toBe('failed');
  await h.close();
});

test('does not report failed when the terminal journal transition fails', async () => {
  const h = await createLegacyHarness();
  const ghost = h.deps.journal.reserve({
    principal_id: SYSTEM_ACTOR.id,
    idempotency_key: randomUUID(),
    tool: 'brain_capture',
    scope: 'ghost',
    payload_hash: 'c'.repeat(64),
    payload_json: '{}'
  }).record;
  h.deps.journal.savePlan(ghost.operation_id, {
    revision: {
      id: randomUUID(),
      revision_id: randomUUID(),
      operation_id: ghost.operation_id,
      scope: 'ghost'
    }
  } as unknown as PlannedWrite);
  armFault(h, 'mark', { state: 'failed' });

  const report = await recoverPending(h.deps);
  const operation = report.operations.find((entry) => entry.operation_id === ghost.operation_id);
  expect(operation?.outcome).toBe('pending');
  expect(operation?.blocking).toBe(true);
  expect(operation?.warnings).toContain('terminal_transition_failed');
  expect(report.blocking_operations).toContain(ghost.operation_id);
  expect(h.deps.journal.get(ghost.operation_id)?.state).not.toBe('failed');

  const next = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await expect(
    h.deps.mutations.commit(reviewerContext, next.intent, next.build)
  ).rejects.toThrow(/RECOVERY_REQUIRED/);
  await h.close();
});

test('keeps a blocker when both the terminal transition and its verification fail', async () => {
  const h = await createLegacyHarness();
  const ghost = h.deps.journal.reserve({
    principal_id: SYSTEM_ACTOR.id,
    idempotency_key: randomUUID(),
    tool: 'brain_capture',
    scope: 'ghost',
    payload_hash: 'd'.repeat(64),
    payload_json: '{}'
  }).record;
  h.deps.journal.savePlan(ghost.operation_id, {
    revision: {
      id: randomUUID(),
      revision_id: randomUUID(),
      operation_id: ghost.operation_id,
      scope: 'ghost'
    }
  } as unknown as PlannedWrite);
  armFault(h, 'mark', { state: 'failed' });
  const originalGet = h.deps.journal.get.bind(h.deps.journal);
  h.deps.journal.get = () => {
    throw new Error('journal is unreadable');
  };

  const report = await recoverPending(h.deps);
  const operation = report.operations.find((entry) => entry.operation_id === ghost.operation_id);
  expect(operation?.outcome).toBe('pending');
  expect(operation?.blocking).toBe(true);
  expect(report.blocking_operations).toContain(ghost.operation_id);
  expect(h.deps.mutations.hasRecoveryBlockers()).toBe(true);

  h.deps.journal.get = originalGet;
  const next = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await expect(
    h.deps.mutations.commit(reviewerContext, next.intent, next.build)
  ).rejects.toThrow(/RECOVERY_REQUIRED/);
  await h.close();
});

test('restores a valid cold backup and rejects a corrupt one', async () => {
  const fixture = await makeBackupFixture();
  await expect(verifyManifest(fixture.root, fixture.manifest)).resolves.toBeUndefined();
  await fixture.corrupt('vault/Projects/freellmapi/Notes/test.md');
  await expect(verifyManifest(fixture.root, fixture.manifest)).rejects.toThrow(/checksum/);
  await fixture.close();
});

test('detects a missing operational database instead of initializing fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brain-journal-'));
  try {
    expect(() => Journal.open(join(dir, 'journal.db'), { requireExisting: true })).toThrow(
      /RECOVERY_REQUIRED/
    );
    const journal = Journal.open(join(dir, 'journal.db'));
    journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recover-state requires explicit recovery mode and the configured token', () => {
  const digest = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');
  const configured = digest('owner-token');
  expect(() => assertRecoveryMode(undefined)).toThrow(/mode/);
  expect(() => assertRecoveryMode('serve')).toThrow(/mode/);
  expect(() => assertRecoveryMode('recover')).not.toThrow();
  expect(() => requireRecoveryAuthorization('Bearer owner-token', configured)).not.toThrow();
  expect(() => requireRecoveryAuthorization('Bearer worker-token', configured)).toThrow(/UNAUTHENTICATED/);
  expect(() => requireRecoveryAuthorization(undefined, configured)).toThrow(/UNAUTHENTICATED/);
});

function structured(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return {};
  const content = (result as { structuredContent?: unknown }).structuredContent;
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : {};
}

function captureArguments(idempotency_key: string): Record<string, unknown> {
  return {
    idempotency_key,
    scope: 'freellmapi',
    note: {
      title: 'Runtime blocking note',
      tags: [],
      content: {
        kind: 'lesson',
        situation: 'A runtime-level recovery test needs a materialized read target.',
        lesson: 'Reads stay available while an ambiguous write blocks new mutations.',
        applicability: 'Runtime recovery behaviour'
      },
      evidence: [],
      related_ids: []
    }
  };
}

test('brain_status exposes recovering health, blocked writes, and available reads', async () => {
  const h = await startLegacyHttpHarness();
  const owner = await h.connect(h.ownerToken, 'owner-recovery');
  try {
    const first = await owner.callTool({
      name: 'brain_capture',
      arguments: captureArguments(randomUUID())
    });
    const firstId = structured(first).id as string;
    expect(typeof firstId).toBe('string');

    h.backend.fail_once = 'before_write';
    const pending = await owner.callTool({
      name: 'brain_capture',
      arguments: captureArguments(randomUUID())
    });
    expect(structured(pending).outcome).toBe('pending');

    const originalList = h.runtime.deps!.vault.list.bind(h.runtime.deps!.vault);
    h.runtime.deps!.vault.list = async () => {
      throw new Error('vault unavailable');
    };
    const report = await recoverPending(h.runtime.deps!);
    expect(report.blocking_operations).toHaveLength(1);

    const status = await owner.callTool({ name: 'brain_status', arguments: {} });
    const health = structured(status).health as { gateway?: string } | undefined;
    expect(health?.gateway).toBe('recovering');
    expect(structured(status).pending_operations).toBeGreaterThanOrEqual(1);

    const operationStatus = await owner.callTool({
      name: 'brain_status',
      arguments: { operation_id: report.blocking_operations[0] }
    });
    const operation = structured(operationStatus).operation as { outcome?: string } | undefined;
    expect(operation?.outcome).toBe('pending');

    const read = await owner.callTool({
      name: 'brain_read',
      arguments: { scope: 'freellmapi', id: firstId }
    });
    expect((read as { isError?: boolean }).isError ?? false).toBe(false);
    expect(structured(read).markdown).toBeTruthy();

    const blocked = await owner.callTool({
      name: 'brain_capture',
      arguments: captureArguments(randomUUID())
    });
    expect((blocked as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(blocked)).toMatch(/RECOVERY_REQUIRED/);

    h.runtime.deps!.vault.list = originalList;
    const cleared = await recoverPending(h.runtime.deps!);
    expect(cleared.blocking_operations).toHaveLength(0);
  } finally {
    await owner.close().catch(() => undefined);
    await h.close();
  }
});

async function buildColdBackup(): Promise<{ root: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'brain-cold-'));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'note.md'), '# cold note\n');
  const tarred = run('tar', ['-cf', join(root, 'vault.tar'), '-C', source, '.']);
  expect(tarred.status).toBe(0);
  const buffer = await readFile(join(root, 'vault.tar'));
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await writeFile(join(root, 'checksums.sha256'), `${sha256}  vault.tar\n`);
  const manifest = buildManifest(
    [{ path: 'vault.tar', size: buffer.byteLength, sha256 }],
    {
      application: 'second-brain',
      schema: 1,
      images: { brain: 'second-brain:test' },
      stores: ['vault'],
      created_at: '2026-09-20T00:00:00.000Z'
    }
  );
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    root,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

test('restore.sh --check accepts a valid cold backup', async () => {
  const backup = await buildColdBackup();
  const destination = join(backup.root, 'restored');
  try {
    const result = run('bash', ['scripts/restore.sh', backup.root, destination, '--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok|valid/i);
  } finally {
    await backup.close();
  }
});

test('restore.sh --check rejects corrupt, unsafe, and incompatible backups', async () => {
  const backup = await buildColdBackup();
  try {
    const destination = join(backup.root, 'restored');
    await writeFile(join(backup.root, 'vault.tar'), 'tampered', 'utf8');
    const corrupt = run('bash', ['scripts/restore.sh', backup.root, destination, '--check']);
    expect(corrupt.status).not.toBe(0);
    expect(`${corrupt.stdout}${corrupt.stderr}`).toMatch(/checksum|mismatch/);
  } finally {
    await backup.close();
  }

  const unsafe = await mkdtemp(join(tmpdir(), 'brain-unsafe-'));
  try {
    const unsafeSource = join(unsafe, 'source');
    await mkdir(unsafeSource, { recursive: true });
    await writeFile(join(unsafe, 'evil'), 'evil');
    const created = run('tar', [
      '-P',
      '-cf',
      join(unsafe, 'vault.tar'),
      '-C',
      unsafeSource,
      '../evil'
    ]);
    expect(created.status).toBe(0);
    const buffer = await readFile(join(unsafe, 'vault.tar'));
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await writeFile(join(unsafe, 'checksums.sha256'), `${sha256}  vault.tar\n`);
    const manifest = buildManifest(
      [{ path: 'vault.tar', size: buffer.byteLength, sha256 }],
      { application: 'second-brain', schema: 1, images: {}, stores: ['vault'] }
    );
    await writeFile(join(unsafe, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const result = run('bash', ['scripts/restore.sh', unsafe, join(unsafe, 'out'), '--check']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/traversal|absolute|unsafe|member/);
  } finally {
    await rm(unsafe, { recursive: true, force: true });
  }

  const incompatible = await buildColdBackup();
  try {
    const manifest = JSON.parse(
      await readFile(join(incompatible.root, 'manifest.json'), 'utf8')
    ) as { software: { schema: number } };
    manifest.software.schema = 999;
    await writeFile(join(incompatible.root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const result = run('bash', [
      'scripts/restore.sh',
      incompatible.root,
      join(incompatible.root, 'out'),
      '--check'
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/schema/);
  } finally {
    await incompatible.close();
  }
});

test('restore.sh --check rejects symlink members and existing nonempty destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-symlink-'));
  try {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'note.md'), 'note');
    symlinkSync('note.md', join(source, 'link.md'));
    const created = run('tar', ['-cf', join(root, 'vault.tar'), '-C', source, 'link.md', 'note.md']);
    expect(created.status).toBe(0);
    const buffer = await readFile(join(root, 'vault.tar'));
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await writeFile(join(root, 'checksums.sha256'), `${sha256}  vault.tar\n`);
    const manifest = buildManifest(
      [{ path: 'vault.tar', size: buffer.byteLength, sha256 }],
      { application: 'second-brain', schema: 1, images: {}, stores: ['vault'] }
    );
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const result = run('bash', ['scripts/restore.sh', root, join(root, 'out'), '--check']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/symlink|link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const backup = await buildColdBackup();
  try {
    const destination = join(backup.root, 'nonempty');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'existing.txt'), 'existing');
    const result = run('bash', ['scripts/restore.sh', backup.root, destination, '--check']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/non-?empty|empty|exists/);
  } finally {
    await backup.close();
  }
});

test('the operational scripts carry the required restart and validation guards', async () => {
  const backup = await readFile(join(REPO_ROOT, 'scripts', 'backup.sh'), 'utf8');
  expect(backup).toMatch(/trap .*EXIT/);
  expect(backup).toMatch(/docker compose/);
  expect(backup).toMatch(/com\.docker\.compose\.volume/);
  expect(backup).toMatch(/--include-secrets/);
  expect(backup).toMatch(/--notes-only/);

  const restore = await readFile(join(REPO_ROOT, 'scripts', 'restore.sh'), 'utf8');
  expect(restore).toMatch(/--check/);
  expect(restore).toMatch(/symbolic link/);
  expect(restore).toMatch(/compose.*project|COMPOSE_PROJECT_NAME/);

  const rebuild = await readFile(join(REPO_ROOT, 'scripts', 'rebuild.sh'), 'utf8');
  expect(rebuild).toMatch(/rebuild-index/);
  expect(rebuild).toMatch(/rebuild-catalogue/);
  expect(rebuild).toMatch(/journal\.db/);
  expect(rebuild).toMatch(/operational recovery/);

  for (const script of ['backup.sh', 'restore.sh', 'rebuild.sh']) {
    const result = run('bash', ['-n', join(REPO_ROOT, 'scripts', script)]);
    expect(result.status, `${script}: ${result.stderr}`).toBe(0);
  }
});
