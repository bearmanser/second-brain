import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { LocalMutationCoordinator } from '../../src/core/mutation.js';
import type {
  LocalDocumentEffect,
  LocalOperationIntent,
  LocalOperationPlan,
  LocalPlannedOperation,
  LocalReadSet,
  LocalOperationReceipt,
  LocalReferenceEdit
} from '../../src/core/types.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { recallLocal } from '../../src/features/recall.js';
import { buildLocalHandlerDeps, type LocalBrain } from '../../src/features/local-support.js';
import { reviewerContext } from '../fixtures/principals.js';
import {
  openDocumentStore,
  type DocumentIndex,
  type DocumentStore,
  type DocumentStoreFaults
} from '../../src/storage/document-store.js';
import { LocalOperationJournal, LocalWriteJournal } from '../../src/storage/journal.js';
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

interface Ground {
  sandbox: Awaited<ReturnType<typeof vaultSandbox>>;
  vaultRoot: string;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  revisions: RevisionStore;
  operations: LocalOperationJournal;
  coordinator: LocalMutationCoordinator;
  refresh: () => Promise<void>;
  reopenStore: (faults?: DocumentStoreFaults) => Promise<void>;
  dispose: () => Promise<void>;
}

async function openGround(
  storeFaults?: DocumentStoreFaults,
  index?: DocumentIndex
): Promise<Ground> {
  const sandbox = await vaultSandbox();
  let revisions = await openRevisionStore(sandbox.state);
  const makeStore = (): Promise<DocumentStore> =>
    openDocumentStore({
      vault: sandbox.vault,
      state: sandbox.state,
      ...(storeFaults === undefined ? {} : { faults: storeFaults }),
      ...(index === undefined ? {} : { index })
    });
  const store = await makeStore();
  const vault = new FileVault(sandbox.vault, []);
  let catalogue = CurrentCatalogue.open({ revisions, ids });
  const refresh = async (): Promise<void> => {
    await reconcileCurrentVault({ vault, catalogue });
  };
  await refresh();
  let operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const ground: Ground = {
    sandbox,
    vaultRoot: sandbox.vault,
    store,
    catalogue,
    revisions,
    operations,
    coordinator: undefined as unknown as LocalMutationCoordinator,
    refresh,
    reopenStore: async (faults) => {
      await ground.store.close();
      operations.close();
      catalogue.close();
      revisions.close();
      revisions = await openRevisionStore(sandbox.state);
      catalogue = CurrentCatalogue.open({ revisions, ids });
      operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
      ground.revisions = revisions;
      ground.catalogue = catalogue;
      ground.operations = operations;
      ground.store = await openDocumentStore({
        vault: sandbox.vault,
        state: sandbox.state,
        ...(faults === undefined ? {} : { faults })
      });
      await ground.store.recover();
      ground.coordinator = makeCoordinator(ground);
      await refresh();
    },
    dispose: async () => {
      try {
        ground.operations.close();
      } catch {
        undefined;
      }
      await ground.store.close();
      catalogue.close();
      revisions.close();
      await sandbox.dispose();
    }
  };
  ground.coordinator = makeCoordinator(ground);
  return ground;
}

function makeCoordinator(ground: Ground): LocalMutationCoordinator {
  return new LocalMutationCoordinator({
    operations: ground.operations,
    documents: ground.store,
    catalogue: ground.catalogue,
    vaultRoot: ground.vaultRoot,
    clock,
    ids,
    revisions: ground.revisions
  });
}

interface Seeded {
  raw: string;
  revisionId: string;
  hash: string;
}

async function seedRevisionOnly(ground: Ground, id: string, raw: string): Promise<Seeded> {
  const revisionId = randomUUID();
  await ground.revisions.persistRevision(id, revisionId, raw);
  return { raw, revisionId, hash: sha256(raw) };
}

async function writeManaged(
  ground: Ground,
  id: string,
  path: string,
  raw: string,
  parents: readonly { revision_id: string; raw_hash: string }[]
): Promise<Seeded> {
  const seeded = await seedRevisionOnly(ground, id, raw);
  await ground.revisions.persistRevisionMetadata({
    id,
    revision_id: seeded.revisionId,
    parents,
    created_at: new Date().toISOString()
  });
  const absolute = join(ground.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw);
  await ground.revisions.bindCurrent(id, path, seeded.revisionId, seeded.hash);
  return seeded;
}

function resolveIntent(
  key: string,
  id: string,
  heads: readonly { revision_id: string; etag: string }[]
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
      expected_heads: [...heads],
      rationale: 'merge branches',
      note: {
        title: 'resolved',
        tags: [],
        content: { kind: 'note', summary: 'resolved', body_markdown: '# resolved\n' },
        evidence: [],
        related_ids: []
      }
    },
    preconditions: { id, expected_heads: [...heads] }
  };
}

interface ResolveSpec {
  id: string;
  survivorPath: string;
  survivorEtag: string;
  removalPaths: readonly { path: string; id: string; revisionId: string; etag: string }[];
  resolutionRaw: string;
  resolutionRevision: string;
  referenceEdits?: readonly LocalReferenceEdit[];
  extraReadSet?: readonly import('../../src/core/types.js').LocalReadCondition[];
}

function resolvePlan(spec: ResolveSpec): LocalOperationPlan {
  return (_identity, observed) => {
    const parents = observed.heads.map((head) => ({
      revision_id: head.revision_id,
      raw_hash: head.etag
    }));
    const effects: LocalDocumentEffect[] = [
      {
        kind: 'write',
        write: {
          path: spec.survivorPath,
          raw: spec.resolutionRaw,
          id: spec.id,
          revision_id: spec.resolutionRevision,
          parents
        }
      },
      ...spec.removalPaths.map(
        (removal): LocalDocumentEffect => ({
          kind: 'remove',
          path: removal.path,
          expected_id: removal.id,
          expected_revision_id: removal.revisionId,
          expected_etag: removal.etag
        })
      )
    ];
    return {
      kind: 'note',
      heads: observed.heads,
      parents,
      read_set: [
        {
          kind: 'heads',
          id: spec.id,
          expected_heads: observed.heads.map((head) => ({
            revision_id: head.revision_id,
            etag: head.etag
          }))
        },
        ...(spec.extraReadSet ?? []),
        {
          kind: 'path',
          path: spec.survivorPath,
          expected: { kind: 'present', etag: spec.survivorEtag, id: spec.id, revision_id: observed.heads.find((head) => head.path === spec.survivorPath)?.revision_id }
        },
        ...spec.removalPaths.map(
          (removal): import('../../src/core/types.js').LocalReadCondition => ({
            kind: 'path',
            path: removal.path,
            expected: { kind: 'present', etag: removal.etag, id: removal.id, revision_id: removal.revisionId }
          })
        ),
        ...(spec.referenceEdits ?? [])
          .filter((edit, index, all) => edit.managed === undefined && all.findIndex((other) => other.path === edit.path) === index)
          .map(
            (edit): import('../../src/core/types.js').LocalReadCondition => ({
              kind: 'path',
              path: edit.path,
              expected: { kind: 'present', etag: edit.expected_etag }
            })
          )
      ],
      effects,
      reference_edits: spec.referenceEdits ?? []
    };
  };
}

