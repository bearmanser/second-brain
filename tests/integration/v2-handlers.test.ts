import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import type { BrainConfig } from '../../src/config/schema.js';
import type {
  AuthenticatedContext,
  LocalHandlerDeps,
  NoteInput,
  ProjectEnsureResult,
  RecallRequest
} from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { captureLocal } from '../../src/features/capture.js';
import { reviewLocal } from '../../src/features/review.js';
import { feedbackLocal } from '../../src/features/feedback.js';
import { projectEnsureLocal } from '../../src/features/project-ensure.js';
import { localRead, localStatus } from '../../src/features/local-brain.js';
import { buildLocalHandlerDeps, type LocalBrain } from '../../src/features/local-support.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { Journal, LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault, scanVaultFilePaths } from '../../src/storage/vault.js';
import { renderDocument, parseDocument, documentFromNote } from '../../src/notes/document-codec.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';
import { normalizeRepositoryIdentity, scopeCandidateForRepository } from '../../src/projects/identity.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };

function ctx(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

function note(title: string, marker: string, kind: 'note' | 'decision' = 'note'): NoteInput {
  if (kind === 'decision') {
    return {
      title,
      tags: [],
      content: {
        kind: 'decision',
        context: marker,
        decision: marker,
        rationale: 'because'
      },
      evidence: [
        { kind: 'test_run', ref: 'tests/integration/v2-handlers.test.ts', description: 'verified' }
      ],
      related_ids: []
    };
  }
  return {
    title,
    tags: [],
    content: { kind: 'note', summary: marker, body_markdown: `# ${title}\n\n${marker}\n` },
    evidence: [],
    related_ids: []
  };
}

interface Ground {
  brain: LocalBrain;
  deps: LocalHandlerDeps;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  operations: LocalOperationJournal;
  journal: Journal;
  revisions: RevisionStore;
  vaultRoot: string;
  state: string;
  dispose: () => Promise<void>;
}

async function openGround(): Promise<Ground> {
  const sandbox = await vaultSandbox();
  const journal = Journal.open(join(sandbox.state, 'journal.db'), { clock, ids });
  const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const revisions = await openRevisionStore(sandbox.state);
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const index = openSearchIndex(':memory:');
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const config = {
    mounts: { vault: sandbox.vault, state: sandbox.state },
    scopes: [
      { id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] },
      { id: 'profile', backend_project: 'profile', relative_root: 'Profile', repository_aliases: [] }
    ],
    result_delivery: 'structured',
    limits: { reconcile_interval_ms: 1000 }
  } as unknown as BrainConfig;
  const brain: LocalBrain = {
    config,
    clock,
    ids,
    documents: store,
    catalogue,
    index,
    journal,
    operations,
    vault,
    vaultRoot: sandbox.vault,
    close: async () => undefined
  };
  const deps = await buildLocalHandlerDeps(brain);
  const ground: Ground = {
    brain,
    deps,
    store,
    catalogue,
    operations,
    journal,
    revisions,
    vaultRoot: sandbox.vault,
    state: sandbox.state,
    dispose: async () => {
      try {
        ground.operations.close();
      } catch {
        undefined;
      }
      ground.journal.close();
      await ground.store.close();
      ground.catalogue.close();
      ground.brain.index.close();
      await sandbox.dispose();
    }
  };
  return ground;
}

async function restartGround(ground: Ground): Promise<void> {
  ground.operations.close();
  ground.journal.close();
  await ground.store.close();
  ground.catalogue.close();
  ground.brain.index.close();
  ground.operations = LocalOperationJournal.open(join(ground.state, 'operations.sqlite'));
  ground.journal = Journal.open(join(ground.state, 'journal.db'), { clock, ids });
  ground.revisions = await openRevisionStore(ground.state);
  ground.store = await openDocumentStore({ vault: ground.vaultRoot, state: ground.state });
  ground.catalogue = CurrentCatalogue.open({ revisions: ground.revisions, ids });
  ground.brain = {
    ...ground.brain,
    operations: ground.operations,
    journal: ground.journal,
    documents: ground.store,
    catalogue: ground.catalogue,
    index: openSearchIndex(':memory:')
  };
  ground.deps = await buildLocalHandlerDeps(ground.brain);
  await refresh(ground);
}

async function refresh(ground: Ground): Promise<void> {
  await reconcileCurrentVault({ vault: ground.brain.vault, catalogue: ground.catalogue });
}

