import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { LocalMutationCoordinator } from '../../src/core/mutation.js';
import type {
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt,
  LocalPlannedOperation
} from '../../src/core/types.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { collectRenameSnapshots, planRename } from '../../src/notes/rename.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };

function managed(id: string, marker: string): string {
  return ['---', `id: ${id}`, 'brain_schema_version: 2', 'type: note', 'status: candidate', '---', '', `# ${marker}`, '', marker, ''].join('\n');
}

interface Ground {
  sandbox: Awaited<ReturnType<typeof vaultSandbox>>;
  vaultRoot: string;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  operations: LocalOperationJournal;
  revisions: RevisionStore;
  coordinator: LocalMutationCoordinator;
  refresh: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function openGround(): Promise<Ground> {
  const sandbox = await vaultSandbox();
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const revisions = await openRevisionStore(sandbox.state);
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const refresh = async (): Promise<void> => {
    await reconcileCurrentVault({ vault, catalogue });
  };
  await refresh();
  const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const ground: Ground = {
    sandbox,
    vaultRoot: sandbox.vault,
    store,
    catalogue,
    revisions,
    operations,
    coordinator: undefined as unknown as LocalMutationCoordinator,
    refresh,
    dispose: async () => {
      try {
        operations.close();
      } catch {
        undefined;
      }
      await store.close();
      catalogue.close();
      await sandbox.dispose();
    }
  };
  ground.coordinator = new LocalMutationCoordinator({
    operations,
    documents: store,
    catalogue,
    vaultRoot: sandbox.vault,
    clock,
    ids,
    revisions
  });
  return ground;
}

function writePlan(
  entries: readonly { path: string; noteId: string; revisionId: string }[]
): LocalPlannedOperation {
  const plan = {
    kind: 'note',
    heads: [],
    parents: [],
    read_set: entries.map((entry) => ({
      kind: 'path' as const,
      path: entry.path,
      expected: { kind: 'absent' as const }
    })),
    effects: entries.map((entry) => ({
      kind: 'write' as const,
      write: {
        path: entry.path,
        raw: managed(entry.noteId, entry.path),
        id: entry.noteId,
        revision_id: entry.revisionId,
        parents: []
      }
    }))
  };
  return plan as unknown as LocalPlannedOperation;
}

async function reserveOperation(
  ground: Ground,
  key: string,
  plan: LocalPlannedOperation,
  progress?: unknown,
  request?: { hash: string; json: string }
): Promise<string> {
  const now = clock.now().toISOString();
  const record = ground.operations.reserve({
    operation_id: randomUUID(),
    idempotency_key: key,
    tool: 'brain_capture',
    action: 'capture',
    project_id: null,
    payload_hash: request?.hash ?? 'a'.repeat(64),
    payload_json: request?.json ?? '{}',
    created_at: now,
    updated_at: now
  }).record;
  ground.operations.update(record.operation_id, {
    plan_json: JSON.stringify(plan),
    storage_key: JSON.stringify(
      plan.kind === 'note'
        ? plan.effects.map((_effect, index) => `${key}:doc:${index}`)
        : []
    ),
    ...(progress === undefined ? {} : { progress_json: JSON.stringify(progress) }),
    updated_at: now
  });
  return record.operation_id;
}

test('no effects started: a foreign read-set change is a terminal conflict', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const noteId = randomUUID();
    const operationId = await reserveOperation(
      ground,
      key,
      writePlan([{ path: 'Inbox/One.md', noteId, revisionId: randomUUID() }])
    );
    await mkdir(join(ground.vaultRoot, 'Inbox'), { recursive: true });
    await writeFile(join(ground.vaultRoot, 'Inbox/One.md'), managed(noteId, 'foreign'));
    const report = await ground.coordinator.recover();
    expect(report.conflicted).toBe(1);
    const status = ground.coordinator.status(operationId);
    expect(status?.state).toBe('conflicted');
    expect(status?.receipt).toBeUndefined();
    expect((await ground.store.readPath('Inbox/One.md')).raw).toContain('foreign');
  } finally {
    await ground.dispose();
  }
});

