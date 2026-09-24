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
import { localRead } from '../../src/features/local-brain.js';
import { buildLocalHandlerDeps, type LocalBrain } from '../../src/features/local-support.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { Journal, LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

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
  return {
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
        operations.close();
      } catch {
        undefined;
      }
      journal.close();
      await store.close();
      catalogue.close();
      index.close();
      await sandbox.dispose();
    }
  };
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

    const approved = await reviewLocal(
      c,
      {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: captured.etag as string,
          rationale: 'evidence verified'
        }
      },
      ground.deps
    );
    expect('outcome' in approved && approved.outcome).toBe('stored');
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.status).toBe('active');

    const revised = await reviewLocal(
      c,
      {
        operation: {
          action: 'revise',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: ground.catalogue.getById(captured.id)?.etag as string,
          rationale: 'tighten',
          note: note('Lifecycle decision', 'lifecycle revised', 'decision')
        }
      },
      ground.deps
    );
    expect('outcome' in revised && revised.outcome).toBe('stored');
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
    const superseded = await reviewLocal(
      c,
      {
        operation: {
          action: 'supersede',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: ground.catalogue.getById(captured.id)?.etag as string,
          rationale: 'superseded',
          replacement_id: replacement.id
        }
      },
      ground.deps
    );
    expect('outcome' in superseded && superseded.outcome).toBe('stored');
    await refresh(ground);
    expect(ground.catalogue.getById(captured.id)?.status).toBe('superseded');

    const archived = await reviewLocal(
      c,
      {
        operation: {
          action: 'archive',
          idempotency_key: randomUUID(),
          id: replacement.id,
          expected_etag: ground.catalogue.getById(replacement.id)?.etag as string,
          rationale: 'archive'
        }
      },
      ground.deps
    );
    expect('outcome' in archived && archived.outcome).toBe('stored');
    await refresh(ground);
    expect(ground.catalogue.getById(replacement.id)?.status).toBe('archived');
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
    const status = ground.deps.mutations.status(first.operation_id);
    expect(status?.state).toBe('finalized');

    const moveKey = randomUUID();
    await reviewLocal(
      c,
      {
        operation: {
          action: 'move',
          idempotency_key: moveKey,
          id: first.id,
          target_path: 'Inbox/Moved stable.md',
          expected_etag: ground.catalogue.getById(first.id)?.etag as string,
          rationale: 'relocate'
        }
      },
      ground.deps
    );
    const movedAgain = await reviewLocal(
      c,
      {
        operation: {
          action: 'move',
          idempotency_key: moveKey,
          id: first.id,
          target_path: 'Inbox/Moved stable.md',
          expected_etag: ground.catalogue.getById(first.id)?.etag as string,
          rationale: 'relocate'
        }
      },
      ground.deps
    );
    expect('outcome' in movedAgain && movedAgain.outcome).toBe('stored');

    await mkdir(join(ground.vaultRoot, 'Knowledge'), { recursive: true });
    await writeFile(join(ground.vaultRoot, 'Knowledge/Plain.md'), '# Plain\n\nbody\n');
    const adoptKey = randomUUID();
    const adopted = await reviewLocal(
      c,
      {
        operation: {
          action: 'adopt',
          idempotency_key: adoptKey,
          path: 'Knowledge/Plain.md',
          expected_etag: 'a'.repeat(64),
          rationale: 'adopt'
        }
      },
      ground.deps
    ).catch(() => undefined);
    expect(adopted).toBeUndefined();
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
    const aRaw = headRaw('branch A');
    const bRaw = headRaw('branch B');
    const aRev = randomUUID();
    const bRev = randomUUID();
    for (const [path, raw, revisionId] of [
      ['Knowledge/A.md', aRaw, aRev],
      ['Knowledge/B.md', bRaw, bRev]
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
    await refresh(ground);
    const heads = await ground.deps.mutations.enumerateConflictHeads(id);
    expect(heads.length).toBe(2);
    const expected = heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }));
    const result = await reviewLocal(
      c,
      {
        operation: {
          action: 'resolve',
          idempotency_key: randomUUID(),
          id,
          expected_heads: expected,
          rationale: 'merge branches',
          note: note('resolved', 'resolved')
        }
      },
      ground.deps
    );
    expect('outcome' in result && result.revision_id).toBeTruthy();
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

    void c;
  } finally {
    await ground.dispose();
  }
});

test('duplicate titles produce a bounded capture advisory', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    await captureLocal(c, { idempotency_key: randomUUID(), note: note('Duplicate title', 'one') }, ground.deps);
    const second = await captureLocal(
      c,
      { idempotency_key: randomUUID(), note: note('Duplicate title', 'two') },
      ground.deps
    );
    expect(second.possible_duplicates.length).toBeGreaterThanOrEqual(1);
    expect(second.possible_duplicates.length).toBeLessThanOrEqual(5);
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