async function twoHeadGround(
  survivorExtra?: (ground: Ground, id: string) => Promise<void>
): Promise<{
  ground: Ground;
  id: string;
  a: Seeded;
  b: Seeded;
}> {
  const ground = await openGround();
  const id = randomUUID();
  const root = await seedRevisionOnly(ground, id, managed(id, 'root'));
  await ground.revisions.persistRevisionMetadata({
    id,
    revision_id: root.revisionId,
    parents: [],
    created_at: new Date().toISOString()
  });
  const a = await writeManaged(ground, id, 'Knowledge/A.md', managed(id, 'branch A'), [
    { revision_id: root.revisionId, raw_hash: root.hash }
  ]);
  const b = await writeManaged(ground, id, 'Knowledge/B.md', managed(id, 'branch B'), [
    { revision_id: root.revisionId, raw_hash: root.hash }
  ]);
  if (survivorExtra !== undefined) await survivorExtra(ground, id);
  await ground.refresh();
  return { ground, id, a, b };
}

test('consolidation applies managed and unmanaged reference edits with durable preimages', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const managedId = randomUUID();
    const managedRaw = managed(managedId, 'referrer');
    const managedRevision = randomUUID();
    await ground.store.put({
      path: 'Knowledge/Referrer.md',
      raw: managedRaw,
      expectedEtag: null,
      idempotencyKey: 'seed-referrer',
      source: 'test_seed',
      revisionId: managedRevision,
      parents: []
    });
    const plainRaw = '# Plain\n\nsee [[Knowledge/B]]\n';
    await writeFile(join(ground.vaultRoot, 'Knowledge/Plain.md'), plainRaw);
    await ground.refresh();

    const managedEditRaw = `${managedRaw}\nsee [[Knowledge/A]]\n`;
    const plainEditRaw = '# Plain\n\nsee [[Knowledge/A]]\n';
    const refRevision = randomUUID();
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID(),
      extraReadSet: [
        {
          kind: 'note',
          id: managedId,
          expected: {
            kind: 'present',
            path: 'Knowledge/Referrer.md',
            revision_id: managedRevision,
            etag: sha256(managedRaw)
          }
        }
      ],
      referenceEdits: [
        {
          path: 'Knowledge/Referrer.md',
          expected_etag: sha256(managedRaw),
          raw: managedEditRaw,
          managed: { id: managedId, revision_id: refRevision, parents: [] }
        },
        { path: 'Knowledge/Plain.md', expected_etag: sha256(plainRaw), raw: '# Plain\n\nintermediate\n' },
        { path: 'Knowledge/Plain.md', expected_etag: sha256('# Plain\n\nintermediate\n'), raw: plainEditRaw }
      ]
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const receipt = (await ground.coordinator.run(
      resolveIntent(key, id, expected),
      resolvePlan(spec)
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    void receipt;

    const referrer = await ground.store.readPath('Knowledge/Referrer.md');
    expect(referrer.raw).toContain('Knowledge/A');
    expect(await ground.revisions.hasRevision(managedId, refRevision)).toBe(true);
    expect(await ground.revisions.readRevision(managedId, refRevision)).toMatchObject({
      revision_id: refRevision
    });

    const plain = await ground.store.readPath('Knowledge/Plain.md');
    expect(plain.raw).toContain('Knowledge/A');
    expect(plain.id).toBeUndefined();
    await expect(
      ground.revisions.verifyPreimage(receipt.operation_id, sha256(plainRaw))
    ).resolves.toBeUndefined();
  } finally {
    await ground.dispose();
  }
});

test('a reference edit targeting a removed head is rejected before any change', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID(),
      referenceEdits: [
        { path: 'Knowledge/B.md', expected_etag: b.hash, raw: managed(id, 'edited') }
      ]
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toContain('branch A');
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toContain('branch B');
  } finally {
    await ground.dispose();
  }
});

test('a stale reference edit fails closed before any current file changes', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    await writeFile(join(ground.vaultRoot, 'Knowledge/Plain.md'), '# Plain\n\nbody\n');
    await ground.refresh();
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID(),
      referenceEdits: [
        {
          path: 'Knowledge/Plain.md',
          expected_etag: 'f'.repeat(64),
          raw: '# Plain\n\nchanged\n'
        }
      ]
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ground.store.readPath('Knowledge/A.md').then((r) => r.raw)).toContain('branch A');
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toContain('branch B');
    expect((await ground.store.readPath('Knowledge/Plain.md')).raw).toBe('# Plain\n\nbody\n');
  } finally {
    await ground.dispose();
  }
});

test('resolution read set must bind each head revision to its own path and cannot borrow another path etag', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID() };
    const key = randomUUID();
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), async (identity, observed) => {
      const planned = await resolvePlan(spec)(identity, observed) as Extract<LocalPlannedOperation, { kind: 'note' }>;
      return { ...planned, read_set: planned.read_set.map((condition) => condition.kind === 'path' && condition.path === 'Knowledge/B.md'
        ? { ...condition, expected: { kind: 'present' as const, id, etag: b.hash, revision_id: a.revisionId } }
        : condition) as unknown as LocalReadSet };
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(a.raw);
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('a backlink changed between history persistence and installation leaves every current byte intact', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const path = 'Knowledge/Plain.md';
    const original = '# Plain\n\nold\n';
    const human = '# Plain\n\nhuman edit\n';
    await writeFile(join(ground.vaultRoot, path), original);
    await ground.refresh();
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state, faults: {
      consolidation: { afterHistory: async () => { await writeFile(join(ground.vaultRoot, path), human); } }
    } });
    ground.coordinator = makeCoordinator(ground);
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    await expect(ground.coordinator.run(resolveIntent(randomUUID(), id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID(),
      referenceEdits: [{ path, expected_etag: sha256(original), raw: '# Plain\n\nrewritten\n' }]
    }))).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|RECOVERY_REQUIRED/) });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(a.raw);
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
    expect((await ground.store.readPath(path)).raw).toBe(human);
  } finally { await ground.dispose(); }
});

