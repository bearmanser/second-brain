import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { InstanceLock, type RevisionBuilder } from '../../src/core/mutation.js';
import type { RequestContext, StoredRevision } from '../../src/core/types.js';
import { makeEtag, renderRevision } from '../../src/notes/codec.js';
import { relativePathFor } from '../../src/notes/identity.js';
import { lessonFixture } from '../fixtures/content.js';
import {
  reviewerContext,
  reviewerPrincipal,
  scopeFixtures,
  workerPrincipal
} from '../fixtures/principals.js';
import { armFault, createCandidateIntent, createHarness } from '../support/harness.js';

function contextWith(signal: AbortSignal): RequestContext {
  return { principal: reviewerPrincipal, request_id: randomUUID(), signal };
}

test('reconciles a materialized revision after a lost response', async () => {
  const h = await createHarness();
  h.backend.fail_once = 'after_write';
  const request = createCandidateIntent(lessonFixture);
  const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(['pending', 'stored']).toContain(first.outcome);
  await h.restart();
  const replay = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(replay.id).toBe(first.id);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('authorizes the write scope before reserving any operation', async () => {
  const h = await createHarness();
  const denied: RequestContext = {
    principal: { ...workerPrincipal, write_scopes: [] },
    request_id: randomUUID(),
    signal: new AbortController().signal
  };
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await expect(
    h.deps.mutations.commit(denied, request.intent, request.build)
  ).rejects.toThrow(/FORBIDDEN/);
  expect(h.deps.journal.pending()).toHaveLength(0);
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('rejects a revision whose builder forges an allocated identity', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const forged: RevisionBuilder = (identities, heads) => ({
    ...request.build(identities, heads),
    revision_id: randomUUID()
  });
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, forged)
  ).rejects.toThrow(/INVALID_INPUT/);
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('fails before reserve without recording an operation', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  armFault(h, 'reserve');
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/injected fault at reserve/);
  expect(h.deps.journal.pending()).toHaveLength(0);
  expect(h.backend.create_calls).toHaveLength(0);
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('recovers an operation that failed after reserve but before submission', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  armFault(h, 'save_plan');
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/injected fault at save_plan/);
  expect(h.deps.journal.pending()).toHaveLength(1);
  expect(h.backend.create_calls).toHaveLength(0);
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('recovers an operation that failed before submission', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  armFault(h, 'mark', { state: 'submitted' });
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/injected fault at mark/);
  expect(h.backend.create_calls).toHaveLength(0);
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('reconciles a lost write that failed after materialization', async () => {
  const h = await createHarness();
  h.backend.fail_once = 'after_write';
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  expect(receipt.materialized).toBe(true);
  expect(h.backend.create_calls).toHaveLength(1);
  const record = h.deps.journal.get(receipt.operation_id);
  expect(record?.state).toBe('complete');
  await h.close();
});

test('finalizes a materialized operation when receipt persistence fails', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  armFault(h, 'mark', { state: 'complete' });
  const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(first.outcome).toBe('stored');
  expect(first.materialized).toBe(true);
  expect(h.deps.journal.get(first.operation_id)?.state).toBe('materialized');
  await h.deps.mutations.recover();
  expect(h.deps.journal.get(first.operation_id)?.state).toBe('complete');
  const replay = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(replay.revision_id).toBe(first.revision_id);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('stores a verified revision and reports indexing separately', async () => {
  const h = await createHarness();
  h.backend.fail_once = 'search_unavailable';
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  expect(receipt.materialized).toBe(true);
  expect(receipt.indexed).toBe(false);
  expect(receipt.warnings).toContain('index_unavailable');
  await h.close();
});

test('treats a disk-full plan failure as recoverable and writes nothing', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const full = Object.assign(new Error('SQLITE_FULL: database or disk is full'), {
    code: 'SQLITE_FULL'
  });
  armFault(h, 'save_plan', { error: full });
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/SQLITE_FULL/);
  expect(h.backend.create_calls).toHaveLength(0);
  expect(h.deps.journal.pending()).toHaveLength(1);
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  await h.close();
});

test('conflicts when the expected head etag changed before submission', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const request = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: [{ id: head.source.id, etag: head.source.etag }]
  });
  await h.externalEdit(head, (raw) => raw.replace('Compare direct and proxied TTFT', 'Compare only the proxy'));
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/CONFLICT/);
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('serializes two agents that update the same expected etag', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const expected = [{ id: head.source.id, etag: head.source.etag }];
  const left = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: expected
  });
  const right = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: expected
  });
  const results = await Promise.allSettled([
    h.deps.mutations.commit(reviewerContext, left.intent, left.build),
    h.deps.mutations.commit(reviewerContext, right.intent, right.build)
  ]);
  const stored = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(stored).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/CONFLICT/);
  expect(h.backend.create_calls).toHaveLength(1);
  expect((await h.deps.vault.list('freellmapi')).length).toBe(2);
  await h.close();
});