test('a partially applied operation completes without overwriting its own applied effect', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const plan = writePlan([
      { path: 'Inbox/One.md', noteId: firstId, revisionId: randomUUID() },
      { path: 'Inbox/Two.md', noteId: secondId, revisionId: randomUUID() }
    ]);
    const first = await ground.store.put({
      path: 'Inbox/One.md',
      raw: managed(firstId, 'own output'),
      expectedEtag: null,
      idempotencyKey: `${key}:doc:0`,
      source: 'brain_capture'
    });
    const operationId = await reserveOperation(ground, key, plan, {
      preconditions_validated: true,
      effects: {
        '0': { path: 'Inbox/One.md', etag: first.etag, id: first.id, revision_id: first.revision_id }
      }
    });
    const report = await ground.coordinator.recover();
    expect(report.finalized).toBe(1);
    expect(ground.coordinator.status(operationId)?.state).toBe('finalized');
    expect((await ground.store.readPath('Inbox/One.md')).raw).toContain('own output');
    expect((await ground.store.readPath('Inbox/Two.md')).raw).toContain('Inbox/Two.md');
  } finally {
    await ground.dispose();
  }
});

test('a completed effect later edited by a human is recovery-required and preserved', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const plan = writePlan([
      { path: 'Inbox/One.md', noteId: firstId, revisionId: randomUUID() },
      { path: 'Inbox/Two.md', noteId: secondId, revisionId: randomUUID() }
    ]);
    const first = await ground.store.put({
      path: 'Inbox/One.md',
      raw: managed(firstId, 'own output'),
      expectedEtag: null,
      idempotencyKey: `${key}:doc:0`,
      source: 'brain_capture'
    });
    const operationId = await reserveOperation(ground, key, plan, {
      preconditions_validated: true,
      effects: {
        '0': { path: 'Inbox/One.md', etag: first.etag, id: first.id, revision_id: first.revision_id }
      }
    });
    await writeFile(join(ground.vaultRoot, 'Inbox/One.md'), managed(firstId, 'human edit'));
    const report = await ground.coordinator.recover();
    expect(report.pending).toBe(1);
    expect(report.blocking_operations).toContain(operationId);
    expect(ground.coordinator.status(operationId)?.state).toBe('recovery_required');
    expect((await ground.store.readPath('Inbox/One.md')).raw).toContain('human edit');
  } finally {
    await ground.dispose();
  }
});

test('a document-complete first effect edited while a second effect is unfinished blocks finalization', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstRevision = randomUUID();
    const plan = writePlan([
      { path: 'Inbox/One.md', noteId: firstId, revisionId: firstRevision },
      { path: 'Inbox/Two.md', noteId: secondId, revisionId: randomUUID() }
    ]);
    const first = await ground.store.put({ path: 'Inbox/One.md', raw: managed(firstId, 'own output'),
      expectedEtag: null, idempotencyKey: `${key}:doc:0`, source: 'brain_capture', revisionId: firstRevision, parents: [] });
    const operationId = await reserveOperation(ground, key, plan, { preconditions_validated: true, effects: {
      '0': { path: 'Inbox/One.md', etag: first.etag, id: first.id, revision_id: first.revision_id, document_complete: true }
    } });
    const human = managed(firstId, 'human edit');
    await writeFile(join(ground.vaultRoot, 'Inbox/One.md'), human);
    const report = await ground.coordinator.recover();
    expect(report.blocking_operations).toContain(operationId);
    expect(ground.coordinator.status(operationId)?.receipt).toBeUndefined();
    expect((await ground.store.readPath('Inbox/One.md')).raw).toBe(human);
    await expect(ground.store.readPath('Inbox/Two.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally { await ground.dispose(); }
});

test('an unfinished effect sharing a completed path is not hidden by applied-path accounting', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const id = randomUUID();
    const plan = writePlan([
      { path: 'Inbox/Shared.md', noteId: id, revisionId: randomUUID() },
      { path: 'Inbox/Shared.md', noteId: id, revisionId: randomUUID() }
    ]);
    const first = await ground.store.put({ path: 'Inbox/Shared.md', raw: managed(id, 'first output'),
      expectedEtag: null, idempotencyKey: `${key}:doc:0`, source: 'brain_capture' });
    const operationId = await reserveOperation(ground, key, plan, { preconditions_validated: true, effects: {
      '0': { path: 'Inbox/Shared.md', etag: first.etag, id: first.id, revision_id: first.revision_id, document_complete: true }
    } });
    const report = await ground.coordinator.recover();
    expect(report.blocking_operations).toContain(operationId);
    expect(ground.coordinator.status(operationId)?.receipt).toBeUndefined();
    expect((await ground.store.readPath('Inbox/Shared.md')).raw).toBe(managed(id, 'first output'));
    expect(ground.store.getDocumentReceipt(`${key}:doc:1`)).toBeUndefined();
  } finally { await ground.dispose(); }
});