test('a completed backlink changed while a removal remains staged blocks completion without losing detached bytes', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const path = 'Knowledge/Plain.md';
    const original = '# Plain\n\nold\n';
    const rewritten = '# Plain\n\nrewritten\n';
    const human = '# Plain\n\nhuman edit\n';
    await writeFile(join(ground.vaultRoot, path), original);
    await ground.refresh();
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state, faults: {
      consolidation: { afterRemovalStage: async () => { await writeFile(join(ground.vaultRoot, path), human); throw new Error('interrupted'); } }
    } });
    ground.coordinator = makeCoordinator(ground);
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    const key = randomUUID();
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID(),
      referenceEdits: [{ path, expected_etag: sha256(original), raw: rewritten }]
    }))).rejects.toBeDefined();
    const stages = (await readdir(join(ground.vaultRoot, 'Knowledge'))).filter((entry) => entry.startsWith('.consolidate-stage-'));
    expect(stages).toHaveLength(1);
    expect(await readFile(join(ground.vaultRoot, 'Knowledge', stages[0], 'absorbed'), 'utf8')).toBe(b.raw);
    await ground.reopenStore();
    const report = await ground.coordinator.recover();
    expect(report.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect(ground.operations.findByKey(key)?.receipt_json).toBeNull();
    expect((await ground.store.readPath(path)).raw).toBe(human);
    expect(await readFile(join(ground.vaultRoot, 'Knowledge', stages[0], 'absorbed'), 'utf8')).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('a backlink changed at the document-completion boundary never produces a successful receipt', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const path = 'Knowledge/Plain.md';
    const original = '# Plain\n\nold\n';
    const human = '# Plain\n\nhuman after final verification\n';
    await writeFile(join(ground.vaultRoot, path), original);
    await ground.refresh();
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state, faults: {
      consolidation: { afterDocumentComplete: async () => { await writeFile(join(ground.vaultRoot, path), human); } }
    } });
    ground.coordinator = makeCoordinator(ground);
    const key = randomUUID();
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID(),
      referenceEdits: [{ path, expected_etag: sha256(original), raw: '# Plain\n\nrewritten\n' }]
    }))).rejects.toBeDefined();
    await ground.reopenStore();
    const report = await ground.coordinator.recover();
    expect(report.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect(ground.operations.findByKey(key)?.receipt_json).toBeNull();
    expect((await ground.store.readPath(path)).raw).toBe(human);
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('an unexpected survivor change after installation is reported as recovery work', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID()
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    let armed = true;
    await ground.store.close();
    ground.store = await openDocumentStore({
      vault: ground.vaultRoot,
      state: ground.sandbox.state,
      faults: {
        consolidation: {
          afterSurvivor: async () => {
            if (!armed) return;
            armed = false;
            await writeFile(join(ground.vaultRoot, 'Knowledge/A.md'), managed(id, 'human edit'));
          }
        }
      }
    });
    ground.coordinator = makeCoordinator(ground);
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toContain('human edit');
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toContain('branch B');
    await ground.reopenStore();
    const recovery = await ground.coordinator.recover();
    expect(recovery.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(managed(id, 'human edit'));
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
  } finally {
    await ground.dispose();
  }
});

test('a human-edited absorbed head after survivor installation survives restart and blocks completion', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const human = managed(id, 'human changed absorbed head');
    const key = randomUUID();
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state, faults: {
      consolidation: { afterSurvivor: async () => { await writeFile(join(ground.vaultRoot, 'Knowledge/B.md'), human); } }
    } });
    ground.coordinator = makeCoordinator(ground);
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID()
    }))).rejects.toBeDefined();
    await ground.reopenStore();
    const report = await ground.coordinator.recover();
    expect(report.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect(ground.operations.findByKey(key)?.receipt_json).toBeNull();
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(human);
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(managed(id, 'resolved'));
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('an incomplete consolidation excludes its intermediate survivor path from another local mutation', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state, faults: {
      consolidation: { afterSurvivor: () => { throw new Error('interrupted after survivor'); } }
    } });
    ground.coordinator = makeCoordinator(ground);
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID()
    }))).rejects.toBeDefined();
    const intermediate = (await ground.store.readPath('Knowledge/A.md')).raw;
    expect(intermediate).toBe(managed(id, 'resolved'));
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
    const competingKey = randomUUID();
    const competing: LocalOperationIntent = {
      tool: 'brain_capture', action: 'capture', project_id: null, idempotency_key: competingKey,
      payload: { idempotency_key: competingKey, note: { title: 'competing', tags: [],
        content: { kind: 'note', summary: 'competing', body_markdown: '# competing' }, evidence: [], related_ids: [] } },
      preconditions: {}
    };
    await expect(ground.coordinator.run(competing, (identity) => {
      if (identity.kind !== 'note') throw new Error('missing identity');
      return { kind: 'note', heads: [], parents: [], read_set: [
        { kind: 'path', path: 'Knowledge/A.md', expected: { kind: 'present', etag: sha256(intermediate), id } }
      ], effects: [{ kind: 'write', write: { path: 'Knowledge/A.md', id,
        revision_id: identity.revision_id, raw: managed(id, 'competing'), parents: [] } }] };
    })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(intermediate);
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('a recreated absorbed path keeps the operation recovery-blocking', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID()
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    let armed = true;
    await ground.store.close();
    ground.store = await openDocumentStore({
      vault: ground.vaultRoot,
      state: ground.sandbox.state,
      faults: {
        consolidation: {
          afterRemovalProgress: async () => {
            if (!armed) return;
            armed = false;
            await writeFile(join(ground.vaultRoot, 'Knowledge/B.md'), managed(id, 'branch B'));
          }
        }
      }
    });
    ground.coordinator = makeCoordinator(ground);
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toContain('branch B');
    await ground.reopenStore();
    const report = await ground.coordinator.recover();
    expect(report.finalized).toBe(0);
    expect(report.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toContain('branch B');
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally {
    await ground.dispose();
  }
});

test('a symlink substituted at the absorbed path discards no bytes', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = {
      id,
      survivorPath: 'Knowledge/A.md',
      survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'),
      resolutionRevision: randomUUID()
    };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    let armed = true;
    const protectedRaw = '# protected target\n\nuntouched\n';
    await writeFile(join(ground.vaultRoot, 'Knowledge/Protected.md'), protectedRaw);
    await ground.store.close();
    ground.store = await openDocumentStore({
      vault: ground.vaultRoot,
      state: ground.sandbox.state,
      faults: {
        consolidation: {
          beforeRemovalStage: async () => {
            if (!armed) return;
            armed = false;
            await unlink(join(ground.vaultRoot, 'Knowledge/B.md'));
            await symlink('Protected.md', join(ground.vaultRoot, 'Knowledge/B.md'));
          }
        }
      }
    });
    ground.coordinator = makeCoordinator(ground);
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|RECOVERY_REQUIRED|CONFLICT/) });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toContain('resolved');
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/Protected.md'), 'utf8')).toBe(protectedRaw);
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
    await ground.reopenStore();
    const report = await ground.coordinator.recover();
    expect(report.finalized).toBe(0);
    expect(report.blocking_operations).toContain(ground.operations.findByKey(key)?.operation_id);
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/Protected.md'), 'utf8')).toBe(protectedRaw);
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally {
    await ground.dispose();
  }
});

