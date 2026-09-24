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
  let revisions = await openRevisionStore(sandbox.state);
  const vault = new FileVault(sandbox.vault, []);
  let catalogue = CurrentCatalogue.open({ revisions, ids });
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
      await brain.store.close();
      catalogue.close();
      revisions.close();
      revisions = await openRevisionStore(sandbox.state);
      catalogue = CurrentCatalogue.open({ revisions, ids });
      brain.revisions = revisions;
      brain.catalogue = catalogue;
      brain.store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
      brain.operations = LocalOperationJournal.open(operationsPath);
      brain.coordinator = makeCoordinator(brain);
      await refresh();
    },
    dispose: async () => {
      try {
        brain.operations.close();
      } catch {
        undefined;
      }
      await brain.store.close();
      catalogue.close();
      revisions.close();
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
  await brain.revisions.bindCurrent(id, path, revisionId, sha256(raw));
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
  await brain.revisions.bindCurrent(id, path, revisionId, sha256(raw));
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
          expected: { kind: 'present', etag: b.hash, id, revision_id: b.revisionId }
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
    expect((await brain.revisions.readRevision(id, a.revisionId)).raw).toBe(a.raw);
    expect((await brain.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
    const metadata = await brain.revisions.readRevisionMetadata(id, newRevision);
    expect(metadata.parents.map((parent) => parent.revision_id).sort()).toEqual(
      [a.revisionId, b.revisionId].sort()
    );

    await brain.reopen();
    await brain.refresh();
    expect(brain.catalogue.getById(id)?.revision_id).toBe(newRevision);
    expect((await brain.store.readPath('Knowledge/A.md')).revision_id).toBe(newRevision);
    expect((await brain.revisions.readRevision(id, newRevision)).raw).toBe(resolutionRaw);
    expect(brain.store.getConsolidationReceipt(`${key}:consolidate`)).toMatchObject({ id, revision_id: newRevision, path: 'Knowledge/A.md' });
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

test('an edited copy matching known historical bytes cannot inherit ancestry without a path binding', async () => {
  const brain = await openBrain();
  try {
    const id = randomUUID();
    const root = await seedRoot(brain, id, 'ancestor');
    const parents = [{ revision_id: root.revisionId, raw_hash: root.hash }];
    const a = await seedHead(brain, id, 'Knowledge/A.md', 'branch A', parents);
    const b = await seedHead(brain, id, 'Knowledge/B.md', 'branch B', parents);
    const editedCopy = 'Knowledge/EditedCopy.md';
    await writeFile(join(brain.vaultRoot, editedCopy), managed(id, 'temporary human copy'));
    await brain.refresh();
    await writeFile(join(brain.vaultRoot, editedCopy), root.raw);
    const heads = await brain.coordinator.enumerateConflictHeads(id);
    expect(heads.find((head) => head.path === editedCopy)?.revision_id).toBe('');
    expect((await brain.store.readPath(editedCopy)).raw).toBe((await brain.revisions.readRevision(id, root.revisionId)).raw);
    await expect(brain.coordinator.verifyConflictHeads(id, [
      { revision_id: a.revisionId, etag: a.hash },
      { revision_id: b.revisionId, etag: b.hash },
      { revision_id: root.revisionId, etag: root.hash }
    ])).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally { await brain.dispose(); }
});

test('head enumeration ignores a stale catalogue cache and includes an unscanned duplicate', async () => {
  const brain = await openBrain();
  try {
    const id = randomUUID();
    const root = await seedRoot(brain, id, 'ancestor');
    const parents = [{ revision_id: root.revisionId, raw_hash: root.hash }];
    const a = await seedHead(brain, id, 'Knowledge/A.md', 'branch A', parents);
    const b = await seedHead(brain, id, 'Knowledge/B.md', 'branch B', parents);
    await brain.refresh();
    const original = [a, b].map((head) => ({ revision_id: head.revisionId, etag: head.hash }));
    await brain.coordinator.verifyConflictHeads(id, original);
    const extraPath = 'Knowledge/Unscanned.md';
    const extra = managed(id, 'unscanned foreign copy');
    await writeFile(join(brain.vaultRoot, extraPath), extra);
    expect(brain.catalogue.conflictsFor(id)).toHaveLength(2);
    const current = await brain.coordinator.enumerateConflictHeads(id);
    expect(current.map((head) => head.path)).toContain(extraPath);
    expect(current.find((head) => head.path === extraPath)?.revision_id).toBe('');
    await expect(brain.coordinator.verifyConflictHeads(id, original)).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally { await brain.dispose(); }
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
      progress_json: JSON.stringify({ preconditions_validated: true, renames: { '0': renamePlan } }),
      storage_key: JSON.stringify([`${key}:move:0`]),
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

test('a move interrupted after detaching its source replays the persisted in-flight manifest before original read-set checks', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const noteId = randomUUID();
    const source = 'Inbox/Source.md';
    const target = 'Inbox/Target.md';
    const raw = managed(noteId, 'move marker');
    const seeded = await brain.store.put({ path: source, raw, expectedEtag: null, idempotencyKey: `${key}:seed`, source: 'test_seed' });
    await brain.refresh();
    await brain.store.close();
    let armed = true;
    brain.store = await openDocumentStore({ vault: brain.vaultRoot, state: brain.state, faults: {
      rename: { afterMoveStep: () => { if (armed) { armed = false; throw new Error('interrupted'); } } }
    } });
    brain.coordinator = makeCoordinator(brain);
    const intent: LocalOperationIntent = {
      tool: 'brain_review', action: 'move', project_id: null, idempotency_key: key,
      payload: { action: 'move', id: noteId, idempotency_key: key, target_path: target, expected_etag: seeded.etag, rationale: 'relocate' },
      preconditions: { id: noteId, etag: seeded.etag, target_path: target }
    };
    const plan: LocalOperationPlan = () => ({ kind: 'note', heads: [], parents: [], read_set: [
      { kind: 'note', id: noteId, expected: { kind: 'present', path: source, revision_id: seeded.revision_id, etag: seeded.etag } },
      { kind: 'path', path: target, expected: { kind: 'absent' } }
    ], effects: [{ kind: 'move', from_path: source, to_path: target }] });
    await expect(brain.coordinator.run(intent, plan)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(JSON.parse(brain.operations.findByKey(key)?.progress_json ?? '{}')).toHaveProperty('renames.0');
    await expect(brain.store.readPath(source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await brain.store.readPath(target)).raw).toBe(raw);
    expect(brain.operations.findByKey(key)?.receipt_json).toBeNull();
    await brain.reopen();
    const report = await brain.coordinator.recover();
    expect(report.finalized).toBe(1);
    const recorded = brain.operations.findByKey(key)!;
    expect(recorded.state).toBe('finalized');
    const move = brain.store.getMoveReceipt(`${key}:move:0`);
    expect(move).toBeDefined();
    expect(brain.coordinator.status(recorded.operation_id)?.receipt).toMatchObject({
      path: target, id: noteId, indexed: move?.moved_indexed
    });
    expect((await brain.store.readPath(target)).raw).toBe(raw);
  } finally { await brain.dispose(); }
});

test('an optional post-move write reserves and links its own document operation and revision', async () => {
  const brain = await openBrain();
  try {
    const key = randomUUID();
    const id = randomUUID();
    const from = 'Inbox/Source.md';
    const to = 'Inbox/Target.md';
    const seeded = await brain.store.put({ path: from, raw: managed(id, 'original'), expectedEtag: null,
      idempotencyKey: `${key}:seed`, source: 'test_seed' });
    const revisionId = randomUUID();
    const updated = managed(id, 'updated after move');
    const intent: LocalOperationIntent = { tool: 'brain_review', action: 'move', project_id: null, idempotency_key: key,
      payload: { action: 'move', idempotency_key: key, id, target_path: to, expected_etag: seeded.etag, rationale: 'relocate' },
      preconditions: { id, etag: seeded.etag, target_path: to } };
    const plan: LocalOperationPlan = () => ({ kind: 'note', heads: [], parents: [], read_set: [
      { kind: 'note', id, expected: { kind: 'present', path: from, etag: seeded.etag, revision_id: seeded.revision_id } },
      { kind: 'path', path: to, expected: { kind: 'absent' } }
    ], effects: [{ kind: 'move', from_path: from, to_path: to,
      write: { path: to, id, revision_id: revisionId, raw: updated,
        parents: [{ revision_id: seeded.revision_id, raw_hash: seeded.etag }] } }] });
    const receipt = await brain.coordinator.run(intent, plan);
    expect(receipt).toMatchObject({ kind: 'note', revision_id: revisionId, path: to });
    expect((await brain.store.readPath(to)).raw).toBe(updated);
    expect((await brain.revisions.readRevision(id, revisionId)).raw).toBe(updated);
    const rows = brain.operations.listSubordinates(receipt.operation_id);
    expect(rows.map((row) => [row.effect_index, row.key])).toEqual([[0, `${key}:move:0`], [1000, `${key}:doc:1000`]]);
    expect(rows.every((row) => row.document_operation_id !== null)).toBe(true);
    await brain.reopen();
    expect(await brain.coordinator.run(intent, plan)).toEqual(receipt);
  } finally { await brain.dispose(); }
});
