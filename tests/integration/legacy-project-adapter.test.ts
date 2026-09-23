import { expect, test } from 'vitest';
import { Journal } from '../../src/storage/journal.js';
import {
  LegacyProjectAdapter,
  parseLegacyProvisioningPlan,
  projectEnsureReceipt
} from '../../src/storage/legacy-project-adapter.js';
import { createHarness } from '../support/harness.js';

const OPERATION_ID = '00000000-0000-4000-8000-0000000000d1';

test('converts a persisted project binding into the transitional legacy scope', async () => {
  const h = await createHarness();
  const journal = Journal.open(':memory:');
  try {
    journal.reserveProject({
      repository_identity: 'github.com/example/adapter',
      project_id: 'adapter',
      created_by_actor_id: 'actor-a',
      creation_operation_id: OPERATION_ID
    });
    journal.markProjectReady('github.com/example/adapter');
    const persisted = journal.getProjectById('adapter');
    if (persisted === undefined) throw new Error('missing persisted project');

    const adapter = new LegacyProjectAdapter({
      source: journal,
      backend: h.deps.backend,
      vault: h.deps.vault,
      catalogue: h.deps.catalogue
    });

    expect(adapter.binding('adapter')).toEqual({
      backend_project: 'adapter',
      backend_relative_root: 'Projects/adapter'
    });
    expect(adapter.scopeFor(persisted.project)).toEqual({
      id: 'adapter',
      backend_project: 'adapter',
      relative_root: 'Projects/adapter',
      repository_aliases: []
    });

    const ensured = await adapter.ensure(persisted.project);
    expect(ensured.created).toBe(true);
    expect(await adapter.verify(persisted.project)).toBe(true);
  } finally {
    journal.close();
    await h.close();
  }
});

test('reads an old provisioning plan without applying its grant', () => {
  const plan = JSON.stringify({
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    backend_project: 'legacy',
    relative_root: 'Projects/legacy',
    grant: {
      principal_id: 'legacy-worker',
      scope: 'legacy',
      can_read: true,
      can_write: true,
      can_review: false
    }
  });
  const parsed = parseLegacyProvisioningPlan({ plan_json: plan, operation_id: OPERATION_ID });
  expect(parsed).toEqual({
    repository_identity: 'github.com/example/legacy',
    project_id: 'legacy',
    display_name: 'legacy',
    relative_root: 'Projects/legacy',
    backend_project: 'legacy',
    backend_relative_root: 'Projects/legacy',
    created_by_actor_id: 'legacy-worker',
    creation_operation_id: OPERATION_ID
  });
  expect(parsed).not.toHaveProperty('grant');

  expect(() => parseLegacyProvisioningPlan({ plan_json: '{not json', operation_id: OPERATION_ID })).toThrow(
    /RECOVERY_REQUIRED/
  );
  expect(() => parseLegacyProvisioningPlan({ operation_id: OPERATION_ID })).toThrow(
    /RECOVERY_REQUIRED/
  );
});

test('projects a historical ensure receipt while dropping obsolete permissions', () => {
  const raw = JSON.stringify({
    operation_id: OPERATION_ID,
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    created: true,
    permissions: { can_read: true, can_write: true, can_review: true },
    backend_ready: true,
    materialized: true,
    warnings: ['one']
  });
  expect(projectEnsureReceipt(raw, OPERATION_ID)).toEqual({
    operation_id: OPERATION_ID,
    repository_identity: 'github.com/example/legacy',
    project_id: 'legacy',
    created: true,
    backend_ready: true,
    materialized: true,
    warnings: ['one']
  });
  expect(() => projectEnsureReceipt('{not json', OPERATION_ID)).toThrow(/RECOVERY_REQUIRED/);
});