test('a durably completed document operation finalizes despite a later edit', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const noteId = randomUUID();
    const plan = writePlan([{ path: 'Inbox/One.md', noteId, revisionId: randomUUID() }]);
    await ground.store.put({
      path: 'Inbox/One.md',
      raw: managed(noteId, 'durable output'),
      expectedEtag: null,
      idempotencyKey: `${key}:doc:0`,
      source: 'brain_capture'
    });
    const operationId = await reserveOperation(ground, key, plan);
    await writeFile(join(ground.vaultRoot, 'Inbox/One.md'), managed(noteId, 'later human edit'));
    const report = await ground.coordinator.recover();
    expect(report.finalized).toBe(1);
    expect(ground.coordinator.status(operationId)?.state).toBe('finalized');
    expect((await ground.store.readPath('Inbox/One.md')).raw).toContain('later human edit');
  } finally {
    await ground.dispose();
  }
});

function captureIntent(key: string): LocalOperationIntent {
  return {
    tool: 'brain_capture',
    action: 'capture',
    project_id: null,
    idempotency_key: key,
    payload: {
      idempotency_key: key,
      note: {
        title: 'Legacy note',
        tags: [],
        content: { kind: 'note', summary: 'legacy', body_markdown: '# legacy\n' },
        evidence: [],
        related_ids: []
      }
    },
    preconditions: {}
  };
}

function capturePlan(path: string): LocalOperationPlan {
  return (identity) => {
    if (identity.kind !== 'note') throw new Error('note identity required');
    return {
      kind: 'note',
      heads: [],
      parents: [],
      read_set: [{ kind: 'path', path, expected: { kind: 'absent' } }],
      effects: [
        {
          kind: 'write',
          write: {
            path,
            raw: managed(identity.note_id, 'legacy'),
            id: identity.note_id,
            revision_id: identity.revision_id,
            parents: []
          }
        }
      ]
    };
  };
}