test('a third identity arriving after installation prevents a consolidation receipt', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID() };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const third = managed(id, 'unexpected third');
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state,
      faults: { consolidation: { afterRemovalProgress: async () => {
        await writeFile(join(ground.vaultRoot, 'Knowledge/Third.md'), third);
      } } } });
    ground.coordinator = makeCoordinator(ground);
    await expect(ground.coordinator.run(resolveIntent(key, id, heads.map((head) => ({
      revision_id: head.revision_id, etag: head.etag }))), resolvePlan(spec)))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(ground.store.getConsolidationReceipt(`${key}:consolidate`)).toBeUndefined();
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/Third.md'), 'utf8')).toBe(third);
  } finally { await ground.dispose(); }
});

test('unrelated attachments do not block the final Markdown identity scan', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const attachment = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x42]);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xfe]);
    await mkdir(join(ground.vaultRoot, 'Knowledge/assets'), { recursive: true });
    await writeFile(join(ground.vaultRoot, 'Knowledge/assets/reference.pdf'), attachment);
    await writeFile(join(ground.vaultRoot, 'Knowledge/assets/image.png'), image);
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved beside attachments'), resolutionRevision: randomUUID() };
    const expected = (await ground.coordinator.enumerateConflictHeads(id))
      .map(({ revision_id, etag }) => ({ revision_id, etag }));
    const receipt = await ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec));
    expect(receipt).toMatchObject({ kind: 'note', id, revision_id: spec.resolutionRevision });
    expect(ground.store.getConsolidationReceipt(`${key}:consolidate`)).toMatchObject({
      id, revision_id: spec.resolutionRevision
    });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(spec.resolutionRaw);
    await expect(ground.store.readPath('Knowledge/B.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/assets/reference.pdf'))).toEqual(attachment);
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/assets/image.png'))).toEqual(image);
  } finally { await ground.dispose(); }
});

test('a crash after staged-copy disposal resumes from durable disposition', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID() };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state,
      faults: { consolidation: { afterRemovalDispose: () => { throw new Error('crash after disposal'); } } } });
    ground.coordinator = makeCoordinator(ground);
    await expect(ground.coordinator.run(resolveIntent(key, id, heads.map((head) => ({
      revision_id: head.revision_id, etag: head.etag }))), resolvePlan(spec))).rejects.toBeDefined();
    await ground.reopenStore();
    expect((await ground.coordinator.recover()).finalized).toBe(1);
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(spec.resolutionRaw);
    await expect(ground.store.readPath('Knowledge/B.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test('a persisted legacy consolidation key array rebinds only its original batch', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID() };
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    const receipt = await ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec));
    ground.operations.deleteSubordinates(receipt.operation_id);
    ground.operations.update(receipt.operation_id, { state: 'pending', receipt_json: null,
      storage_key: JSON.stringify([`${key}:doc:0`, `${key}:doc:1`,
        `${key}:consolidate:primary`, `${key}:consolidate:manifest`]),
      updated_at: new Date().toISOString() });
    await ground.reopenStore();
    expect(await ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))).toEqual(receipt);
    expect(ground.operations.listSubordinates(receipt.operation_id)).toMatchObject([
      { key: `${key}:consolidate`, document_operation_id: expect.any(String) }
    ]);
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
  } finally { await ground.dispose(); }
});