test('keeps same-key concurrent requests idempotent with one backend write', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture);
  const [first, second] = await Promise.all([
    h.deps.mutations.commit(reviewerContext, request.intent, request.build),
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ]);
  expect(second.operation_id).toBe(first.operation_id);
  expect(second.id).toBe(first.id);
  expect(second.revision_id).toBe(first.revision_id);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('stores a different-key submission of the same note without overwriting', async () => {
  const h = await createHarness();
  const first = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const second = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const a = await h.deps.mutations.commit(reviewerContext, first.intent, first.build);
  const b = await h.deps.mutations.commit(reviewerContext, second.intent, second.build);
  expect(a.id).not.toBe(b.id);
  expect(h.backend.create_calls).toHaveLength(2);
  expect((await h.deps.vault.list('freellmapi')).length).toBe(2);
  await h.close();
});

test('rejects a missing parent without writing', async () => {
  const h = await createHarness();
  const request = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: [{ id: randomUUID(), etag: 'a'.repeat(64) }]
  });
  await expect(
    h.deps.mutations.commit(reviewerContext, request.intent, request.build)
  ).rejects.toThrow(/CONFLICT/);
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('retains both files when a manual edit races materialization', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const request = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: [{ id: head.source.id, etag: head.source.etag }]
  });
  h.backend.on_create = async () => {
    await h.externalEdit(head, (raw) =>
      raw.replace('Compare direct and proxied TTFT', 'Compare only the proxy')
    );
  };
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored_conflict');
  expect(receipt.materialized).toBe(true);
  expect(receipt.warnings).toContain('parent_changed');
  expect((await h.deps.vault.list('freellmapi')).length).toBe(2);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('resolves a revision fork without deleting either retained revision', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'active' });
  const scope = scopeFixtures[0];
  const base = root.revision;
  const child = async (suffix: string): Promise<{ revision: StoredRevision; etag: string }> => {
    const revisionId = randomUUID();
    const revision: StoredRevision = {
      ...base,
      revision_id: revisionId,
      parents: [{ revision_id: base.revision_id, raw_hash: root.raw_hash }],
      status: 'candidate',
      note: { ...lessonFixture, title: `${lessonFixture.title} ${suffix}` },
      operation_id: randomUUID(),
      approval: undefined
    };
    const relative = relativePathFor(
      scope.relative_root,
      lessonFixture.content.kind,
      base.id,
      revision.note.title,
      revisionId
    );
    const absolute = join(h.deps.config.mounts.vault, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, renderRevision(revision, scope), 'utf8');
    const read = await h.deps.vault.read(scope.id, relative);
    return { revision, etag: makeEtag(revisionId, read.raw_hash) };
  };
  const left = await child('left');
  const right = await child('right');
  await h.deps.catalogue.reconcile('freellmapi');
  await expect(h.deps.catalogue.get('freellmapi', base.id)).rejects.toThrow(/CONFLICT/);

  const request = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: [
      { id: base.id, revision_id: left.revision.revision_id, etag: left.etag },
      { id: base.id, revision_id: right.revision.revision_id, etag: right.etag }
    ]
  });
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored');
  const head = await h.deps.catalogue.get('freellmapi', base.id);
  expect(head.revision.revision_id).toBe(receipt.revision_id);
  expect((await h.deps.vault.list('freellmapi')).length).toBe(4);
  await h.close();
});

test('performs no write when the caller cancels before reservation', async () => {
  const h = await createHarness();
  const controller = new AbortController();
  controller.abort();
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  await expect(
    h.deps.mutations.commit(contextWith(controller.signal), request.intent, request.build)
  ).rejects.toThrow(/CANCELLED/);
  expect(h.deps.journal.pending()).toHaveLength(0);
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('retains data when the caller cancels after submission', async () => {
  const h = await createHarness();
  const controller = new AbortController();
  h.backend.on_create = () => {
    controller.abort();
  };
  const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
  const receipt = await h.deps.mutations.commit(
    contextWith(controller.signal),
    request.intent,
    request.build
  );
  expect(receipt.outcome).toBe('stored');
  expect(receipt.materialized).toBe(true);
  expect((await h.deps.vault.list('freellmapi')).length).toBe(1);
  expect(h.backend.create_calls).toHaveLength(1);
  await h.close();
});

test('a second gateway writer sharing the state directory fails its instance lock', async () => {
  const h = await createHarness();
  expect(() => InstanceLock.acquire(h.deps.config.mounts.state)).toThrow(/CONFLICT/);
  await h.close();
});

test('a second gateway writer sharing the same vault fails its instance lock', async () => {
  const h = await createHarness();
  expect(() =>
    InstanceLock.acquire(h.deps.config.mounts.vault, '.brain-instance.lock')
  ).toThrow(/CONFLICT/);
  await h.close();
});

test('releases the instance locks when the gateway closes', async () => {
  const h = await createHarness();
  const stateDir = h.deps.config.mounts.state;
  const vaultDir = h.deps.config.mounts.vault;
  await h.close();
  const stateLock = InstanceLock.acquire(stateDir);
  const vaultLock = InstanceLock.acquire(vaultDir, '.brain-instance.lock');
  stateLock.release();
  vaultLock.release();
});