test('a legacy storage-key-only record binds to its document operation when unambiguous', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const receipt = (await ground.coordinator.run(
      captureIntent(key),
      capturePlan('Inbox/Legacy.md')
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    ground.operations.deleteSubordinates(receipt.operation_id);
    ground.operations.update(receipt.operation_id, {
      state: 'pending',
      receipt_json: null,
      updated_at: clock.now().toISOString()
    });
    expect(ground.operations.listSubordinates(receipt.operation_id)).toHaveLength(0);

    const stored = ground.store.getDocumentReceipt(`${key}:doc:0`);
    const replayed = (await ground.coordinator.run(
      captureIntent(key),
      capturePlan('Inbox/Legacy.md')
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    expect(replayed.operation_id).toBe(receipt.operation_id);
    const rows = ground.operations.listSubordinates(receipt.operation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].document_operation_id).toBe(stored?.operation_id);
    expect(await ground.revisions.hasRevision(replayed.id, replayed.revision_id)).toBe(true);
  } finally {
    await ground.dispose();
  }
});

test('a supersede plan must bind every replacement in its supersession chain', async () => {
  const ground = await openGround();
  try {
    const sourceId = randomUUID();
    const middleId = randomUUID();
    const finalId = randomUUID();
    const source = await ground.store.put({ path: 'Inbox/Source.md', raw: managed(sourceId, 'source'),
      expectedEtag: null, idempotencyKey: randomUUID(), source: 'test' });
    const middleRaw = managed(middleId, 'middle').replace('status: candidate',
      `status: superseded\nbrain_replacement_id: ${finalId}`);
    const middle = await ground.store.put({ path: 'Inbox/Middle.md', raw: middleRaw,
      expectedEtag: null, idempotencyKey: randomUUID(), source: 'test' });
    const final = await ground.store.put({ path: 'Inbox/Final.md', raw: managed(finalId, 'final'),
      expectedEtag: null, idempotencyKey: randomUUID(), source: 'test' });
    const key = randomUUID();
    const intent: LocalOperationIntent = { tool: 'brain_review', action: 'supersede', project_id: null,
      idempotency_key: key, payload: { action: 'supersede', idempotency_key: key, id: sourceId,
        expected_etag: source.etag, replacement_id: middleId, rationale: 'replacement' },
      preconditions: { id: sourceId, etag: source.etag } };
    const sourceCondition = { kind: 'note' as const, id: sourceId, expected: { kind: 'present' as const,
      path: source.path, etag: source.etag, revision_id: source.revision_id } };
    const middleCondition = { kind: 'note' as const, id: middleId, expected: { kind: 'present' as const,
      path: middle.path, etag: middle.etag, revision_id: middle.revision_id } };
    const finalCondition = { kind: 'note' as const, id: finalId, expected: { kind: 'present' as const,
      path: final.path, etag: final.etag, revision_id: final.revision_id } };
    const plan = (read_set: LocalPlannedOperation['read_set']) => ({ kind: 'note' as const, heads: [], parents: [],
      read_set, effects: [{ kind: 'write' as const, write: { path: source.path, id: sourceId,
        revision_id: randomUUID(), raw: managed(sourceId, 'superseded'), parents: [] } }] });
    await expect(ground.coordinator.run(intent, () => plan([sourceCondition, middleCondition]) as LocalPlannedOperation))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(ground.operations.findByKey(key)?.plan_json).toBeNull();
    const completeKey = randomUUID();
    await expect(ground.coordinator.run({ ...intent, idempotency_key: completeKey,
      payload: { ...intent.payload, idempotency_key: completeKey } } as LocalOperationIntent,
      () => plan([sourceCondition, middleCondition, finalCondition]) as LocalPlannedOperation)).resolves.toBeDefined();
  } finally { await ground.dispose(); }
});

test('an ambiguous legacy storage-key record reports recovery required', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const receipt = (await ground.coordinator.run(
      captureIntent(key),
      capturePlan('Inbox/Legacy.md')
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    ground.operations.deleteSubordinates(receipt.operation_id);
    ground.operations.update(receipt.operation_id, {
      state: 'pending',
      receipt_json: null,
      storage_key: JSON.stringify([`${key}:doc:1`]),
      updated_at: clock.now().toISOString()
    });
    await expect(
      ground.coordinator.run(captureIntent(key), capturePlan('Inbox/Legacy.md'))
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await ground.dispose();
  }
});

test('a legacy key matching two distinct document operations cannot be rebound even with a correct-length key array', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const receipt = await ground.coordinator.run(captureIntent(key), capturePlan('Inbox/Legacy.md'));
    const original = (await ground.store.readPath('Inbox/Legacy.md')).raw;
    const duplicateKey = `${key}:doc:0`;
    await ground.store.applyRename(planRename({ from: 'Inbox/Legacy.md', to: 'Inbox/Moved.md',
      files: await collectRenameSnapshots(ground.vaultRoot), idempotency_key: duplicateKey }));
    expect(ground.store.getDocumentReceipt(duplicateKey)?.operation_id).toBeTruthy();
    expect(ground.store.getMoveReceipt(duplicateKey)?.operation_id).toBeTruthy();
    ground.operations.deleteSubordinates(receipt.operation_id);
    ground.operations.update(receipt.operation_id, { state: 'pending', receipt_json: null,
      storage_key: JSON.stringify([duplicateKey]), updated_at: clock.now().toISOString() });
    await expect(ground.coordinator.run(captureIntent(key), capturePlan('Inbox/Legacy.md')))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await ground.store.readPath('Inbox/Moved.md')).raw).toBe(original);
    expect(ground.operations.listSubordinates(receipt.operation_id)).toEqual([]);
  } finally { await ground.dispose(); }
});