test.each([
  { linkage: 'verified', valid: true },
  { linkage: 'foreign', valid: false }
])('persisted old per-effect subordinate rows with $linkage linkage only rebind when unambiguous', async ({ valid }) => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const referringRaw = '# Reference\n\nold link\n';
    const rewrittenRaw = '# Reference\n\nnew link\n';
    await writeFile(join(ground.vaultRoot, 'Knowledge/Reference.md'), referringRaw);
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID(),
      referenceEdits: [{ path: 'Knowledge/Reference.md', expected_etag: sha256(referringRaw), raw: rewrittenRaw }] };
    const expected = (await ground.coordinator.enumerateConflictHeads(id))
      .map(({ revision_id, etag }) => ({ revision_id, etag }));
    const intent = resolveIntent(key, id, expected);
    const receipt = await ground.coordinator.run(intent, resolvePlan(spec));
    const batchId = ground.store.getConsolidationReceipt(`${key}:consolidate`)?.operation_id;
    expect(batchId).toEqual(expect.any(String));
    ground.operations.deleteSubordinates(receipt.operation_id);
    const now = new Date().toISOString();
    for (const [effect_index, kind, subordinateKey] of [
      [0, 'write', `${key}:doc:0`],
      [1, 'remove', `${key}:remove:1`],
      [2, 'consolidation', `${key}:consolidate`],
      [3, 'reference_edit', `${key}:ref:0`]
    ] as const) {
      ground.operations.reserveSubordinate({ operation_id: receipt.operation_id, effect_index,
        kind, key: subordinateKey, created_at: now, updated_at: now });
    }
    const oldLink = valid ? batchId! : randomUUID();
    ground.operations.setSubordinateDocumentOperation(receipt.operation_id, 0, oldLink);
    ground.operations.update(receipt.operation_id, { state: 'pending', receipt_json: null,
      storage_key: JSON.stringify([`${key}:doc:0`, `${key}:doc:1`,
        `${key}:consolidate:primary`, `${key}:consolidate:manifest`, `${key}:ref:0`]), updated_at: now });
    expect(ground.operations.listSubordinates(receipt.operation_id).map((row) => row.effect_index))
      .toEqual([0, 1, 2, 3]);
    expect(ground.store.getDocumentReceipt(`${key}:doc:0`)).toBeUndefined();
    expect(ground.store.getMoveReceipt(`${key}:doc:0`)).toBeUndefined();
    expect(ground.store.getDocumentReceipt(`${key}:consolidate`)).toBeUndefined();
    expect(ground.store.getMoveReceipt(`${key}:consolidate`)).toBeUndefined();
    expect(ground.operations.listSubordinates(receipt.operation_id).map((row) =>
      [row.kind, row.key, row.document_operation_id])).toEqual([
      ['write', `${key}:doc:0`, oldLink],
      ['remove', `${key}:remove:1`, null],
      ['consolidation', `${key}:consolidate`, null],
      ['reference_edit', `${key}:ref:0`, null]
    ]);
    await ground.reopenStore();
    if (!valid) {
      await expect(ground.coordinator.run(intent, resolvePlan(spec)))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(ground.operations.listSubordinates(receipt.operation_id).map((row) => row.key)).toEqual([
        `${key}:doc:0`, `${key}:remove:1`, `${key}:consolidate`, `${key}:ref:0`
      ]);
      expect(ground.operations.findByKey(key)?.receipt_json).toBeNull();
      expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(spec.resolutionRaw);
      return;
    }
    expect(await ground.coordinator.run(intent, resolvePlan(spec))).toEqual(receipt);
    expect(ground.operations.listSubordinates(receipt.operation_id)).toMatchObject([
      { effect_index: 0, kind: 'consolidation', key: `${key}:consolidate`,
        document_operation_id: batchId, state: 'complete' }
    ]);
    expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(spec.resolutionRaw);
    expect((await ground.store.readPath('Knowledge/Reference.md')).raw).toBe(rewrittenRaw);
  } finally { await ground.dispose(); }
});

test.each([
  { stale: false, documentActivity: false, completedRow: false, scenario: 'reserved rows', outcome: 'finalized' },
  { stale: true, documentActivity: false, completedRow: false, scenario: 'changed head', outcome: 'conflicted' },
  { stale: false, documentActivity: true, completedRow: false, scenario: 'document activity', outcome: 'recovery_required' },
  { stale: false, documentActivity: false, completedRow: true, scenario: 'completed row', outcome: 'recovery_required' }
])('a pre-manifest legacy consolidation with $scenario is $outcome', async ({ stale, documentActivity, completedRow }) => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const revisionId = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'planned resolution'), resolutionRevision: revisionId };
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const now = new Date().toISOString();
    const operation = ground.operations.reserve({ operation_id: randomUUID(), idempotency_key: key,
      tool: 'brain_review', action: 'resolve', project_id: null, payload_hash: 'a'.repeat(64),
      payload_json: '{}', created_at: now, updated_at: now }).record;
    const plan = await resolvePlan(spec)({ kind: 'note', operation_id: operation.operation_id,
      timestamp: now, storage_operation_ids: [], note_id: id, revision_id: revisionId,
      path: spec.survivorPath }, { sources: [], heads });
    ground.operations.update(operation.operation_id, { plan_json: JSON.stringify(plan),
      storage_key: JSON.stringify([`${key}:doc:0`, `${key}:doc:1`,
        `${key}:consolidate:primary`, `${key}:consolidate:manifest`]),
      progress_json: JSON.stringify({ preconditions_validated: true }), updated_at: now });
    for (const [effect_index, kind, subordinateKey] of [
      [0, 'write', `${key}:doc:0`],
      [1, 'remove', `${key}:remove:1`],
      [2, 'consolidation', `${key}:consolidate`]
    ] as const) {
      ground.operations.reserveSubordinate({ operation_id: operation.operation_id, effect_index,
        kind, key: subordinateKey, created_at: now, updated_at: now });
    }
    if (completedRow) ground.operations.markSubordinate(operation.operation_id, 0, 'complete');
    expect(ground.store.hasConsolidationManifest(`${key}:consolidate`)).toBe(false);
    if (documentActivity) {
      const documentJournal = LocalWriteJournal.open(join(ground.sandbox.state, 'documents.sqlite'));
      try {
        documentJournal.reserve({ operation_id: randomUUID(), idempotency_key: `${key}:consolidate:primary`,
          tool: 'brain_review', path: 'Knowledge/A.md', payload_hash: 'b'.repeat(64),
          source: 'brain_review', expected_etag: a.hash, id, revision_id: revisionId,
          preimage_hash: null, revision_hash: null, updated_at: now });
      } finally { documentJournal.close(); }
    }
    const changed = managed(id, 'external head edit');
    if (stale) await writeFile(join(ground.vaultRoot, 'Knowledge/B.md'), changed);
    await ground.reopenStore();
    expect(ground.store.hasConsolidationManifest(`${key}:consolidate`)).toBe(false);
    const result = await ground.coordinator.recover();
    if (documentActivity || completedRow) {
      expect(result.finalized).toBe(0);
      expect(result.conflicted).toBe(0);
      expect(result.blocking_operations).toContain(operation.operation_id);
      expect(ground.operations.findByKey(key)).toMatchObject({ state: 'recovery_required', receipt_json: null });
      expect(ground.store.hasConsolidationManifest(`${key}:consolidate`)).toBe(false);
      expect(ground.operations.listSubordinates(operation.operation_id).map((row) => row.key)).toEqual([
        `${key}:doc:0`, `${key}:remove:1`, `${key}:consolidate`
      ]);
      expect(ground.operations.listSubordinates(operation.operation_id).map((row) => row.state)).toEqual([
        completedRow ? 'complete' : 'reserved', 'reserved', 'reserved'
      ]);
      expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(a.raw);
      expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(b.raw);
      return;
    }
    if (stale) {
      expect(result.conflicted).toBe(1);
      expect(result.finalized).toBe(0);
      expect(result.blocking_operations).toEqual([]);
      expect(ground.operations.findByKey(key)).toMatchObject({ state: 'conflicted', receipt_json: null });
      expect(ground.store.hasConsolidationManifest(`${key}:consolidate`)).toBe(false);
      expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(a.raw);
      expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(changed);
      expect(ground.operations.listSubordinates(operation.operation_id).map((row) => row.key)).toEqual([
        `${key}:consolidate`
      ]);
    } else {
      expect(result.finalized).toBe(1);
      expect(result.conflicted).toBe(0);
      expect(result.blocking_operations).toEqual([]);
      expect(ground.operations.findByKey(key)?.state).toBe('finalized');
      expect(ground.coordinator.status(operation.operation_id)?.receipt).toMatchObject({
        id, revision_id: revisionId, path: spec.survivorPath
      });
      expect(ground.store.hasConsolidationManifest(`${key}:consolidate`)).toBe(true);
      expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(spec.resolutionRaw);
      await expect(ground.store.readPath('Knowledge/B.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
      expect(ground.operations.listSubordinates(operation.operation_id)).toMatchObject([
        { effect_index: 0, kind: 'consolidation', key: `${key}:consolidate`, state: 'complete' }
      ]);
    }
  } finally { await ground.dispose(); }
});

