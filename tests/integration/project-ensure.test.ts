import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { BrainError } from '../../src/contracts/errors.js';
import { ensureProject } from '../../src/features/project-ensure.js';
import { scopeWithCollisionSuffix } from '../../src/projects/identity.js';
import { ownerContext, reviewerContext, workerContext } from '../fixtures/principals.js';
import { armFault, createHarness } from '../support/harness.js';

const request = (remote_url: string, idempotency_key = randomUUID()) => ({ idempotency_key, remote_url });
const keyFor = (remote: string): string => `github.com/example/${remote.replace(/\.git$/, '')}`;

test('provisions a ready project without a permission grant', async () => {
  const h = await createHarness();
  try {
    const result = await ensureProject(workerContext, request('https://github.com/example/project-a.git'), h.deps);
    expect(result).toMatchObject({ created: true, backend_ready: true, materialized: true });
    expect(result).not.toHaveProperty('permissions');
    expect(h.deps.journal.getProjectByIdentity(keyFor('project-a.git'))?.state).toBe('ready');
    expect(h.deps.journal.getProjectBinding(result.scope)).toEqual({
      backend_project: result.scope,
      backend_relative_root: `Projects/${result.scope}`
    });
  } finally {
    await h.close();
  }
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
  } finally {
    await h.close();
  }
});

test('concurrent SSH and HTTPS spellings create one project', async () => {
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
    expect(h.deps.journal.countProjects()).toBe(1);
  } finally {
    await h.close();
  }
});

test('uses deterministic suffixes for static collisions', async () => {
  const h = await createHarness();
  try {
    const identity = 'github.com/example/freellmapi';
    const result = await ensureProject(workerContext, request(`https://${identity}.git`), h.deps);
    expect(result.scope).toBe(scopeWithCollisionSuffix('freellmapi', identity));
  } finally {
    await h.close();
  }
});

test('enforces the global provisioning rate and persisted project-count limits', async () => {
  const capped = await createHarness();
  try {
    capped.deps.config.limits.dynamic_projects_max = 1;
    await ensureProject(ownerContext, request('https://github.com/example/first.git'), capped.deps);
    await capped.restart();
    await expect(ensureProject(ownerContext, request('https://github.com/example/second.git'), capped.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally {
    await capped.close();
  }

  const global = await createHarness();
  try {
    global.deps.config.limits.project_provision_global_per_minute = 3;
    for (let index = 0; index < 3; index += 1) {
      await ensureProject(workerContext, request(`https://github.com/rate/global-${index}.git`), global.deps);
    }
    await expect(ensureProject(workerContext, request('https://github.com/rate/global-4.git'), global.deps))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally {
    await global.close();
  }
});

test('resumes a submitted project after backend availability returns', async () => {
  const h = await createHarness();
  try {
    const input = request('https://github.com/example/recover-backend.git');
    h.backend.ensure_project_fail_once = true;
    await expect(ensureProject(workerContext, input, h.deps)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE'
    });
    const [pending] = h.deps.journal.pending();
    expect(pending).toMatchObject({ tool: 'brain_project_ensure', state: 'submitted' });
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    expect(h.deps.journal.getProjectByIdentity(keyFor('recover-backend.git'))?.state).toBe('ready');
  } finally {
    await h.close();
  }
});

test('marks a mismatched backend mapping for explicit recovery', async () => {
  const h = await createHarness();
  try {
    h.backend.ensureProject = async () => {
      throw new BrainError({ code: 'BACKEND_PROTOCOL_ERROR', message: 'backend project response did not match' });
    };
    await expect(ensureProject(ownerContext, request('https://github.com/example/mismatch.git'), h.deps))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(h.deps.journal.getProjectByIdentity(keyFor('mismatch.git'))).toMatchObject({
      state: 'recovery_required',
      provisioning: {
        failure_stage: 'backend_verification',
        failure_code: 'BACKEND_PROTOCOL_ERROR'
      }
    });
    expect(h.deps.scopeRegistry.get('mismatch')).toBeUndefined();
  } finally {
    await h.close();
  }
});

test('quarantines a ready project that disappears before another request', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/drifted-ready.git';
    const created = await ensureProject(workerContext, request(remote), h.deps);
    h.backend.removeProject(created.scope);
    await expect(ensureProject(reviewerContext, request(remote), h.deps)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
    expect(h.deps.journal.getProjectByIdentity(keyFor('drifted-ready.git'))).toMatchObject({
      state: 'recovery_required',
      provisioning: {
        failure_stage: 'ready_verification',
        failure_code: 'BACKEND_PROTOCOL_ERROR'
      }
    });
    expect(h.deps.scopeRegistry.isUsable(created.scope)).toBe(false);
  } finally {
    await h.close();
  }
});

test('repairs a recovery-required project through evidence-driven recovery', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/repairable.git';
    const originalEnsure = h.backend.ensureProject.bind(h.backend);
    h.backend.ensureProject = async () => {
      throw new BrainError({ code: 'BACKEND_PROTOCOL_ERROR', message: 'backend project response did not match' });
    };
    await expect(ensureProject(reviewerContext, request(remote), h.deps)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
    expect(h.deps.journal.getProjectByIdentity(keyFor('repairable.git'))?.state).toBe('recovery_required');

    h.backend.ensureProject = originalEnsure;
    await expect(ensureProject(reviewerContext, request(remote), h.deps)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    expect(h.deps.journal.getProjectByIdentity(keyFor('repairable.git'))?.state).toBe('ready');
  } finally {
    await h.close();
  }
});

test('recovers a ready project whose receipt commit was interrupted', async () => {
  const h = await createHarness();
  try {
    const input = request('https://github.com/example/recover-receipt.git');
    armFault(h, 'mark', { state: 'complete' });
    await expect(ensureProject(ownerContext, input, h.deps)).rejects.toThrow();
    expect(h.deps.journal.getProjectByIdentity(keyFor('recover-receipt.git'))?.state).toBe('ready');
    const report = await h.deps.mutations.recoverDetailed();
    expect(report.finalized).toBe(1);
    const replay = await ensureProject(ownerContext, input, h.deps);
    expect(replay).toMatchObject({ created: false, backend_ready: true, materialized: true });
  } finally {
    await h.close();
  }
});

test('reloads ready project mappings after restart', async () => {
  const h = await createHarness();
  try {
    const created = await ensureProject(reviewerContext, request('https://github.com/example/restarted.git'), h.deps);
    await h.restart();
    expect(h.deps.scopeRegistry.get(created.scope)).toMatchObject({
      relative_root: `Projects/${created.scope}`
    });
    expect(h.deps.scopeRegistry.isUsable(created.scope)).toBe(true);
  } finally {
    await h.close();
  }
});

test('rejects reuse of one idempotency key for another normalized repository', async () => {
  const h = await createHarness();
  try {
    const key = randomUUID();
    await ensureProject(workerContext, request('https://github.com/example/alpha.git', key), h.deps);
    await expect(ensureProject(workerContext, request('https://github.com/example/beta.git', key), h.deps))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally {
    await h.close();
  }
});