test('every review lifecycle action works through the local coordinator', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const captured = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Lifecycle decision', 'lifecycle', 'decision') },
      ground.deps
    );
    await refresh(ground);
    expect(captured.outcome).toBe('stored');

    const listed = await reviewLocal(c, { operation: { action: 'list', filter: 'candidate' } }, ground.deps);
    expect('items' in listed && listed.items.some((item) => item.id === captured.id)).toBe(true);

    const approveRequest = { operation: {
      action: 'approve' as const, idempotency_key: randomUUID(), id: captured.id,
      expected_etag: captured.etag as string, rationale: 'evidence verified'
    } };
    const approved = await reviewLocal(
      c,
      approveRequest,
      ground.deps
    );
    expect('outcome' in approved && approved.outcome).toBe('stored');
    expect(await reviewLocal(c, approveRequest, ground.deps)).toEqual(approved);
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.status).toBe('active');

    const reviseRequest = { operation: {
      action: 'revise' as const, idempotency_key: randomUUID(), id: captured.id,
      expected_etag: ground.catalogue.getById(captured.id)?.etag as string,
      rationale: 'tighten', note: note('Lifecycle decision', 'lifecycle revised', 'decision')
    } };
    const revised = await reviewLocal(
      c,
      reviseRequest,
      ground.deps
    );
    expect('outcome' in revised && revised.outcome).toBe('stored');
    expect((await ground.revisions.readRevisionMetadata(captured.id, (revised as { revision_id: string }).revision_id))
      .parents.map((parent) => parent.revision_id)).toEqual([(approved as { revision_id: string }).revision_id]);
    expect(await reviewLocal(c, reviseRequest, ground.deps)).toEqual(revised);
    expect(await reviewLocal(c, approveRequest, ground.deps)).toEqual(approved);
    await expect(reviewLocal(c, { operation: { ...reviseRequest.operation, rationale: 'different' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.status).toBe('candidate');

    const reApproved = await reviewLocal(
      c,
      {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: ground.catalogue.getById(captured.id)?.etag as string,
          rationale: 're-approve'
        }
      },
      ground.deps
    );
    expect('outcome' in reApproved && reApproved.outcome).toBe('stored');

    const replacement = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Replacement note', 'replacement') },
      ground.deps
    );
    await refresh(ground);
    await reviewLocal(
      c,
      {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: replacement.id,
          expected_etag: replacement.etag as string,
          rationale: 'approve replacement'
        }
      },
      ground.deps
    );
    const supersedeRequest = {
      operation: {
        action: 'supersede' as const,
        idempotency_key: randomUUID(),
        id: captured.id,
        expected_etag: ground.catalogue.getById(captured.id)?.etag as string,
        rationale: 'superseded',
        replacement_id: replacement.id
      }
    };
    const superseded = await reviewLocal(c, supersedeRequest, ground.deps);
    expect('outcome' in superseded && superseded.outcome).toBe('stored');
    expect(await reviewLocal(c, supersedeRequest, ground.deps)).toEqual(superseded);
    await expect(reviewLocal(c, { operation: { ...supersedeRequest.operation, rationale: 'different' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { operation: { ...supersedeRequest.operation, replacement_id: randomUUID() } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.status).toBe('superseded');

    const archiveRequest = {
      operation: {
        action: 'archive' as const,
        idempotency_key: randomUUID(),
        id: replacement.id,
        expected_etag: ground.catalogue.getById(replacement.id)?.etag as string,
        rationale: 'archive'
      }
    };
    const archived = await reviewLocal(c, archiveRequest, ground.deps);
    expect('outcome' in archived && archived.outcome).toBe('stored');
    expect(await reviewLocal(c, archiveRequest, ground.deps)).toEqual(archived);
    await expect(reviewLocal(c, { operation: { ...archiveRequest.operation, rationale: 'different' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { operation: { ...archiveRequest.operation, action: 'approve' as const } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await refresh(ground);
    expect(ground.catalogue.getById(replacement.id)?.status).toBe('archived');
    await restartGround(ground);
    expect(await reviewLocal(c, archiveRequest, ground.deps)).toEqual(archived);
    expect(await reviewLocal(c, supersedeRequest, ground.deps)).toEqual(superseded);
  } finally {
    await ground.dispose();
  }
});

test('capture, approve, revise, move and adopt replay stably and reject different payloads', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const key = randomUUID();
    const first = await captureLocal(c, { idempotency_key: key, note: note('Stable note', 'stable') }, ground.deps);
    const replay = await captureLocal(c, { idempotency_key: key, note: note('Stable note', 'stable') }, ground.deps);
    expect(replay.operation_id).toBe(first.operation_id);
    await expect(
      captureLocal(c, { idempotency_key: key, note: note('Stable note', 'different') }, ground.deps)
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      reviewLocal(
        c,
        {
          operation: {
            action: 'approve',
            idempotency_key: key,
            id: first.id,
            expected_etag: first.etag as string,
            rationale: 'cross tool'
          }
        },
        ground.deps
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await refresh(ground);
    const status = await localStatus(c, { operation_id: first.operation_id }, ground.brain);
    expect(status.operation?.operation_id).toBe(first.operation_id);

    const moveKey = randomUUID();
    const moveRequest = {
      operation: {
        action: 'move' as const,
        idempotency_key: moveKey,
        id: first.id,
        target_path: 'Inbox/Moved stable.md',
        expected_etag: ground.catalogue.getById(first.id)?.etag as string,
        rationale: 'relocate'
      }
    };
    const moved = await reviewLocal(
      c,
      moveRequest,
      ground.deps
    );
    expect(await reviewLocal(c, moveRequest, ground.deps)).toEqual(moved);

    await mkdir(join(ground.vaultRoot, 'Knowledge'), { recursive: true });
    await writeFile(join(ground.vaultRoot, 'Knowledge/Plain.md'), '# Plain\n\nbody\n');
    const adoptKey = randomUUID();
    const adoptRequest = {
      operation: {
        action: 'adopt' as const,
        idempotency_key: adoptKey,
        path: 'Knowledge/Plain.md',
        expected_etag: createHash('sha256').update('# Plain\n\nbody\n').digest('hex'),
        rationale: 'adopt'
      }
    };
    const adopted = await reviewLocal(
      c,
      adoptRequest,
      ground.deps
    );
    expect(await reviewLocal(c, adoptRequest, ground.deps)).toEqual(adopted);
    const managedPath = 'Inbox/Moved stable.md';
    const managedFile = await ground.store.readPath(managedPath);
    await expect(reviewLocal(c, { operation: {
      action: 'adopt', idempotency_key: randomUUID(), path: managedPath,
      expected_etag: managedFile.etag, rationale: 'cannot re-adopt managed'
    } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reviewLocal(c, { operation: { ...adoptRequest.operation, rationale: 'changed' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { operation: { ...moveRequest.operation, rationale: 'changed' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally {
    await ground.dispose();
  }
});

test('project ensure is durable, idempotent, and replays its original receipt', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const key = randomUUID();
    const first = await projectEnsureLocal(
      c,
      { idempotency_key: key, remote_url: 'https://github.com/example/handlers.git' },
      ground.deps
    );
    expect(first.created).toBe(true);
    expect((await localStatus(c, { operation_id: first.operation_id }, ground.brain)).operation?.operation_id)
      .toBe(first.operation_id);
    await restartGround(ground);
    const replay = await projectEnsureLocal(
      c,
      { idempotency_key: key, remote_url: 'https://github.com/example/handlers.git' },
      ground.deps
    );
    expect(replay.operation_id).toBe(first.operation_id);
    expect(replay.created).toBe(true);
    const other = await projectEnsureLocal(
      c,
      { idempotency_key: randomUUID(), remote_url: 'git@github.com:example/handlers.git' },
      ground.deps
    );
    expect(other.project_id).toBe(first.project_id);
    expect(other.created).toBe(false);
    const listed: ProjectEnsureResult = first;
    expect(listed.relative_root).toBeTruthy();
    expect(ground.deps.mutations.status(first.operation_id)?.state).toBe('finalized');
  } finally {
    await ground.dispose();
  }
});

test('a persisted project plan is recovered after restart before any registry effect', async () => {
  const ground = await openGround();
  const identity = normalizeRepositoryIdentity('https://github.com/example/interrupted.git');
  const projectId = scopeCandidateForRepository(identity);
  const operationId = randomUUID();
  const key = randomUUID();
  const now = new Date().toISOString();
  try {
    ground.operations.reserve({
      operation_id: operationId, idempotency_key: key, tool: 'brain_project_ensure', action: 'ensure',
      project_id: null, payload_hash: 'a'.repeat(64), payload_json: '{}', created_at: now, updated_at: now
    });
    ground.operations.update(operationId, {
      plan_json: JSON.stringify({
        kind: 'project_ensure', repository_identity: identity, project_id: projectId,
        relative_root: 'Projects/Interrupted', display_name: 'Interrupted',
        created_by_actor_id: SYSTEM_ACTOR.id, created: true,
        read_set: [{ kind: 'project', repository_identity: identity, expected: { kind: 'absent' } }]
      }), updated_at: now
    });
    expect(ground.journal.getProjectByIdentity(identity)).toBeUndefined();
    await restartGround(ground);
    const recovered = await ground.deps.mutations.recover();
    expect(recovered.finalized).toBe(1);
    expect(ground.deps.mutations.status(operationId)?.receipt).toMatchObject({ created: true, project_id: projectId });
    expect(ground.journal.getProjectByIdentity(identity)?.state).toBe('ready');
  } finally {
    await ground.dispose();
  }
});

test('a project created after plan persistence but before its receipt recovers the original created flag', async () => {
  const ground = await openGround();
  const identity = normalizeRepositoryIdentity('https://github.com/example/partially-created.git');
  const id = scopeCandidateForRepository(identity);
  const operationId = randomUUID();
  const now = new Date().toISOString();
  try {
    ground.operations.reserve({ operation_id: operationId, idempotency_key: randomUUID(),
      tool: 'brain_project_ensure', action: 'ensure', project_id: null,
      payload_hash: 'b'.repeat(64), payload_json: '{}', created_at: now, updated_at: now });
    ground.operations.update(operationId, { plan_json: JSON.stringify({
      kind: 'project_ensure', repository_identity: identity, project_id: id,
      relative_root: 'Projects/Partially-created', display_name: 'Partially created',
      created_by_actor_id: SYSTEM_ACTOR.id, created: true,
      read_set: [{ kind: 'project', repository_identity: identity, expected: { kind: 'absent' } }]
    }), progress_json: JSON.stringify({ preconditions_validated: true }), updated_at: now });
    ground.journal.reserveProject({ repository_identity: identity, project_id: id,
      display_name: 'Partially created', relative_root: 'Projects/Partially-created',
      created_by_actor_id: SYSTEM_ACTOR.id, creation_operation_id: operationId });
    await restartGround(ground);
    expect(await ground.deps.mutations.recover()).toEqual({ inspected: 1, finalized: 1, recovered: 1, conflicted: 0, pending: 0, blocking_operations: [] });
    expect(ground.journal.getProjectByIdentity(identity)?.state).toBe('ready');
    expect(ground.deps.mutations.status(operationId)?.receipt).toMatchObject({ created: true, materialized: true });
  } finally { await ground.dispose(); }
});

test('V2 capture and review accept additive type and source without losing either', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const input: NoteInput = { ...note('Human research', 'human'), type: 'research', source: 'local-notes' };
    const first = await captureLocal(c, { idempotency_key: randomUUID(), note: input }, ground.deps);
    const path = ground.catalogue.getById(first.id)?.path as string;
    expect(parseDocument((await ground.store.readPath(path)).raw, path)).toMatchObject({ type: 'research', properties: { source: 'local-notes' } });
    const second = await reviewLocal(c, { operation: {
      action: 'revise', idempotency_key: randomUUID(), id: first.id,
      expected_etag: first.etag as string, rationale: 'update source',
      note: { ...input, source: 'updated-local' }
    } }, ground.deps);
    expect('outcome' in second && second.outcome).toBe('stored');
    expect(parseDocument((await ground.store.readPath(path)).raw, path).properties.source).toBe('updated-local');
  } finally { await ground.dispose(); }
});

test('per-runtime handler calls share a coordinator and serialize concurrent path allocation', async () => {
  const ground = await openGround();
  try {
    expect((await buildLocalHandlerDeps(ground.brain)).mutations).toBe(ground.deps.mutations);
    const [a, b] = await Promise.all([
      captureLocal(ctx(), { idempotency_key: randomUUID(), note: note('Same concurrent title', 'a') },
        await buildLocalHandlerDeps(ground.brain)),
      captureLocal(ctx(), { idempotency_key: randomUUID(), note: note('Same concurrent title', 'b') },
        await buildLocalHandlerDeps(ground.brain))
    ]);
    expect(a.id).not.toBe(b.id);
    expect(ground.catalogue.all().filter((item) => item.title === 'Same concurrent title')).toHaveLength(2);
  } finally { await ground.dispose(); }
});

test('resolve uses the accepted consolidation and preserves branches for history and feedback', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const id = randomUUID();
    const rootRaw = `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# root\n\nroot\n`;
    const rootRev = randomUUID();
    const rootHash = createHash('sha256').update(rootRaw, 'utf8').digest('hex');
    await ground.revisions.persistRevision(id, rootRev, rootRaw);
    await ground.revisions.persistRevisionMetadata({
      id,
      revision_id: rootRev,
      parents: [],
      created_at: new Date().toISOString()
    });
    const headRaw = (marker: string): string =>
      `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# ${marker}\n\n${marker}\n`;
    const aRaw = `${headRaw('branch A')}\n[[Knowledge/B#Anchor|inside]]\n`;
    const bRaw = headRaw('branch B');
    const cRaw = headRaw('branch C');
    const aRev = randomUUID();
    const bRev = randomUUID();
    const cRev = randomUUID();
    for (const [path, raw, revisionId] of [
      ['Knowledge/A.md', aRaw, aRev],
      ['Knowledge/B.md', bRaw, bRev],
      ['Knowledge/C.md', cRaw, cRev]
    ] as const) {
      await ground.revisions.persistRevision(id, revisionId, raw);
      await ground.revisions.persistRevisionMetadata({
        id,
        revision_id: revisionId,
        parents: [{ revision_id: rootRev, raw_hash: rootHash }],
        created_at: new Date().toISOString()
      });
      const absolute = join(ground.vaultRoot, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, raw);
      await ground.revisions.bindCurrent(id, path, revisionId, createHash('sha256').update(raw, 'utf8').digest('hex'));
    }
    const backlink = '---\ntype: note\n---\n\n[[Knowledge/B#Anchor|B]] and [[Knowledge/C#Anchor|C]]\n';
    await writeFile(join(ground.vaultRoot, 'Knowledge/Backlinks.md'), backlink);
    const referringId = randomUUID();
    const referringRevision = randomUUID();
    const referringPath = 'Knowledge/Managed backlinks.md';
    await ground.store.put({ path: referringPath,
      raw: `---\nid: ${referringId}\ntype: note\nstatus: candidate\n---\n\n[Branch B](./B.md#Anchor) and ![[Knowledge/C#Anchor]]\n`,
      expectedEtag: null, idempotencyKey: randomUUID(), source: 'seed',
      revisionId: referringRevision, parents: [] });
    await refresh(ground);
    const heads = await ground.deps.mutations.enumerateConflictHeads(id);
    expect(heads.length).toBe(3);
    const conflicts = await reviewLocal(c, { operation: { action: 'list', filter: 'conflict' } }, ground.deps);
    expect('items' in conflicts && conflicts.items.filter((item) => item.id === id)).toHaveLength(3);
    const filteredConflicts = await reviewLocal(c, { project: 'shared',
      operation: { action: 'list', filter: 'conflict' } }, ground.deps);
    expect('items' in filteredConflicts && filteredConflicts.items.some((item) => item.id === id)).toBe(false);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const missingAnchorKey = randomUUID();
    await expect(reviewLocal(c, { operation: {
      action: 'resolve', idempotency_key: missingAnchorKey, id,
      expected_heads: expected, rationale: 'missing anchor', note: note('resolved', 'no anchor')
    } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ground.operations.findByKey(missingAnchorKey)).toBeUndefined();
    await expect(reviewLocal(c, { project: 'shared', operation: {
      action: 'resolve', idempotency_key: randomUUID(), id,
      expected_heads: expected, rationale: 'wrong project', note: note('resolved', 'resolved')
    } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    const resolveRequest = {
      operation: {
        action: 'resolve' as const,
        idempotency_key: randomUUID(),
        id,
        expected_heads: expected,
        rationale: 'merge branches',
        note: { ...note('resolved', 'resolved'), content: { kind: 'note' as const, summary: 'resolved', body_markdown: '## Anchor\n\n^block\n' } }
      }
    };
    const result = await reviewLocal(
      c,
      resolveRequest,
      ground.deps
    );
    expect('outcome' in result && result.revision_id).toBeTruthy();
    await restartGround(ground);
    expect(await reviewLocal(c, resolveRequest, ground.deps)).toEqual(result);
    await expect(reviewLocal(c, { operation: { ...resolveRequest.operation, rationale: 'different' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const resolution = ground.deps.mutations.status((result as { operation_id: string }).operation_id);
    expect(resolution?.receipt).toMatchObject({ revision_id: (result as { revision_id: string }).revision_id });
    const metadata = await ground.revisions.readRevisionMetadata(id, (result as { revision_id: string }).revision_id);
    expect(metadata?.parents.map((parent) => parent.revision_id).sort()).toEqual([aRev, bRev, cRev].sort());
    const branchBytes = [[aRev, aRaw], [bRev, bRaw], [cRev, cRaw]] as const;
    const sha = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');
    expect([...(metadata?.parents ?? [])].sort((l, r) => (l.revision_id < r.revision_id ? -1 : 1)))
      .toEqual(branchBytes.map(([revision, raw]) => ({ revision_id: revision, raw_hash: sha(raw) }))
        .sort((l, r) => (l.revision_id < r.revision_id ? -1 : 1)));
    for (const [revision, raw] of branchBytes) {
      expect((await ground.store.readRevision(id, revision)).raw).toBe(raw);
      expect((await ground.revisions.readRevision(id, revision)).raw).toBe(raw);
      expect((await ground.revisions.readRevisionMetadata(id, revision)).parents)
        .toEqual([{ revision_id: rootRev, raw_hash: rootHash }]);
    }
    await expect(ground.store.readPath('Knowledge/B.md')).rejects.toBeDefined();
    await expect(ground.store.readPath('Knowledge/C.md')).rejects.toBeDefined();
    expect((await ground.store.readPath('Knowledge/Backlinks.md')).raw).toContain('[[Knowledge/A#Anchor|B]] and [[Knowledge/A#Anchor|C]]');
    expect((await ground.store.readPath('Knowledge/A.md')).raw).toContain('[[Knowledge/A#Anchor|inside]]');
    const managed = (await ground.store.readPath(referringPath)).raw;
    expect(managed).toContain('[Branch B](./A.md#Anchor) and ![[Knowledge/A#Anchor]]');
    expect(ground.catalogue.getById(referringId)?.revision_id).not.toBe(referringRevision);
    await refresh(ground);
    expect(ground.catalogue.getById(id)?.status).toBe('candidate');
    const historical = await localRead(c, { id, revision_id: aRev }, ground.brain);
    expect(historical.markdown).toContain('branch A');
    const feedback = await feedbackLocal(
      c,
      {
        idempotency_key: randomUUID(),
        id,
        revision_id: aRev,
        verdict: 'useful',
        reason: 'branch A was useful'
      },
      ground.deps
    );
    expect(feedback.recorded).toBe(true);
    await expect(
      feedbackLocal(
        c,
        {
          idempotency_key: randomUUID(),
          id,
          revision_id: randomUUID(),
          verdict: 'useful',
          reason: 'unknown revision'
        },
        ground.deps
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await ground.dispose();
  }
});

test('approval requires non-hypothesis evidence and supersession rejects cycles', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const hypothesised = await captureLocal(
      c,
      {
        idempotency_key: randomUUID(),
        note: {
          title: 'Hypothesis only',
          tags: [],
          content: { kind: 'decision', context: 'c', decision: 'd', rationale: 'r' },
          evidence: [{ kind: 'hypothesis', ref: 'guess', description: 'unverified' }],
          related_ids: []
        }
      },
      ground.deps
    );
    await expect(
      reviewLocal(
        c,
        {
          operation: {
            action: 'approve',
            idempotency_key: randomUUID(),
            id: hypothesised.id,
            expected_etag: hypothesised.etag as string,
            rationale: 'premature'
          }
        },
        ground.deps
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const a = await captureLocal(c, { idempotency_key: randomUUID(), note: note('Cycle A', 'a') }, ground.deps);
    const b = randomUUID();
    const path = 'Knowledge/Cycle B.md';
    await ground.store.put({ path, raw: `---\nid: ${b}\ntype: note\nstatus: active\nreplacement_id: ${a.id}\n---\n\n# Cycle B\n`,
      expectedEtag: null, idempotencyKey: randomUUID(), source: 'seed', revisionId: randomUUID(), parents: [] });
    await refresh(ground);
    await expect(reviewLocal(c, { operation: {
      action: 'supersede', idempotency_key: randomUUID(), id: a.id,
      expected_etag: ground.catalogue.getById(a.id)?.etag as string,
      rationale: 'cycle', replacement_id: b
    } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('cycle') });
  } finally {
    await ground.dispose();
  }
});

test('explicit project filters constrain list and mutations without changing project identity', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const project = await projectEnsureLocal(c, { idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/project-filter.git' }, ground.deps);
    const captured = await captureLocal(c, { project: project.project_id,
      idempotency_key: randomUUID(), note: note('Project filter', 'value') }, ground.deps);
    const listed = await reviewLocal(c, { project: project.repository_identity,
      operation: { action: 'list', filter: 'candidate' } }, ground.deps);
    expect('items' in listed && listed.items.map((item) => item.id)).toContain(captured.id);
    const outside = await reviewLocal(c, { project: 'shared',
      operation: { action: 'list', filter: 'candidate' } }, ground.deps);
    expect('items' in outside && outside.items.map((item) => item.id)).not.toContain(captured.id);
    await expect(reviewLocal(c, { project: 'shared', operation: {
      action: 'approve', idempotency_key: randomUUID(), id: captured.id,
      expected_etag: captured.etag as string, rationale: 'outside filter'
    } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    const approveOperation = { action: 'approve' as const, idempotency_key: randomUUID(), id: captured.id,
      expected_etag: captured.etag as string, rationale: 'inside filter' };
    const approved = await reviewLocal(c, { project: project.repository_identity, operation: approveOperation }, ground.deps);
    expect(ground.deps.mutations.status((approved as { operation_id: string }).operation_id)?.project_id)
      .toBe(project.project_id);
    expect(await reviewLocal(c, { project: project.project_id, operation: approveOperation }, ground.deps))
      .toEqual(approved);
    await expect(reviewLocal(c, { project: 'shared', operation: approveOperation }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await ground.dispose(); }
});

test('duplicate titles produce a bounded capture advisory', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const key = randomUUID();
    const first = await captureLocal(c, { idempotency_key: key, note: note('Duplicate title', 'one') }, ground.deps);
    const second = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Duplicate title', 'two') },
      ground.deps
    );
    expect(second.possible_duplicates.length).toBeGreaterThanOrEqual(1);
    expect(second.possible_duplicates.length).toBeLessThanOrEqual(5);
    expect(await captureLocal(c, { idempotency_key: key, note: note('Duplicate title', 'one') }, ground.deps))
      .toEqual(first);
  } finally {
    await ground.dispose();
  }
});

test('related IDs are validated and human properties survive a revise', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const target = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Related target', 'target') },
      ground.deps
    );
    await refresh(ground);
    const linked = await captureLocal(
      c,
      {
        idempotency_key: randomUUID(),
        note: { ...note('Related source', 'source'), related_ids: [target.id] }
      },
      ground.deps
    );
    expect(linked.outcome).toBe('stored');
    await expect(
      captureLocal(
        c,
        {
          idempotency_key: randomUUID(),
          note: { ...note('Bad related', 'bad'), related_ids: [randomUUID()] }
        },
        ground.deps
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const managedId = randomUUID();
    const managedRevision = randomUUID();
    await ground.store.put({
      path: 'Knowledge/Preserved.md',
      raw: `---\nid: ${managedId}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\ncustom: keep\n---\n\n# Preserved\n\noriginal\n`,
      expectedEtag: null,
      idempotencyKey: 'preserved-seed',
      source: 'seed',
      revisionId: managedRevision,
      parents: []
    });
    await refresh(ground);
    await reviewLocal(
      c,
      {
        operation: {
          action: 'revise',
          idempotency_key: randomUUID(),
          id: managedId,
          expected_etag: ground.catalogue.getById(managedId)?.etag as string,
          rationale: 'revise preserving properties',
          note: note('Preserved', 'revised')
        }
      },
      ground.deps
    );
    await refresh(ground);
    const after = (await ground.store.readPath('Knowledge/Preserved.md')).raw;
    expect(after).toContain('custom: keep');
    await expect(reviewLocal(c, { operation: {
      action: 'revise', idempotency_key: randomUUID(), id: managedId,
      expected_etag: ground.catalogue.getById(managedId)?.etag as string,
      rationale: 'bad relationship', note: { ...note('Preserved', 'revised'), related_ids: [randomUUID()] }
    } }, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const decisionId = randomUUID();
    const decisionPath = 'Knowledge/Human decision.md';
    const structuredRaw = renderDocument(documentFromNote(note('Human decision', 'old', 'decision'), {
      path: decisionPath, id: decisionId, status: 'candidate'
    })).replace('## Decision', '## Human journal\n\nPersonal context stays.\n\n## Decision');
    await ground.store.put({ path: decisionPath, raw: structuredRaw, expectedEtag: null,
      idempotencyKey: randomUUID(), source: 'seed', revisionId: randomUUID(), parents: [] });
    await refresh(ground);
    await reviewLocal(c, { operation: { action: 'revise', idempotency_key: randomUUID(),
      id: decisionId, expected_etag: ground.catalogue.getById(decisionId)?.etag as string,
      rationale: 'revise structured', note: note('Human decision', 'new', 'decision')
    } }, ground.deps);
    expect((await ground.store.readPath(decisionPath)).raw).toContain('Personal context stays.');
  } finally {
    await ground.dispose();
  }
});

test('writes succeed while the model is disabled', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    expect(ground.deps.worker).toBeUndefined();
    const captured = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Model off', 'off') },
      ground.deps
    );
    expect(captured.outcome).toBe('stored');
    const recall = await import('../../src/features/recall.js');
    void recall;
    const request: RecallRequest = { query: 'Model off', include_candidates: true };
    void request;
  } finally {
    await ground.dispose();
  }
});

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function seedAncestor(ground: Ground, id: string): Promise<{ revision_id: string; raw_hash: string }> {
  const raw = `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# root\n\nroot\n`;
  const revision = randomUUID();
  await ground.revisions.persistRevision(id, revision, raw);
  await ground.revisions.persistRevisionMetadata({ id, revision_id: revision, parents: [], created_at: new Date().toISOString() });
  return { revision_id: revision, raw_hash: sha256(raw) };
}

async function seedExternalHead(
  ground: Ground,
  id: string,
  path: string,
  raw: string,
  parent: { revision_id: string; raw_hash: string }
): Promise<string> {
  const revision = randomUUID();
  await ground.revisions.persistRevision(id, revision, raw);
  await ground.revisions.persistRevisionMetadata({ id, revision_id: revision, parents: [parent], created_at: new Date().toISOString() });
  const absolute = join(ground.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw);
  await ground.revisions.bindCurrent(id, path, revision, sha256(raw));
  return revision;
}

function forkRaw(id: string, marker: string): string {
  return `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# ${marker}\n\n${marker}\n`;
}

function resolveNote(body: string): NoteInput {
  return { ...note('resolved', 'resolved'), content: { kind: 'note', summary: 'resolved', body_markdown: body } };
}

test('finalized requests replay and conflict after their project selector stops resolving', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const captureRequest = { project: 'shared', idempotency_key: randomUUID(), note: note('Shared note', 'shared') };
    const captured = await captureLocal(c, captureRequest, ground.deps);
    const approveRequest = { project: 'shared', operation: {
      action: 'approve' as const, idempotency_key: randomUUID(), id: captured.id,
      expected_etag: captured.etag as string, rationale: 'shared approval'
    } };
    const approved = await reviewLocal(c, approveRequest, ground.deps);
    const feedbackRequest = { scope: 'shared', idempotency_key: randomUUID(), id: captured.id,
      revision_id: captured.revision_id as string, verdict: 'useful' as const, reason: 'shared feedback' };
    const recorded = await feedbackLocal(c, feedbackRequest, ground.deps);
    const config = ground.brain.config as unknown as { scopes: { id: string }[] };
    config.scopes = config.scopes.filter((scope) => scope.id !== 'shared');
    await restartGround(ground);
    expect(() => ground.deps.projects.resolve('shared')).toThrow();

    expect(await captureLocal(c, captureRequest, ground.deps)).toEqual(captured);
    await expect(captureLocal(c, { ...captureRequest, note: note('Shared note', 'changed') }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(captureLocal(c, { ...captureRequest, idempotency_key: randomUUID() }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await reviewLocal(c, approveRequest, ground.deps)).toEqual(approved);
    await expect(reviewLocal(c, { ...approveRequest, operation: { ...approveRequest.operation, rationale: 'changed' } }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { project: 'profile', operation: approveRequest.operation }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { project: 'renamed', operation: approveRequest.operation }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewLocal(c, { ...approveRequest, operation: { ...approveRequest.operation, idempotency_key: randomUUID() } }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await feedbackLocal(c, feedbackRequest, ground.deps)).toEqual(recorded);
    await expect(feedbackLocal(c, { ...feedbackRequest, reason: 'changed' }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(feedbackLocal(c, { ...feedbackRequest, idempotency_key: randomUUID() }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally { await ground.dispose(); }
});

test('rejected planning releases the key and a pre-plan crash is released by recovery without effects', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const captured = await captureLocal(c, { idempotency_key: randomUUID(), note: note('Released', 'released') }, ground.deps);
    const staleKey = randomUUID();
    await expect(reviewLocal(c, { operation: { action: 'approve', idempotency_key: staleKey, id: captured.id,
      expected_etag: 'f'.repeat(64), rationale: 'stale' } }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ground.operations.findByKey(staleKey)).toBeUndefined();
    const retried = await reviewLocal(c, { operation: { action: 'approve', idempotency_key: staleKey, id: captured.id,
      expected_etag: captured.etag as string, rationale: 'fresh' } }, ground.deps);
    expect('outcome' in retried && retried.outcome).toBe('stored');

    const relatedKey = randomUUID();
    const target = await captureLocal(c, { idempotency_key: randomUUID(), note: note('Late target', 'target') }, ground.deps);
    const revision = { operation: { action: 'revise' as const, idempotency_key: relatedKey, id: target.id,
      expected_etag: target.etag as string, rationale: 'link', note: { ...note('Late target', 'linked'), related_ids: [randomUUID()] } } };
    await expect(reviewLocal(c, revision, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(ground.operations.findByKey(relatedKey)).toBeUndefined();

    const replacement = await captureLocal(c, { idempotency_key: randomUUID(), note: note('Pending replacement', 'r') }, ground.deps);
    const supersedeRequest = { operation: { action: 'supersede' as const, idempotency_key: randomUUID(), id: captured.id,
      expected_etag: ground.catalogue.getById(captured.id)?.etag as string, rationale: 'replace',
      replacement_id: replacement.id } };
    await expect(reviewLocal(c, supersedeRequest, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ground.operations.findByKey(supersedeRequest.operation.idempotency_key)).toBeUndefined();
    await reviewLocal(c, { operation: { action: 'approve', idempotency_key: randomUUID(), id: replacement.id,
      expected_etag: replacement.etag as string, rationale: 'activate' } }, ground.deps);
    const superseded = await reviewLocal(c, supersedeRequest, ground.deps);
    expect('outcome' in superseded && superseded.outcome).toBe('stored');
    expect(await reviewLocal(c, supersedeRequest, ground.deps)).toEqual(superseded);

    const now = new Date().toISOString();
    const crashedKey = randomUUID();
    const crashed = ground.operations.reserve({ operation_id: randomUUID(), idempotency_key: crashedKey,
      tool: 'brain_capture', action: 'capture', project_id: null, payload_hash: 'c'.repeat(64),
      payload_json: '{}', created_at: now, updated_at: now });
    const inProcessKey = randomUUID();
    ground.operations.reserve({ operation_id: randomUUID(), idempotency_key: inProcessKey,
      tool: 'brain_capture', action: 'capture', project_id: null, payload_hash: 'd'.repeat(64),
      payload_json: '{}', created_at: now, updated_at: now });
    const inProcess = await captureLocal(c, { idempotency_key: inProcessKey, note: note('In process', 'x') }, ground.deps);
    expect(inProcess.outcome).toBe('stored');
    const before = (await scanVaultFilePaths(ground.vaultRoot)).paths.slice().sort();
    await restartGround(ground);
    const report = await ground.deps.mutations.recover();
    expect(report.blocking_operations).not.toContain(crashed.record.operation_id);
    expect(ground.deps.mutations.status(crashed.record.operation_id)).toBeUndefined();
    expect(ground.operations.findByKey(crashedKey)).toBeUndefined();
    expect((await scanVaultFilePaths(ground.vaultRoot)).paths.slice().sort()).toEqual(before);
    const afterCrash = await captureLocal(c, { idempotency_key: crashedKey, note: note('After crash', 'y') }, ground.deps);
    expect(afterCrash.outcome).toBe('stored');
    expect(await captureLocal(c, { idempotency_key: crashedKey, note: note('After crash', 'y') }, ground.deps)).toEqual(afterCrash);
  } finally { await ground.dispose(); }
});

test('project-filtered status finds its own ensure operation across replay and restart', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const request = { idempotency_key: randomUUID(), remote_url: 'https://github.com/example/status-filter.git' };
    const ensured = await projectEnsureLocal(c, request, ground.deps);
    expect(ground.operations.findById(ensured.operation_id)?.project_id).toBe(ensured.project_id);
    for (const selector of [{ project: ensured.project_id }, { scope: ensured.project_id }, { project: ensured.repository_identity }]) {
      expect((await localStatus(c, { ...selector, operation_id: ensured.operation_id }, ground.brain)).operation)
        .toMatchObject({ operation_id: ensured.operation_id, project_id: ensured.project_id, created: true });
    }
    expect(await projectEnsureLocal(c, request, ground.deps)).toEqual(ensured);
    await restartGround(ground);
    expect((await localStatus(c, { project: ensured.project_id, operation_id: ensured.operation_id }, ground.brain)).operation)
      .toMatchObject({ operation_id: ensured.operation_id, created: true });
    await expect(localStatus(c, { project: 'shared', operation_id: ensured.operation_id }, ground.brain))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const identity = normalizeRepositoryIdentity('https://github.com/example/legacy-status.git');
    const legacyProject = scopeCandidateForRepository(identity);
    const legacyOperation = randomUUID();
    const now = new Date().toISOString();
    ground.operations.reserve({ operation_id: legacyOperation, idempotency_key: randomUUID(),
      tool: 'brain_project_ensure', action: 'ensure', project_id: null,
      payload_hash: 'e'.repeat(64), payload_json: '{}', created_at: now, updated_at: now });
    ground.operations.update(legacyOperation, { plan_json: JSON.stringify({
      kind: 'project_ensure', repository_identity: identity, project_id: legacyProject,
      relative_root: 'Projects/Legacy-status', display_name: 'Legacy status',
      created_by_actor_id: SYSTEM_ACTOR.id, created: true,
      read_set: [{ kind: 'project', repository_identity: identity, expected: { kind: 'absent' } }]
    }), updated_at: now });
    await restartGround(ground);
    await ground.deps.mutations.recover();
    expect(ground.operations.findById(legacyOperation)?.payload_hash).toBe('e'.repeat(64));
    expect((await localStatus(c, { project: legacyProject, operation_id: legacyOperation }, ground.brain)).operation)
      .toMatchObject({ operation_id: legacyOperation, project_id: legacyProject });
  } finally { await ground.dispose(); }
});

test('resolve fragments must be real anchors of the survivor, not text in code or link labels', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const id = randomUUID();
    const root = await seedAncestor(ground, id);
    await seedExternalHead(ground, id, 'Knowledge/FA.md', forkRaw(id, 'fork A'), root);
    await seedExternalHead(ground, id, 'Knowledge/FB.md', forkRaw(id, 'fork B'), root);
    await writeFile(join(ground.vaultRoot, 'Knowledge/Refs.md'), '[[Knowledge/FB#^blk|block]] and [[Knowledge/FB#Hidden]]\n');
    await refresh(ground);
    const expected = (await ground.deps.mutations.enumerateConflictHeads(id))
      .map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const attempt = (body: string, key = randomUUID()) => reviewLocal(c, { operation: {
      action: 'resolve', idempotency_key: key, id, expected_heads: expected, rationale: 'anchors',
      note: resolveNote(body) } }, ground.deps);
    await expect(attempt('## Hidden\n\n```\ntext ^blk\n```\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('## Hidden\n\nsee `^blk`\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('## Hidden\n\n[label ^blk](https://example.com)\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('## Hidden\n\nsee [[Elsewhere#^blk]]\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('## Hidden\n\nsee [[Elsewhere|alias ^blk]]\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('```\n## Hidden\n```\n\ntext ^blk\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(attempt('Mention ^blk inline here\n\n## Hidden\n')).rejects.toMatchObject({ code: 'CONFLICT' });
    const key = randomUUID();
    const resolved = await attempt('## Hidden\n\nreal block ^blk\n', key);
    expect('outcome' in resolved && resolved.outcome).toBe('stored');
    expect((await ground.store.readPath('Knowledge/Refs.md')).raw)
      .toBe('[[Knowledge/FA#^blk|block]] and [[Knowledge/FA#Hidden]]\n');
  } finally { await ground.dispose(); }
});

test('resolve keeps the durable pre-conflict canonical path instead of the lexical first head', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const id = randomUUID();
    const canonical = 'Knowledge/Zed canonical.md';
    const rootRaw = forkRaw(id, 'root');
    const rootRevision = randomUUID();
    const root = await ground.store.put({ path: canonical, raw: rootRaw, expectedEtag: null,
      idempotencyKey: randomUUID(), source: 'seed', revisionId: rootRevision, parents: [] });
    const zRaw = forkRaw(id, 'canonical branch');
    const zRevision = randomUUID();
    await ground.store.put({ path: canonical, raw: zRaw, expectedEtag: root.etag, idempotencyKey: randomUUID(),
      source: 'seed', revisionId: zRevision, parents: [{ revision_id: rootRevision, raw_hash: sha256(rootRaw) }] });
    const copyRaw = forkRaw(id, 'copied branch');
    const copyRevision = await seedExternalHead(ground, id, 'Knowledge/Alpha copy.md', copyRaw,
      { revision_id: rootRevision, raw_hash: sha256(rootRaw) });
    await refresh(ground);
    const heads = await ground.deps.mutations.enumerateConflictHeads(id);
    expect(heads.map((head) => head.path).sort()).toEqual(['Knowledge/Alpha copy.md', canonical]);
    expect(await ground.deps.mutations.selectSurvivorPath(id, heads)).toBe(canonical);
    const result = await reviewLocal(c, { operation: { action: 'resolve', idempotency_key: randomUUID(), id,
      expected_heads: heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag })),
      rationale: 'keep canonical', note: resolveNote('merged\n') } }, ground.deps);
    expect('outcome' in result && result.outcome).toBe('stored');
    expect((await ground.store.readPath(canonical)).raw).toContain('merged');
    await expect(ground.store.readPath('Knowledge/Alpha copy.md')).rejects.toBeDefined();
    expect((await ground.store.readRevision(id, copyRevision)).raw).toBe(copyRaw);
    expect((await ground.store.readRevision(id, zRevision)).raw).toBe(zRaw);

    const lexicalId = randomUUID();
    const lexicalRoot = await seedAncestor(ground, lexicalId);
    await seedExternalHead(ground, lexicalId, 'Knowledge/Zulu.md', forkRaw(lexicalId, 'zulu'), lexicalRoot);
    await seedExternalHead(ground, lexicalId, 'Knowledge/Échelle.md', forkRaw(lexicalId, 'accent'), lexicalRoot);
    await seedExternalHead(ground, lexicalId, 'Knowledge/alpha.md', forkRaw(lexicalId, 'lower'), lexicalRoot);
    await refresh(ground);
    const lexicalHeads = await ground.deps.mutations.enumerateConflictHeads(lexicalId);
    expect(await ground.deps.mutations.selectSurvivorPath(lexicalId, lexicalHeads)).toBe('Knowledge/Zulu.md');
  } finally { await ground.dispose(); }
});

test('revising a note whose body contains level-two headings leaves no stale generated text', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const initial: NoteInput = { ...note('Headed body', 'headed'), content: { kind: 'note', summary: 'first summary',
      body_markdown: '## Details\n\nold detail line\n\n## More\n\nold more line\n' } };
    const captured = await captureLocal(c, { idempotency_key: randomUUID(), note: initial }, ground.deps);
    const path = ground.catalogue.getById(captured.id)?.path as string;
    const absolute = join(ground.vaultRoot, path);
    const { readFile } = await import('node:fs/promises');
    await writeFile(absolute, `${await readFile(absolute, 'utf8')}\n## Human notes\n\nmine stays\n`);
    await refresh(ground);
    const revise = async (body: string, summary: string): Promise<string> => {
      await reviewLocal(c, { operation: { action: 'revise', idempotency_key: randomUUID(), id: captured.id,
        expected_etag: ground.catalogue.getById(captured.id)?.etag as string, rationale: 'rewrite body',
        note: { ...initial, content: { kind: 'note', summary, body_markdown: body } } } }, ground.deps);
      await refresh(ground);
      return (await ground.store.readPath(path)).raw;
    };
    const first = await revise('## Fresh\n\nnew line\n', 'second summary');
    expect(first).toContain('new line');
    expect(first).toContain('mine stays');
    expect(first).not.toContain('old detail line');
    expect(first).not.toContain('old more line');
    expect(first).not.toContain('first summary');
    expect(first.match(/## Human notes/g)).toHaveLength(1);
    const second = await revise('## Final\n\nfinal line\n', 'third summary');
    expect(second).toContain('final line');
    expect(second).toContain('mine stays');
    expect(second).not.toContain('new line');
    expect(second).not.toContain('## Fresh');
    expect(second).not.toContain('second summary');
  } finally { await ground.dispose(); }
});

test('feedback and coordinated operations share one idempotency namespace in both orders and across restart', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const captured = await captureLocal(c, { idempotency_key: randomUUID(), note: note('Namespace note', 'first') }, ground.deps);
    const historicalRevision = captured.revision_id as string;
    await reviewLocal(c, { operation: { action: 'revise', idempotency_key: randomUUID(), id: captured.id,
      expected_etag: captured.etag as string, rationale: 'advance', note: note('Namespace note', 'second') } }, ground.deps);
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.revision_id).not.toBe(historicalRevision);
    const feedbackFor = (key: string, reason = 'historical was useful') => ({
      idempotency_key: key, id: captured.id, revision_id: historicalRevision, verdict: 'useful' as const, reason
    });

    const captureKey = randomUUID();
    const coordinated = await captureLocal(c, { idempotency_key: captureKey, note: note('Coordinated first', 'c') }, ground.deps);
    const ensureKey = randomUUID();
    const ensureRequest = { idempotency_key: ensureKey, remote_url: 'https://github.com/example/namespace.git' };
    const ensured = await projectEnsureLocal(c, ensureRequest, ground.deps);
    const reviewKey = randomUUID();
    const approveRequest = { operation: { action: 'approve' as const, idempotency_key: reviewKey, id: coordinated.id,
      expected_etag: coordinated.etag as string, rationale: 'approve coordinated' } };
    const approved = await reviewLocal(c, approveRequest, ground.deps);

    const feedbackKey = randomUUID();
    const recorded = await feedbackLocal(c, feedbackFor(feedbackKey), ground.deps);
    expect(ground.journal.getFeedback(recorded.feedback_id)?.revision_id).toBe(historicalRevision);

    const assertCollisions = async (): Promise<void> => {
      for (const key of [captureKey, ensureKey, reviewKey]) {
        await expect(feedbackLocal(c, feedbackFor(key), ground.deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        expect(ground.journal.idempotencyKeyProject(key)).toBeUndefined();
      }
      await expect(captureLocal(c, { idempotency_key: feedbackKey, note: note('Coordinated second', 'x') }, ground.deps))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(projectEnsureLocal(c, { ...ensureRequest, idempotency_key: feedbackKey }, ground.deps))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(reviewLocal(c, { operation: { ...approveRequest.operation, idempotency_key: feedbackKey } }, ground.deps))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(ground.operations.findByKey(feedbackKey)).toBeUndefined();
      const replay = await feedbackLocal(c, feedbackFor(feedbackKey), ground.deps);
      expect(replay).toEqual(recorded);
      expect(ground.journal.getFeedback(replay.feedback_id)?.revision_id).toBe(historicalRevision);
      await expect(feedbackLocal(c, feedbackFor(feedbackKey, 'different reason'), ground.deps))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await captureLocal(c, { idempotency_key: captureKey, note: note('Coordinated first', 'c') }, ground.deps))
        .toEqual(coordinated);
      expect(await projectEnsureLocal(c, ensureRequest, ground.deps)).toEqual(ensured);
      expect(await reviewLocal(c, approveRequest, ground.deps)).toEqual(approved);
    };
    await assertCollisions();
    await restartGround(ground);
    await assertCollisions();

    const lateKey = randomUUID();
    const late = await feedbackLocal(c, feedbackFor(lateKey, 'late'), ground.deps);
    await restartGround(ground);
    await expect(captureLocal(c, { idempotency_key: lateKey, note: note('After restart', 'y') }, ground.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await feedbackLocal(c, feedbackFor(lateKey, 'late'), ground.deps)).toEqual(late);
  } finally { await ground.dispose(); }
});