test('a legacy consolidation key colliding with another document operation cannot be rebound', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  try {
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID() };
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    const receipt = await ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec));
    const otherId = randomUUID();
    await ground.store.put({ path: 'Knowledge/Unrelated.md', raw: managed(otherId, 'other'),
      expectedEtag: null, idempotencyKey: `${key}:doc:0`, source: 'test' });
    ground.operations.deleteSubordinates(receipt.operation_id);
    ground.operations.update(receipt.operation_id, { state: 'pending', receipt_json: null,
      storage_key: JSON.stringify([`${key}:doc:0`, `${key}:doc:1`,
        `${key}:consolidate:primary`, `${key}:consolidate:manifest`]),
      updated_at: new Date().toISOString() });
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec)))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(ground.operations.listSubordinates(receipt.operation_id)).toEqual([]);
    expect((await ground.store.readPath('Knowledge/Unrelated.md')).id).toBe(otherId);
  } finally { await ground.dispose(); }
});

test('V2 recall excludes a matching intermediate survivor while consolidation is incomplete', async () => {
  const { ground, id, a, b } = await twoHeadGround();
  const index = openSearchIndex(':memory:');
  try {
    const key = randomUUID();
    const spec: ResolveSpec = { id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'intermediate marker'), resolutionRevision: randomUUID() };
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    await ground.store.close();
    ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.sandbox.state,
      faults: { consolidation: { afterRemovalProgress: () => { throw new Error('stop at staged removal'); } } } });
    ground.coordinator = makeCoordinator(ground);
    await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))).rejects.toBeDefined();
    index.upsert({ path: 'Knowledge/A.md', id, revision_id: spec.resolutionRevision,
      raw: spec.resolutionRaw, etag: sha256(spec.resolutionRaw) });
    expect(index.candidates({ query: 'intermediate', limit: 10, statuses: ['candidate'] })
      .some((hit) => hit.path === 'Knowledge/A.md')).toBe(true);
    await ground.refresh();
    expect(ground.catalogue.getByPath('Knowledge/A.md')?.hash).toBe(sha256(spec.resolutionRaw));
    const brain = { config: { scopes: [] }, clock, ids, documents: ground.store,
      catalogue: ground.catalogue, index, journal: { listProjects: () => [] }, vault: new FileVault(ground.vaultRoot, []),
      vaultRoot: ground.vaultRoot } as unknown as LocalBrain;
    const found = await recallLocal(reviewerContext, { query: 'intermediate', include_candidates: true }, await buildLocalHandlerDeps(brain));
    expect(found.items).toEqual([]);
  } finally { index.close(); await ground.dispose(); }
});

