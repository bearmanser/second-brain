import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { LocalMutationCoordinator } from '../../src/core/mutation.js';
import type {
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt
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
  return [
    '---',
    `id: ${id}`,
    'brain_schema_version: 2',
    'type: note',
    'status: active',
    '---',
    '',
    `# ${marker}`,
    '',
    marker,
    ''
  ].join('\n');
}

function captureIntent(key: string, marker = 'capture marker'): LocalOperationIntent {
  return {
    tool: 'brain_capture',
    action: 'capture',
    project_id: null,
    idempotency_key: key,
    payload: {
      idempotency_key: key,
      note: {
        title: marker,
        tags: [],
        content: { kind: 'note', summary: marker, body_markdown: `# ${marker}\n\n${marker}\n` },
        evidence: [],
        related_ids: []
      }
    },
    preconditions: {}
  };
}

function capturePlan(path: string, marker = 'capture marker'): LocalOperationPlan {
  return (identity) => {
    if (identity.kind !== 'note') throw new Error('expected a note identity');
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
            raw: managed(identity.note_id, marker),
            id: identity.note_id,
            revision_id: identity.revision_id,
            parents: []
          }
        }
      ]
    };
  };
}

interface Brain {
  sandbox: Awaited<ReturnType<typeof vaultSandbox>>;
  vaultRoot: string;
  state: string;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  revisions: RevisionStore;
  operations: LocalOperationJournal;
  coordinator: LocalMutationCoordinator;
  operationsPath: string;
  refresh: () => Promise<void>;
  reopen: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function openBrain(indexFault = false): Promise<Brain> {
  const sandbox = await vaultSandbox();
  const store = await openDocumentStore({
    vault: sandbox.vault,
    state: sandbox.state,
    ...(indexFault
      ? {
          index: {
            upsert: () => {
              throw new Error('index is unavailable');
            },
            remove: () => undefined
          }
        }
      : {})
  });
  const vault = new FileVault(sandbox.vault, []);
  const revisions = await openRevisionStore(sandbox.state);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const refresh = async (): Promise<void> => {
    await reconcileCurrentVault({ vault, catalogue });
  };
  await refresh();
  const operationsPath = join(sandbox.state, 'operations.sqlite');
  const brain: Brain = {
    sandbox,
    vaultRoot: sandbox.vault,
    state: sandbox.state,
    store,
    catalogue,
    revisions,
    operationsPath,
    operations: LocalOperationJournal.open(operationsPath),
    coordinator: undefined as unknown as LocalMutationCoordinator,
    refresh,
    reopen: async () => {
      brain.operations.close();
      brain.operations = LocalOperationJournal.open(operationsPath);
      brain.coordinator = new LocalMutationCoordinator({
        operations: brain.operations,
        documents: store,
        catalogue,
        vaultRoot: sandbox.vault,
        clock,
        ids,
        revisions
      });
    },
    dispose: async () => {
      try {
        brain.operations.close();
      } catch {
        undefined;
      }
      await store.close();
      catalogue.close();
      await sandbox.dispose();
    }
  };
  brain.coordinator = new LocalMutationCoordinator({
    operations: brain.operations,
    documents: store,
    catalogue,
    vaultRoot: sandbox.vault,
    clock,
    ids,
    revisions
  });
  return brain;
}

test('a repeated identical request returns the original operation across restart, edit, and move', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const first = (await brain.coordinator.run(captureIntent(key), capturePlan('Inbox/One.md'))) as Extract<
      LocalOperationReceipt,
      { kind: 'note' }
    >;
    expect(first.kind).toBe('note');
    await brain.refresh();

    await writeFile(join(brain.vaultRoot, 'Inbox/One.md'), managed(first.id, 'edited marker'));
    await brain.refresh();
    const moved = await brain.store.applyRename(
      planRename({
        from: 'Inbox/One.md',
        to: 'Inbox/Moved.md',
        files: await collectRenameSnapshots(brain.vaultRoot)
      })
    );
    expect(moved.moved).toBe(true);
    await brain.refresh();

    await brain.reopen();
    const replayed = (await brain.coordinator.run(captureIntent(key), capturePlan('Inbox/One.md'))) as Extract<
      LocalOperationReceipt,
      { kind: 'note' }
    >;
    expect(replayed).toEqual(first);
    const status = brain.operations.findByKey(key);
    expect(status?.state).toBe('finalized');
    expect(status?.operation_id).toBe(first.operation_id);
  } finally {
    await brain.dispose();
  }
});

test('a reused key with a different payload or tool is an idempotency conflict', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    await brain.coordinator.run(captureIntent(key), capturePlan('Inbox/One.md'));
    await expect(
      brain.coordinator.run(captureIntent(key, 'different marker'), capturePlan('Inbox/Two.md'))
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const reviewKey = randomUUID();
    await brain.coordinator.run(captureIntent(reviewKey), capturePlan('Inbox/Three.md'));
    const reviewIntent: LocalOperationIntent = {
      tool: 'brain_review',
      action: 'archive',
      project_id: null,
      idempotency_key: reviewKey,
      payload: {
        action: 'archive',
        idempotency_key: reviewKey,
        id: randomUUID(),
        expected_etag: 'a'.repeat(64),
        rationale: 'archive'
      },
      preconditions: { id: randomUUID(), etag: 'a'.repeat(64) }
    };
    await expect(brain.coordinator.run(reviewIntent, capturePlan('Inbox/Four.md'))).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_CONFLICT' }
    );
  } finally {
    await brain.dispose();
  }
});

