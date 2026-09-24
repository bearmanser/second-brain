import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { LocalMutationCoordinator } from '../../src/core/mutation.js';
import type {
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt
} from '../../src/core/types.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { collectRenameSnapshots, planRename, type RenamePlan } from '../../src/notes/rename.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function managed(id: string, marker: string): string {
  return ['---', `id: ${id}`, 'brain_schema_version: 2', 'type: note', 'status: candidate', '---', '', `# ${marker}`, '', marker, ''].join('\n');
}

interface Brain {
  sandbox: Awaited<ReturnType<typeof vaultSandbox>>;
  vaultRoot: string;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  revisions: RevisionStore;
  operations: LocalOperationJournal;
  coordinator: LocalMutationCoordinator;
  operationsPath: string;
  state: string;
  refresh: () => Promise<void>;
  reopen: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function openBrain(): Promise<Brain> {
  const sandbox = await vaultSandbox();
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const revisions = await openRevisionStore(sandbox.state);
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const refresh = async (): Promise<void> => {
    await reconcileCurrentVault({ vault, catalogue });
  };
  await refresh();
  const operationsPath = join(sandbox.state, 'operations.sqlite');
  const brain: Brain = {
    sandbox,
    vaultRoot: sandbox.vault,
    store,
    catalogue,
    revisions,
    operationsPath,
    state: sandbox.state,
    operations: LocalOperationJournal.open(operationsPath),
    coordinator: undefined as unknown as LocalMutationCoordinator,
    refresh,
    reopen: async () => {
      brain.operations.close();
      brain.operations = LocalOperationJournal.open(operationsPath);
      brain.coordinator = makeCoordinator(brain);
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
  brain.coordinator = makeCoordinator(brain);
  return brain;
}

function makeCoordinator(brain: Brain): LocalMutationCoordinator {
  return new LocalMutationCoordinator({
    operations: brain.operations,
    documents: brain.store,
    catalogue: brain.catalogue,
    vaultRoot: brain.vaultRoot,
    clock,
    ids,
    revisions: brain.revisions
  });
}

interface SeededHead {
  raw: string;
  revisionId: string;
  hash: string;
}

async function seedHead(
  brain: Brain,
  id: string,
  path: string,
  marker: string,
  parents: readonly { revision_id: string; raw_hash: string }[]
): Promise<SeededHead> {
  const raw = managed(id, marker);
  const revisionId = randomUUID();
  await brain.revisions.persistRevision(id, revisionId, raw);
  await brain.revisions.persistRevisionMetadata({
    id,
    revision_id: revisionId,
    parents,
    created_at: new Date().toISOString()
  });
  const absolute = join(brain.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw);
  return { raw, revisionId, hash: sha256(raw) };
}

async function seedRoot(brain: Brain, id: string, marker: string): Promise<SeededHead> {
  const raw = managed(id, marker);
  const revisionId = randomUUID();
  await brain.revisions.persistRevision(id, revisionId, raw);
  await brain.revisions.persistRevisionMetadata({
    id,
    revision_id: revisionId,
    parents: [],
    created_at: new Date().toISOString()
  });
  return { raw, revisionId, hash: sha256(raw) };
}

async function seedRawHead(
  brain: Brain,
  id: string,
  path: string,
  marker: string
): Promise<SeededHead> {
  const raw = managed(id, marker);
  const revisionId = randomUUID();
  await brain.revisions.persistRevision(id, revisionId, raw);
  const absolute = join(brain.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw);
  return { raw, revisionId, hash: sha256(raw) };
}

function resolveIntent(
  key: string,
  id: string,
  expectedHeads: readonly { revision_id: string; etag: string }[]
): LocalOperationIntent {
  return {
    tool: 'brain_review',
    action: 'resolve',
    project_id: null,
    idempotency_key: key,
    payload: {
      action: 'resolve',
      idempotency_key: key,
      id,
      expected_heads: [...expectedHeads],
      rationale: 'merge the branches',
      note: {
        title: 'resolved',
        tags: [],
        content: { kind: 'note', summary: 'resolved', body_markdown: '# resolved\n' },
        evidence: [],
        related_ids: []
      }
    },
    preconditions: { id, expected_heads: [...expectedHeads] }
  };
}

test('a two-head legitimate fork consolidates on disk with ancestry retained', async () => {
  const brain = await openBrain();
  try {
    const id = randomUUID();
    const root = await seedRoot(brain, id, 'root');
    const a = await seedHead(brain, id, 'Knowledge/A.md', 'branch A', [
      { revision_id: root.revisionId, raw_hash: root.hash }
    ]);
    const b = await seedHead(brain, id, 'Knowledge/B.md', 'branch B', [
      { revision_id: root.revisionId, raw_hash: root.hash }
    ]);
    await brain.refresh();

    const heads = await brain.coordinator.enumerateConflictHeads(id);
    expect(heads.map((head) => head.revision_id).sort()).toEqual(
      [a.revisionId, b.revisionId].sort()
    );
    const expectedHeads = heads.map((head) => ({
      revision_id: head.revision_id,
      etag: head.etag
    }));
    await brain.coordinator.verifyConflictHeads(id, expectedHeads);

    const newRevision = randomUUID();
    const resolutionRaw = managed(id, 'resolved');
    const key = randomUUID();
    const plan: LocalOperationPlan = (_identity, observed) => ({
      kind: 'note',
      heads: observed.heads,
      parents: observed.heads.map((head) => ({
        revision_id: head.revision_id,
        raw_hash: head.etag
      })),
      read_set: [
        {
          kind: 'heads',
          id,
          expected_heads: observed.heads.map((head) => ({
            revision_id: head.revision_id,
            etag: head.etag
          }))
        },
        {
          kind: 'note',
          id,
          expected: {
            kind: 'present',
            path: 'Knowledge/A.md',
            revision_id: a.revisionId,
            etag: a.hash
          }
        },
        {
          kind: 'path',
          path: 'Knowledge/B.md',
          expected: { kind: 'present', etag: b.hash, id }
        }
      ],
      effects: [
        {
          kind: 'write',
          write: {
            path: 'Knowledge/A.md',
            raw: resolutionRaw,
            id,
            revision_id: newRevision,
            parents: observed.heads.map((head) => ({
              revision_id: head.revision_id,
              raw_hash: head.etag
            }))
          }
        },
        {
          kind: 'remove',
          path: 'Knowledge/B.md',
          expected_id: id,
          expected_revision_id: b.revisionId,
          expected_etag: b.hash
        }
      ],
      reference_edits: []
    });

    const receipt = (await brain.coordinator.run(
      resolveIntent(key, id, expectedHeads),
      plan
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    expect(receipt.path).toBe('Knowledge/A.md');
    expect(receipt.revision_id).toBe(newRevision);

    await expect(brain.store.readPath('Knowledge/B.md')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
    expect((await brain.store.readPath('Knowledge/A.md')).raw).toContain('resolved');
    expect(await brain.revisions.hasRevision(id, a.revisionId)).toBe(true);
    expect(await brain.revisions.hasRevision(id, b.revisionId)).toBe(true);
    const metadata = await brain.revisions.readRevisionMetadata(id, newRevision);
    expect(metadata.parents.map((parent) => parent.revision_id).sort()).toEqual(
      [a.revisionId, b.revisionId].sort()
    );

    await brain.reopen();
    await brain.refresh();
    expect(brain.catalogue.getById(id)?.revision_id).toBe(newRevision);
    const status = brain.coordinator.status(receipt.operation_id);
    expect(status?.state).toBe('finalized');
    expect((status?.receipt as { revision_id?: string }).revision_id).toBe(newRevision);
  } finally {
    await brain.dispose();
  }
});

test('an exact copied duplicate remains an identity conflict', async () => {
  const brain = await openBrain();
  try {
    const id = randomUUID();
    const root = await seedRoot(brain, id, 'root');
    const a = await seedHead(brain, id, 'Knowledge/A.md', 'branch A', [
      { revision_id: root.revisionId, raw_hash: root.hash }
    ]);
    await seedHead(brain, id, 'Knowledge/B.md', 'branch A', [
      { revision_id: root.revisionId, raw_hash: root.hash }
    ]);
    await brain.refresh();
    const heads = await brain.coordinator.enumerateConflictHeads(id);
    const expectedHeads = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    await expect(brain.coordinator.verifyConflictHeads(id, expectedHeads)).rejects.toMatchObject({
      code: 'CONFLICT'
    });
    expect(a.revisionId).toBeTruthy();
  } finally {
    await brain.dispose();
  }
});

test('an unknown-provenance duplicate is rejected as a conflict', async () => {
  const brain = await openBrain();
  try {
    const id = randomUUID();
    await mkdir(join(brain.vaultRoot, 'Knowledge'), { recursive: true });
    await writeFile(join(brain.vaultRoot, 'Knowledge/A.md'), managed(id, 'branch A'));
    await writeFile(join(brain.vaultRoot, 'Knowledge/B.md'), managed(id, 'branch B'));
    await brain.refresh();
    const heads = await brain.coordinator.enumerateConflictHeads(id);
    const expectedHeads = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    await expect(brain.coordinator.verifyConflictHeads(id, expectedHeads)).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await brain.dispose();
  }
});

test('ancestry failures are recovery-required and ancestor-as-head is a conflict', async () => {
  const brain = await openBrain();
  try {
    const missingId = randomUUID();
    const rootA = await seedRoot(brain, missingId, 'root');
    const a = await seedHead(brain, missingId, 'Knowledge/A.md', 'branch A', [
      { revision_id: rootA.revisionId, raw_hash: rootA.hash }
    ]);
    await seedHead(brain, missingId, 'Knowledge/B.md', 'branch B', [
      { revision_id: randomUUID(), raw_hash: 'a'.repeat(64) }
    ]);
    await brain.refresh();
    const missingHeads = (await brain.coordinator.enumerateConflictHeads(missingId)).map(
      (head) => ({ revision_id: head.revision_id, etag: head.etag })
    );
    await expect(
      brain.coordinator.verifyConflictHeads(missingId, missingHeads)
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(a.revisionId).toBeTruthy();

    const cycleId = randomUUID();
    const first = await seedRawHead(brain, cycleId, 'Knowledge/One.md', 'one');
    const second = await seedRawHead(brain, cycleId, 'Knowledge/Two.md', 'two');
    await brain.revisions.persistRevisionMetadata({
      id: cycleId,
      revision_id: first.revisionId,
      parents: [{ revision_id: second.revisionId, raw_hash: second.hash }],
      created_at: new Date().toISOString()
    });
    await brain.revisions.persistRevisionMetadata({
      id: cycleId,
      revision_id: second.revisionId,
      parents: [{ revision_id: first.revisionId, raw_hash: first.hash }],
      created_at: new Date().toISOString()
    });
    await brain.refresh();
    const cycleHeads = (await brain.coordinator.enumerateConflictHeads(cycleId)).map(
      (head) => ({ revision_id: head.revision_id, etag: head.etag })
    );
    await expect(
      brain.coordinator.verifyConflictHeads(cycleId, cycleHeads)
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    const ancestorId = randomUUID();
    const ancestor = await seedRawHead(brain, ancestorId, 'Knowledge/Ancestor.md', 'ancestor');
    await brain.revisions.persistRevisionMetadata({
      id: ancestorId,
      revision_id: ancestor.revisionId,
      parents: [],
      created_at: new Date().toISOString()
    });
    const descendant = await seedRawHead(
      brain,
      ancestorId,
      'Knowledge/Descendant.md',
      'descendant'
    );
    await brain.revisions.persistRevisionMetadata({
      id: ancestorId,
      revision_id: descendant.revisionId,
      parents: [{ revision_id: ancestor.revisionId, raw_hash: ancestor.hash }],
      created_at: new Date().toISOString()
    });
    await brain.refresh();
    const ancestorHeads = (await brain.coordinator.enumerateConflictHeads(ancestorId)).map(
      (head) => ({ revision_id: head.revision_id, etag: head.etag })
    );
    await expect(
      brain.coordinator.verifyConflictHeads(ancestorId, ancestorHeads)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(descendant.revisionId).toBeTruthy();
  } finally {
    await brain.dispose();
  }
});

test('a move completed before receipt finalization is finalized from its stored manifest', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const noteId = randomUUID();
    const seeded = await brain.store.put({
      path: 'Inbox/Source.md',
      raw: managed(noteId, 'move marker'),
      expectedEtag: null,
      idempotencyKey: `${key}:seed`,
      source: 'test_seed'
    });
    const revisionId = seeded.revision_id;
    const sourcePath = 'Inbox/Source.md';
    await brain.refresh();

    const renamePlan: RenamePlan = planRename({
      from: sourcePath,
      to: 'Inbox/Target.md',
      files: await collectRenameSnapshots(brain.vaultRoot),
      idempotency_key: `${key}:move:0`
    });
    await brain.store.applyRename(renamePlan);

    const now = clock.now().toISOString();
    const record = brain.operations.reserve({
      operation_id: randomUUID(),
      idempotency_key: key,
      tool: 'brain_review',
      action: 'move',
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
      read_set: [
        {
          kind: 'note' as const,
          id: noteId,
          expected: {
            kind: 'present' as const,
            path: sourcePath,
            revision_id: revisionId,
            etag: 'b'.repeat(64)
          }
        },
        { kind: 'path' as const, path: 'Inbox/Target.md', expected: { kind: 'absent' as const } }
      ],
      effects: [
        { kind: 'move' as const, from_path: sourcePath, to_path: 'Inbox/Target.md' }
      ]
    };
    brain.operations.update(record.operation_id, {
      plan_json: JSON.stringify(plan),
      progress_json: JSON.stringify({ renames: { '0': renamePlan } }),
      updated_at: now
    });

    const report = await brain.coordinator.recover();
    expect(report.finalized).toBe(1);
    const status = brain.coordinator.status(record.operation_id);
    expect(status?.state).toBe('finalized');
    expect((status?.receipt as { path?: string }).path).toBe('Inbox/Target.md');
    await expect(brain.store.readPath(sourcePath)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await brain.dispose();
  }
});
