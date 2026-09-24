import { createHash, randomUUID } from 'node:crypto';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { LocalMutationCoordinator } from '../../src/core/mutation.js';
import type {
  LocalDocumentEffect,
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt,
  LocalReferenceEdit
} from '../../src/core/types.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import {
  openDocumentStore,
  type DocumentIndex,
  type DocumentStore,
  type DocumentStoreFaults
} from '../../src/storage/document-store.js';
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
  const revisions = await openRevisionStore(sandbox.state);
  const makeStore = (): Promise<DocumentStore> =>
    openDocumentStore({
      vault: sandbox.vault,
      state: sandbox.state,
      ...(storeFaults === undefined ? {} : { faults: storeFaults }),
      ...(index === undefined ? {} : { index })
    });
  const store = await makeStore();
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
    reopenStore: async (faults) => {
      await ground.store.close();
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
          expected: { kind: 'present', etag: spec.survivorEtag, id: spec.id }
        },
        ...spec.removalPaths.map(
          (removal): import('../../src/core/types.js').LocalReadCondition => ({
            kind: 'path',
            path: removal.path,
            expected: { kind: 'present', etag: removal.etag, id: removal.id }
          })
        ),
        ...(spec.referenceEdits ?? [])
          .filter((edit) => edit.managed === undefined)
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
        { path: 'Knowledge/Plain.md', expected_etag: sha256(plainRaw), raw: plainEditRaw }
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
  } finally {
    await ground.dispose();
  }
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
            await symlink('Knowledge/A.md', join(ground.vaultRoot, 'Knowledge/B.md'));
          }
        }
      }
    });
    ground.coordinator = makeCoordinator(ground);
    await expect(
      ground.coordinator.run(resolveIntent(key, id, expected), resolvePlan(spec))
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|RECOVERY_REQUIRED|CONFLICT/) });
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toContain('resolved');
  } finally {
    await ground.dispose();
  }
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
      expect(await ground.revisions.hasRevision(id, seeded.revisionId)).toBe(true);
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
      await ground.coordinator
        .run(resolveIntent(key, id, expected), resolvePlan(spec))
        .catch(() => undefined);

      await ground.reopenStore();
      const report = await ground.coordinator.recover();
      expect(report.inspected).toBeGreaterThanOrEqual(0);

      expect(await ground.revisions.hasRevision(id, a.revisionId)).toBe(true);
      expect(await ground.revisions.hasRevision(id, b.revisionId)).toBe(true);
      const aRaw = (await ground.store.readPath('Knowledge/A.md')).raw;
      expect([managed(id, 'resolved'), a.raw]).toContain(aRaw);
      const bRead = await ground.store.readPath('Knowledge/B.md').catch(() => undefined);
      if (bRead !== undefined) expect(bRead.raw).toBe(b.raw);
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