test('a pending same-key replay reclassifies changed untouched preconditions before executing', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const plan = writePlan([{ path: 'Inbox/One.md', noteId: randomUUID(), revisionId: randomUUID() }]);
    const intent = captureIntent(key);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
      value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([field, item]) => [field, canonical(item)])) : value;
    const payloadJson = JSON.stringify(canonical({ action: intent.action, payload: intent.payload, tool: intent.tool }));
    const operationId = await reserveOperation(ground, key, plan, { preconditions_validated: false },
      { json: payloadJson, hash: createHash('sha256').update(payloadJson).digest('hex') });
    await mkdir(join(ground.vaultRoot, 'Inbox'), { recursive: true });
    const human = managed(randomUUID(), 'human');
    await writeFile(join(ground.vaultRoot, 'Inbox/One.md'), human);
    await expect(ground.coordinator.run(intent, capturePlan('Inbox/One.md'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ground.coordinator.status(operationId)?.receipt).toBeUndefined();
    expect((await ground.store.readPath('Inbox/One.md')).raw).toBe(human);
  } finally { await ground.dispose(); }
});

test('a subordinate document-operation link cannot be silently rebound to a different operation', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const receipt = await ground.coordinator.run(captureIntent(key), capturePlan('Inbox/Legacy.md'));
    const row = ground.operations.listSubordinates(receipt.operation_id)[0];
    expect(row.document_operation_id).toBeTruthy();
    await expect(() => ground.operations.setSubordinateDocumentOperation(receipt.operation_id, 0, randomUUID()))
      .toThrowError(/conflicting document-operation linkage/);
    expect(ground.operations.listSubordinates(receipt.operation_id)[0].document_operation_id).toBe(row.document_operation_id);
  } finally { await ground.dispose(); }
});

test('a feedback receipt is true only after the exact verdict and reason are durably recorded', async () => {
  const ground = await openGround();
  try {
    const key = randomUUID();
    const id = randomUUID();
    const revision = randomUUID();
    const raw = managed(id, 'feedback target');
    await ground.store.put({ path: 'Inbox/Feedback.md', raw, expectedEtag: null,
      idempotencyKey: `${key}:seed`, source: 'test_seed', revisionId: revision, parents: [] });
    const now = clock.now().toISOString();
    const record = ground.operations.reserve({ operation_id: randomUUID(), idempotency_key: key,
      tool: 'brain_feedback', action: 'feedback', project_id: null, payload_hash: 'a'.repeat(64), payload_json: '{}',
      created_at: now, updated_at: now }).record;
    const plan = { kind: 'feedback', id, revision_id: revision, feedback_id: randomUUID(), verdict: 'useful', reason: 'verified',
      read_set: [{ kind: 'note', id, expected: { kind: 'present', path: 'Inbox/Feedback.md', revision_id: revision,
        etag: createHash('sha256').update(raw).digest('hex') } }] };
    ground.operations.update(record.operation_id, { plan_json: JSON.stringify(plan),
      storage_key: JSON.stringify([`${key}:feedback`]), progress_json: JSON.stringify({ preconditions_validated: true }), updated_at: now });
    const report = await ground.coordinator.recover();
    expect(report.finalized).toBe(1);
    expect(ground.coordinator.status(record.operation_id)?.receipt).toMatchObject({ recorded: true, feedback_id: plan.feedback_id });
    expect(ground.operations.getFeedbackEffect(record.operation_id)).toEqual({
      operation_id: record.operation_id, feedback_id: plan.feedback_id, id,
      revision_id: revision, verdict: 'useful', reason: 'verified'
    });
    ground.operations.close();
    ground.operations = LocalOperationJournal.open(join(ground.sandbox.state, 'operations.sqlite'));
    expect(ground.operations.getFeedbackEffect(record.operation_id)?.reason).toBe('verified');
  } finally { await ground.dispose(); }
});