test('a three-head fork consolidates with all parents and history retained', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    const root = await seedRevisionOnly(ground, id, managed(id, 'root'));
    await ground.revisions.persistRevisionMetadata({
      id,
      revision_id: root.revisionId,
      parents: [],
      created_at: new Date().toISOString()
    });
    const parent = [{ revision_id: root.revisionId, raw_hash: root.hash }];
    const a = await writeManaged(ground, id, 'Knowledge/A.md', managed(id, 'a'), parent);
    const b = await writeManaged(ground, id, 'Knowledge/B.md', managed(id, 'b'), parent);
    const c = await writeManaged(ground, id, 'Knowledge/C.md', managed(id, 'c'), parent);
    await ground.refresh();
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const key = randomUUID();
    const newRevision = randomUUID();
    const receipt = (await ground.coordinator.run(
      resolveIntent(key, id, expected),
      resolvePlan({
        id,
        survivorPath: 'Knowledge/A.md',
        survivorEtag: a.hash,
        removalPaths: [
          { path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash },
          { path: 'Knowledge/C.md', id, revisionId: c.revisionId, etag: c.hash }
        ],
        resolutionRaw: managed(id, 'resolved'),
        resolutionRevision: newRevision
      })
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    expect(receipt.revision_id).toBe(newRevision);
    await expect(ground.store.readPath('Knowledge/B.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ground.store.readPath('Knowledge/C.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const seeded of [a, b, c]) {
      expect((await ground.revisions.readRevision(id, seeded.revisionId)).raw).toBe(seeded.raw);
    }
    const metadata = await ground.revisions.readRevisionMetadata(id, newRevision);
    expect(metadata.parents.map((entry) => entry.revision_id).sort()).toEqual(
      [a.revisionId, b.revisionId, c.revisionId].sort()
    );
    await ground.refresh();
    expect(ground.catalogue.getById(id)?.revision_id).toBe(newRevision);
  } finally {
    await ground.dispose();
  }
});

test('fault injection at persisted boundaries yields documented recovery without discarding bytes', { timeout: 120000 }, async () => {
  const boundaries: (keyof NonNullable<DocumentStoreFaults['consolidation']>)[] = [
    'afterManifest',
    'afterHistory',
    'beforeSurvivor',
    'afterSurvivor',
    'beforeReferenceEdit',
    'afterReferenceEdit',
    'beforeRemovalStage',
    'afterRemovalStage',
    'afterRemovalProgress',
    'afterDocumentComplete',
    'beforeReceipt'
  ];
  for (const boundary of boundaries) {
    const { ground, id, a, b } = await twoHeadGround();
    try {
      const plainRaw = '# Note\n\nreferrer\n';
      await writeFile(join(ground.vaultRoot, 'Knowledge/Note.md'), plainRaw);
      await ground.refresh();
      const key = randomUUID();
      const spec: ResolveSpec = {
        id,
        survivorPath: 'Knowledge/A.md',
        survivorEtag: a.hash,
        removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
        resolutionRaw: managed(id, 'resolved'),
        resolutionRevision: randomUUID(),
        referenceEdits: [
          {
            path: 'Knowledge/Note.md',
            expected_etag: sha256(plainRaw),
            raw: '# Note\n\nrewritten\n'
          }
        ]
      };
      const heads = await ground.coordinator.enumerateConflictHeads(id);
      const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
      let armed = true;
      await ground.store.close();
      ground.store = await openDocumentStore({
        vault: ground.vaultRoot,
        state: ground.sandbox.state,
        faults: {
          consolidation: {
            [boundary]: () => {
              if (!armed) return;
              armed = false;
              throw new Error(`fault at ${boundary}`);
            }
          } as NonNullable<DocumentStoreFaults['consolidation']>
        }
      });
      ground.coordinator = makeCoordinator(ground);
       await expect(ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))).rejects.toBeDefined();

       await ground.reopenStore();
       const report = await ground.coordinator.recover();
       expect(report.finalized, boundary).toBe(1);
       expect(report.blocking_operations).toEqual([]);
       expect(ground.operations.findByKey(key)?.state).toBe('finalized');

       expect((await ground.revisions.readRevision(id, a.revisionId)).raw).toBe(a.raw);
       expect((await ground.revisions.readRevision(id, b.revisionId)).raw).toBe(b.raw);
       const aRaw = (await ground.store.readPath('Knowledge/A.md')).raw;
       expect(aRaw).toBe(spec.resolutionRaw);
       await expect(ground.store.readPath('Knowledge/B.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
       expect((await ground.store.readPath('Knowledge/Note.md')).raw).toBe('# Note\n\nrewritten\n');
       expect((await readdir(join(ground.vaultRoot, 'Knowledge'))).filter((entry) => entry.startsWith('.consolidate-stage-'))).toEqual([]);
    } finally {
      await ground.dispose();
    }
  }
});

test('an index failure at consolidation still yields durable success and a rebuildable index', async () => {
  const failing: DocumentIndex = {
    upsert: () => {
      throw new Error('index unavailable');
    },
    remove: () => undefined
  };
  const ground = await openGround(undefined, failing);
  try {
    const id = randomUUID();
    const root = await seedRevisionOnly(ground, id, managed(id, 'root'));
    await ground.revisions.persistRevisionMetadata({
      id,
      revision_id: root.revisionId,
      parents: [],
      created_at: new Date().toISOString()
    });
    const parent = [{ revision_id: root.revisionId, raw_hash: root.hash }];
    const a = await writeManaged(ground, id, 'Knowledge/A.md', managed(id, 'a'), parent);
    const b = await writeManaged(ground, id, 'Knowledge/B.md', managed(id, 'b'), parent);
    await ground.refresh();
    const heads = await ground.coordinator.enumerateConflictHeads(id);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const key = randomUUID();
    const newRevision = randomUUID();
    const receipt = (await ground.coordinator.run(
      resolveIntent(key, id, expected),
      resolvePlan({
        id,
        survivorPath: 'Knowledge/A.md',
        survivorEtag: a.hash,
        removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
        resolutionRaw: managed(id, 'resolved'),
        resolutionRevision: newRevision
      })
    )) as Extract<LocalOperationReceipt, { kind: 'note' }>;
    expect(receipt.indexed).toBe(false);

    const index = openSearchIndex(':memory:');
    try {
      await reconcileCurrentVault({ vault: new FileVault(ground.vaultRoot, []), catalogue: ground.catalogue });
      const { indexReconciledDocuments } = await import('../../src/notes/reconcile.js');
      const report = await reconcileCurrentVault({
        vault: new FileVault(ground.vaultRoot, []),
        catalogue: ground.catalogue
      });
      indexReconciledDocuments({ catalogue: ground.catalogue, index, report });
      const paths = index.paths();
      expect(paths).toContain('Knowledge/A.md');
      expect(paths).not.toContain('Knowledge/B.md');
      const hits = index.candidates({ query: 'resolved', limit: 10 });
      expect(hits.some((hit) => hit.path === 'Knowledge/A.md')).toBe(true);
    } finally {
      index.close();
    }
  } finally {
    await ground.dispose();
  }
});

test('failed removal from an existing index remains pending until durable retry removes the absorbed source', async () => {
  const index = openSearchIndex(':memory:');
  let failRemoval = true;
  const adapter: DocumentIndex = {
    upsert: (entry) => index.upsert(entry),
    remove: (path) => { if (failRemoval) throw new Error('removal unavailable'); index.remove(path); }
  };
  const ground = await openGround(undefined, adapter);
  try {
    const id = randomUUID();
    const root = await seedRevisionOnly(ground, id, managed(id, 'root'));
    await ground.revisions.persistRevisionMetadata({ id, revision_id: root.revisionId, parents: [], created_at: new Date().toISOString() });
    const parents = [{ revision_id: root.revisionId, raw_hash: root.hash }];
    const a = await writeManaged(ground, id, 'Knowledge/A.md', managed(id, 'a'), parents);
    const b = await writeManaged(ground, id, 'Knowledge/B.md', managed(id, 'b'), parents);
    index.upsert({ path: 'Knowledge/B.md', raw: b.raw, etag: b.hash, id, revision_id: b.revisionId });
    expect(index.paths()).toContain('Knowledge/B.md');
    expect(index.candidates({ query: 'b', limit: 10, statuses: ['candidate'] })
      .some((hit) => hit.path === 'Knowledge/B.md')).toBe(true);
    await ground.refresh();
    const expected = (await ground.coordinator.enumerateConflictHeads(id)).map(({ revision_id, etag }) => ({ revision_id, etag }));
    const receipt = await ground.coordinator.run(resolveIntent(randomUUID(), id, expected), resolvePlan({
      id, survivorPath: 'Knowledge/A.md', survivorEtag: a.hash,
      removalPaths: [{ path: 'Knowledge/B.md', id, revisionId: b.revisionId, etag: b.hash }],
      resolutionRaw: managed(id, 'resolved'), resolutionRevision: randomUUID()
    }));
    expect(receipt).toMatchObject({ kind: 'note', indexed: false });
    index.upsert({ path: 'Knowledge/B.md', raw: b.raw, etag: b.hash, id, revision_id: b.revisionId });
    expect(index.paths()).toContain('Knowledge/B.md');
    expect(ground.store.recallExclusions().paths.has('Knowledge/B.md')).toBe(true);
    const replacementId = randomUUID();
    const reusedRaw = managed(replacementId, 'reused removal retry marker');
    await writeFile(join(ground.vaultRoot, 'Knowledge/B.md'), reusedRaw);
    await ground.refresh();
    const source = ground.catalogue.getByPath('Knowledge/B.md');
    expect(source).toMatchObject({ id: replacementId, hash: sha256(reusedRaw) });
    index.upsert({ path: 'Knowledge/B.md', raw: reusedRaw, etag: sha256(reusedRaw),
      id: replacementId, revision_id: source!.revision_id! });
    const matchingHit = index.candidates({ query: 'reused removal retry marker',
      limit: 10, statuses: ['candidate'] }).find((hit) => hit.path === 'Knowledge/B.md');
    expect(matchingHit).toMatchObject({ id: replacementId, source_hash: source!.hash });
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(reusedRaw);
    const brain = { config: { scopes: [] }, clock, ids, documents: ground.store,
      catalogue: ground.catalogue, index, journal: { listProjects: () => [] },
      vault: new FileVault(ground.vaultRoot, []), vaultRoot: ground.vaultRoot } as unknown as LocalBrain;
    const pendingRecall = await recallLocal(reviewerContext,
      { query: 'reused removal retry marker', include_candidates: true }, await buildLocalHandlerDeps(brain));
    expect(pendingRecall.items.some((item) => item.relative_path === 'Knowledge/B.md')).toBe(false);
    expect(ground.catalogue.getByPath('Knowledge/B.md')?.hash).toBe(matchingHit!.source_hash);
    expect((await ground.store.readPath('Knowledge/B.md')).raw).toBe(reusedRaw);
    expect((await ground.store.recover()).pending).toContain('Knowledge/B.md');
    expect(await readFile(join(ground.vaultRoot, 'Knowledge/B.md'), 'utf8')).toBe(reusedRaw);
    await unlink(join(ground.vaultRoot, 'Knowledge/B.md'));
    const unresolved = await ground.store.recover();
    expect(unresolved.pending).toContain('Knowledge/B.md');
    failRemoval = false;
    const recovered = await ground.store.recover();
    expect(recovered.recovered).toContain('Knowledge/B.md');
    expect(index.paths()).not.toContain('Knowledge/B.md');
    expect(index.candidates({ query: 'branch', limit: 10 }).some((hit) => hit.path === 'Knowledge/B.md')).toBe(false);
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toBe(managed(id, 'resolved'));
  } finally { await ground.dispose(); index.close(); }
});

test('subordinate operation records are persisted, linked, and stable across a two-coordinator race', async () => {
  const sandbox = await vaultSandbox();
  try {
    const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
    const operationsB = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
    const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
    const vault = new FileVault(sandbox.vault, []);
    const revisions = await openRevisionStore(sandbox.state);
    const catalogue = CurrentCatalogue.open({ revisions, ids });
    await reconcileCurrentVault({ vault, catalogue });
    const coordinatorA = new LocalMutationCoordinator({
      operations,
      documents: store,
      catalogue,
      vaultRoot: sandbox.vault,
      clock,
      ids,
      revisions
    });
    const coordinatorB = new LocalMutationCoordinator({
      operations: operationsB,
      documents: store,
      catalogue,
      vaultRoot: sandbox.vault,
      clock,
      ids,
      revisions
    });
    const key = randomUUID();
    const intent: LocalOperationIntent = {
      tool: 'brain_capture',
      action: 'capture',
      project_id: null,
      idempotency_key: key,
      payload: {
        idempotency_key: key,
        note: {
          title: 'Race note',
          tags: [],
          content: { kind: 'note', summary: 'race', body_markdown: '# race\n' },
          evidence: [],
          related_ids: []
        }
      },
      preconditions: {}
    };
    const plan: LocalOperationPlan = (identity) => {
      if (identity.kind !== 'note') throw new Error('note identity required');
      return {
        kind: 'note',
        heads: [],
        parents: [],
        read_set: [{ kind: 'path', path: 'Inbox/Race.md', expected: { kind: 'absent' } }],
        effects: [
          {
            kind: 'write',
            write: {
              path: 'Inbox/Race.md',
              raw: managed(identity.note_id, 'race'),
              id: identity.note_id,
              revision_id: identity.revision_id,
              parents: []
            }
          }
        ]
      };
    };
    const first = await coordinatorA.run(intent, plan);
    const second = await coordinatorB.run(intent, plan);
    expect(first.operation_id).toBe(second.operation_id);
    expect(first).toEqual(second);

    const rows = operations.listSubordinates(first.operation_id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === 'complete')).toBe(true);
    expect(operationsB.listSubordinates(first.operation_id).map((row) => row.key)).toEqual(
      rows.map((row) => row.key)
    );
    await store.close();
    operations.close();
    operationsB.close();
  } finally {
    await sandbox.dispose();
  }
});

test('transactional reservation collision does not consume a second operation identity', async () => {
  const sandbox = await vaultSandbox();
  const first = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const second = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  try {
    let allocations = 0;
    const key = randomUUID();
    const now = new Date().toISOString();
    const input = { idempotency_key: key, tool: 'brain_capture', action: 'capture',
      project_id: null, payload_hash: 'a'.repeat(64), payload_json: '{}', created_at: now, updated_at: now };
    const allocate = () => { allocations += 1; return randomUUID(); };
    const reserved = first.reserve(input, allocate);
    const collided = second.reserve(input, allocate);
    expect(reserved.kind).toBe('new');
    expect(collided.kind).toBe('replay');
    expect(collided.record.operation_id).toBe(reserved.record.operation_id);
    expect(allocations).toBe(1);
  } finally { first.close(); second.close(); await sandbox.dispose(); }
});
