import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { BrainError } from '../../src/contracts/errors.js';
import { ensureProject } from '../../src/features/project-ensure.js';
import { scopeWithCollisionSuffix } from '../../src/projects/identity.js';
import { ownerContext, reviewerContext, workerContext } from '../fixtures/principals.js';
import { armFault, createHarness } from '../support/harness.js';

const request = (remote_url: string, idempotency_key = randomUUID()) => ({ idempotency_key, remote_url });

test.each([
  [workerContext, false],
  [reviewerContext, true],
  [ownerContext, true]
] as const)('provisions a ready project with role-matched access', async (ctx, canReview) => {
  const h = await createHarness();
  try {
    const remote = `https://github.com/example/project-${ctx.principal.role}.git`;
    const result = await ensureProject(ctx, request(remote), h.deps);
    expect(result).toMatchObject({ created: true, backend_ready: true, materialized: true });
    expect(result.permissions).toEqual({ can_read: true, can_write: true, can_review: canReview });
    expect(h.deps.journal.getProjectByIdentity(`github.com/example/project-${ctx.principal.role}`)?.state).toBe('ready');
    expect(h.deps.scopeRegistry.permissions(ctx.principal, result.scope)).toEqual(result.permissions);
  } finally { await h.close(); }
});

test('replays a completed ensure without a second backend call', async () => {
  const h = await createHarness();
  try {
    const input = request('https://github.com/bearmanser/second-brain.git');
    const first = await ensureProject(reviewerContext, input, h.deps);
    const calls = h.backend.call_count;
    const replay = await ensureProject(reviewerContext, input, h.deps);
    expect(replay).toEqual(first);
    expect(h.backend.call_count).toBe(calls);
  } finally { await h.close(); }
});

test('concurrent SSH and HTTPS spellings create one project and stable grants', async () => {
  const h = await createHarness();
  try {
    const before = h.backend.call_count;
    const [https, ssh] = await Promise.all([
      ensureProject(workerContext, request('https://github.com/bearmanser/second-brain.git'), h.deps),
      ensureProject(reviewerContext, request('git@github.com:bearmanser/second-brain.git'), h.deps)
    ]);
    expect(https.scope).toBe('second-brain');
    expect(ssh.scope).toBe('second-brain');
    expect([https.created, ssh.created].sort()).toEqual([false, true]);
    expect(h.backend.call_count - before).toBe(2);
    expect(h.deps.journal.listProjectGrants()).toHaveLength(2);
  } finally { await h.close(); }
});