test('recovery finalizes a storage-complete operation whose receipt was never written', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const now = clock.now().toISOString();
    const noteId = randomUUID();
    const revisionId = randomUUID();
    const record = brain.operations.reserve({
      operation_id: randomUUID(),
      idempotency_key: key,
      tool: 'brain_capture',
      action: 'capture',
      project_id: null,
      payload_hash: 'a'.repeat(64),
      payload_json: '{}',
      created_at: now,
      updated_at: now
    }).record;
    const plan = {
      kind: 'note' as const,
      heads: [],
      parents: [],
      read_set: [{ kind: 'path' as const, path: 'Inbox/Recovered.md', expected: { kind: 'absent' as const } }],
      effects: [
        {
          kind: 'write' as const,
          write: {
            path: 'Inbox/Recovered.md',
            raw: managed(noteId, 'recovered marker'),
            id: noteId,
            revision_id: revisionId,
            parents: []
          }
        }
      ]
    };
    brain.operations.update(record.operation_id, {
      plan_json: JSON.stringify(plan),
      updated_at: now
    });
    await brain.store.put({
      path: 'Inbox/Recovered.md',
      raw: managed(noteId, 'recovered marker'),
      expectedEtag: null,
      idempotencyKey: `${key}:doc:0`,
      source: 'brain_capture'
    });

    const report = await brain.coordinator.recover();
    expect(report.finalized).toBe(1);
    const status = brain.coordinator.status(record.operation_id);
    expect(status?.state).toBe('finalized');
    expect(status?.receipt).toMatchObject({ kind: 'note', id: noteId });
    expect(brain.operations.findById(record.operation_id)?.receipt_json).not.toBeNull();
  } finally {
    await brain.dispose();
  }
});

test('an index failure after a durable write reports indexed false without failing the mutation', async () => {
  const brain = await openBrain(true);
  try {
    const key = randomUUID();
    const receipt = (await brain.coordinator.run(captureIntent(key), capturePlan('Inbox/Indexed.md'))) as Extract<
      LocalOperationReceipt,
      { kind: 'note' }
    >;
    expect(receipt.indexed).toBe(false);
    const status = brain.coordinator.status(receipt.operation_id);
    expect(status?.state).toBe('finalized');
    expect((await brain.store.readPath('Inbox/Indexed.md')).etag).toBe(receipt.etag);
  } finally {
    await brain.dispose();
  }
});

test('a coordinator move is journaled and reported with the destination path', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const captured = (await brain.coordinator.run(captureIntent(key), capturePlan('Inbox/Source.md'))) as Extract<
      LocalOperationReceipt,
      { kind: 'note' }
    >;
    await brain.refresh();
    const current = brain.catalogue.getById(captured.id);
    if (current === undefined) throw new Error('expected the captured note in the catalogue');
    const currentRevisionId = current.revision_id ?? current.hash;
    const moveKey = randomUUID();
    const moveIntent: LocalOperationIntent = {
      tool: 'brain_review',
      action: 'move',
      project_id: null,
      idempotency_key: moveKey,
      payload: {
        action: 'move',
        idempotency_key: moveKey,
        id: captured.id,
        target_path: 'Inbox/Destination.md',
        expected_etag: captured.etag,
        rationale: 'relocate'
      },
      preconditions: { id: captured.id, etag: captured.etag, target_path: 'Inbox/Destination.md' }
    };
    const movePlan: LocalOperationPlan = () => ({
      kind: 'note',
      heads: [],
      parents: [],
      read_set: [
        {
          kind: 'note',
          id: captured.id,
          expected: {
            kind: 'present',
            path: 'Inbox/Source.md',
            revision_id: currentRevisionId,
            etag: captured.etag
          }
        },
        { kind: 'path', path: 'Inbox/Destination.md', expected: { kind: 'absent' } }
      ],
      effects: [{ kind: 'move', from_path: 'Inbox/Source.md', to_path: 'Inbox/Destination.md' }]
    });
    const moved = (await brain.coordinator.run(moveIntent, movePlan)) as Extract<
      LocalOperationReceipt,
      { kind: 'note' }
    >;
    expect(moved.path).toBe('Inbox/Destination.md');
    await expect(brain.store.readPath('Inbox/Source.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await brain.store.readPath('Inbox/Destination.md')).etag).toBe(moved.etag);
  } finally {
    await brain.dispose();
  }
});

test('concurrent operations on one vacant path serialize and the loser conflicts', async () => {
  const brain = await openBrain();
  try {
    const [first, second] = await Promise.allSettled([
      brain.coordinator.run(captureIntent(randomUUID()), capturePlan('Inbox/Race.md')),
      brain.coordinator.run(captureIntent(randomUUID()), capturePlan('Inbox/Race.md'))
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = first.status === 'rejected' ? first : second;
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
  } finally {
    await brain.dispose();
  }
});