test('uses deterministic suffixes for static collisions and rejects reserved repositories', async () => {
  const h = await createHarness();
  try {
    const identity = 'github.com/example/freellmapi';
    const result = await ensureProject(workerContext, request(`https://${identity}.git`), h.deps);
    expect(result.scope).toBe(scopeWithCollisionSuffix('freellmapi', identity));
    await expect(ensureProject(workerContext, request('https://github.com/example/shared.git'), h.deps))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally { await h.close(); }
});

test('enforces principal rate and persisted project-count limits', async () => {
  const h = await createHarness();
  try {
    h.deps.config.limits.project_provision_per_principal_per_minute = 2;
    await ensureProject(workerContext, request('https://github.com/example/one.git'), h.deps);
    await ensureProject(workerContext, request('https://github.com/example/two.git'), h.deps);
    await expect(ensureProject(workerContext, request('https://github.com/example/three.git'), h.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally { await h.close(); }

  const capped = await createHarness();
  try {
    capped.deps.config.limits.dynamic_projects_max = 1;
    await ensureProject(ownerContext, request('https://github.com/example/first.git'), capped.deps);
    await capped.restart();
    await expect(ensureProject(ownerContext, request('https://github.com/example/second.git'), capped.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally { await capped.close(); }
});

test('rejects the eleventh principal and fifty-first global ensure in one minute', async () => {
  const perPrincipal = await createHarness();
  try {
    for (let index = 0; index < 10; index += 1) {
      await ensureProject(workerContext, request(`https://github.com/rate/principal-${index}.git`), perPrincipal.deps);
    }
    await expect(ensureProject(workerContext, request('https://github.com/rate/principal-10.git'), perPrincipal.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally { await perPrincipal.close(); }

  const global = await createHarness();
  try {
    global.deps.config.limits.project_provision_per_principal_per_minute = 100;
    for (let index = 0; index < 50; index += 1) {
      const ctx = {
        ...workerContext,
        principal: { ...workerContext.principal, id: randomUUID() },
        request_id: randomUUID()
      };
      await ensureProject(ctx, request(`https://github.com/rate/global-${index}.git`), global.deps);
    }
    const finalCtx = {
      ...workerContext,
      principal: { ...workerContext.principal, id: randomUUID() },
      request_id: randomUUID()
    };
    await expect(ensureProject(finalCtx, request('https://github.com/rate/global-50.git'), global.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally { await global.close(); }
});

test('a second principal receives its own grant without recreating the project', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/shared-repository.git';
    await ensureProject(workerContext, request(remote), h.deps);
    const calls = h.backend.call_count;
    const reviewer = await ensureProject(reviewerContext, request(remote), h.deps);
    expect(reviewer.created).toBe(false);
    expect(reviewer.permissions.can_review).toBe(true);
    expect(h.backend.call_count).toBe(calls + 1);
    expect(h.deps.journal.listProjectGrants()).toHaveLength(2);
  } finally { await h.close(); }
});

test('resumes a submitted project after backend availability returns', async () => {
  const h = await createHarness();
  try {
    const input = request('https://github.com/example/recover-backend.git');
    h.backend.ensure_project_fail_once = true;
    await expect(ensureProject(workerContext, input, h.deps)).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    const [pending] = h.deps.journal.pending();
    expect(pending).toMatchObject({ tool: 'brain_project_ensure', state: 'submitted' });
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    expect(h.deps.journal.getProjectByIdentity('github.com/example/recover-backend')?.state).toBe('ready');
  } finally { await h.close(); }
});

test('recovers after project creation when grant persistence was interrupted', async () => {
  const h = await createHarness();
  try {
    const journal = h.deps.journal;
    const original = journal.grantProject.bind(journal);
    let fail = true;
    journal.grantProject = (grant) => {
      if (fail) { fail = false; throw new Error('injected grant interruption'); }
      return original(grant);
    };
    await expect(ensureProject(reviewerContext, request('https://github.com/example/recover-grant.git'), h.deps)).rejects.toThrow();
    expect(h.deps.journal.getProjectByIdentity('github.com/example/recover-grant')?.state).toBe('provisioning');
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    expect(h.deps.scopeRegistry.permissions(reviewerContext.principal, 'recover-grant').can_review).toBe(true);
  } finally { await h.close(); }
});

test('marks a mismatched backend mapping for explicit recovery', async () => {
  const h = await createHarness();
  try {
    h.backend.ensureProject = async () => {
      throw new BrainError({ code: 'BACKEND_PROTOCOL_ERROR', message: 'backend project response did not match' });
    };
    await expect(ensureProject(ownerContext, request('https://github.com/example/mismatch.git'), h.deps))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(h.deps.journal.getProjectByIdentity('github.com/example/mismatch')).toMatchObject({
      state: 'recovery_required', failure_stage: 'backend_verification', failure_code: 'BACKEND_PROTOCOL_ERROR'
    });
    expect(h.deps.scopeRegistry.get('mismatch')).toBeUndefined();
  } finally { await h.close(); }
});

test('quarantines a ready project that disappears before granting another principal', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/drifted-ready.git';
    const created = await ensureProject(workerContext, request(remote), h.deps);
    h.backend.removeProject(created.scope);
    await expect(ensureProject(reviewerContext, request(remote), h.deps))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(h.deps.journal.getProjectByIdentity('github.com/example/drifted-ready')).toMatchObject({
      state: 'recovery_required',
      failure_stage: 'ready_verification',
      failure_code: 'BACKEND_PROTOCOL_ERROR'
    });
    expect(h.deps.scopeRegistry.get(created.scope)).toBeUndefined();
    expect(h.deps.journal.listProjectGrants(reviewerContext.principal.id)).toEqual([]);
  } finally { await h.close(); }
});

test('lets an owner re-verify and repair a recovery-required project with a new operation', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/repairable.git';
    const originalEnsure = h.backend.ensureProject.bind(h.backend);
    h.backend.ensureProject = async () => {
      throw new BrainError({ code: 'BACKEND_PROTOCOL_ERROR', message: 'backend project response did not match' });
    };
    await expect(ensureProject(reviewerContext, request(remote), h.deps))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(h.deps.journal.getProjectByIdentity('github.com/example/repairable')?.state).toBe('recovery_required');

    h.backend.ensureProject = originalEnsure;
    await expect(ensureProject(reviewerContext, request(remote), h.deps))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const repaired = await ensureProject(ownerContext, request(remote), h.deps);
    expect(repaired).toMatchObject({ scope: 'repairable', backend_ready: true, materialized: true });
    expect(h.deps.journal.getProjectByIdentity('github.com/example/repairable')?.state).toBe('ready');
  } finally { await h.close(); }
});

test('recovers a ready project whose receipt commit was interrupted', async () => {
  const h = await createHarness();
  try {
    const input = request('https://github.com/example/recover-receipt.git');
    armFault(h, 'mark', { state: 'complete' });
    await expect(ensureProject(ownerContext, input, h.deps)).rejects.toThrow();
    expect(h.deps.journal.getProjectByIdentity('github.com/example/recover-receipt')?.state).toBe('ready');
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    const replay = await ensureProject(ownerContext, input, h.deps);
    expect(replay).toMatchObject({ created: false, backend_ready: true, materialized: true });
  } finally { await h.close(); }
});

test('reloads ready project mappings and grants after restart', async () => {
  const h = await createHarness();
  try {
    const created = await ensureProject(reviewerContext, request('https://github.com/example/restarted.git'), h.deps);
    await h.restart();
    expect(h.deps.scopeRegistry.get(created.scope)).toMatchObject({ relative_root: `Projects/${created.scope}` });
    expect(h.deps.scopeRegistry.permissions(reviewerContext.principal, created.scope)).toEqual(created.permissions);
  } finally { await h.close(); }
});

test('rejects reuse of one idempotency key for another normalized repository', async () => {
  const h = await createHarness();
  try {
    const key = randomUUID();
    await ensureProject(workerContext, request('https://github.com/example/alpha.git', key), h.deps);
    await expect(ensureProject(workerContext, request('https://github.com/example/beta.git', key), h.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await h.close(); }
});
