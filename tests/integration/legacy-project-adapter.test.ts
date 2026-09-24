import { expect, test } from 'vitest';
import { Journal } from '../../src/storage/journal.js';
import {
  LegacyProjectAdapter,
  parseLegacyProvisioningPlan,
  projectEnsureReceipt
} from '../../src/storage/legacy-project-adapter.js';
import { createLegacyHarness } from '../support/harness.js';

const OPERATION_ID = '00000000-0000-4000-8000-0000000000d1';

test('converts a persisted project binding into the transitional legacy scope', async () => {
  const h = await createLegacyHarness();
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

  const missingGrant = JSON.stringify({
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    backend_project: 'legacy',
    relative_root: 'Projects/legacy'
  });
  expect(() => parseLegacyProvisioningPlan({ plan_json: missingGrant, operation_id: OPERATION_ID })).toThrow(
    /RECOVERY_REQUIRED/
  );

  const mismatchedGrant = JSON.stringify({
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    backend_project: 'legacy',
    relative_root: 'Projects/legacy',
    grant: { principal_id: 'legacy-worker', scope: 'other', can_read: true }
  });
  expect(() =>
    parseLegacyProvisioningPlan({ plan_json: mismatchedGrant, operation_id: OPERATION_ID })
  ).toThrow(/RECOVERY_REQUIRED/);

  const inconsistentRoot = JSON.stringify({
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    backend_project: 'other-backend',
    relative_root: 'Projects/legacy',
    grant: { principal_id: 'legacy-worker', scope: 'legacy', can_read: true }
  });
  expect(() =>
    parseLegacyProvisioningPlan({ plan_json: inconsistentRoot, operation_id: OPERATION_ID })
  ).toThrow(/RECOVERY_REQUIRED/);
});

test.each(['can_write', 'can_review'] as const)(
  'rejects a legacy grant when only %s is missing',
  (missing) => {
    const grant: Record<string, unknown> = {
      principal_id: 'legacy-worker', scope: 'legacy',
      can_read: true, can_write: true, can_review: false
    };
    delete grant[missing];
    const plan_json = JSON.stringify({
      repository_identity: 'github.com/example/legacy', scope: 'legacy',
      backend_project: 'legacy', relative_root: 'Projects/legacy', grant
    });
    expect(() => parseLegacyProvisioningPlan({ plan_json, operation_id: OPERATION_ID })).toThrow(
      /RECOVERY_REQUIRED/
    );
  }
);

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

test('rejects a project receipt that names a different operation', () => {
  const raw = JSON.stringify({
    operation_id: '00000000-0000-4000-8000-0000000000e1',
    repository_identity: 'github.com/example/legacy',
    scope: 'legacy',
    created: true,
    backend_ready: true,
    materialized: true,
    warnings: []
  });
  expect(() => projectEnsureReceipt(raw, OPERATION_ID)).toThrow(/RECOVERY_REQUIRED/);
});

test('uses the persisted backend binding when four identifiers all differ', async () => {
  const journal = Journal.open(':memory:');
  const ensureCalls: [string, string][] = [];
  const verifyCalls: [string, string][] = [];
  const registered: string[] = [];
  const backend = {
    connect: async () => undefined,
    probe: async () => ({ server_version: 'test', tools: [] }),
    registerScope: () => undefined,
    verifyProject: async (project: string, path: string) => {
      verifyCalls.push([project, path]);
      return true;
    },
    ensureProject: async (project: string, path: string) => {
      ensureCalls.push([project, path]);
      return { created: true };
    },
    create: async () => ({ permalink: '' }),
    search: async () => ({ hits: [], has_more: false }),
    isIndexed: async () => true,
    close: async () => undefined
  };
  const vault = {
    registerScope: (scope: { relative_root: string }) => {
      registered.push(scope.relative_root);
    },
    list: async () => [],
    read: async () => {
      throw new Error('unused');
    },
    scan: async () => ({ managed: [], unmanaged: [] })
  };
  const catalogue = { registerScope: () => undefined };
  try {
    journal.reserveProject({
      repository_identity: 'github.com/example/four-way',
      project_id: 'four-way-id',
      display_name: 'Four Way Display',
      relative_root: 'Knowledge/Four',
      backend_project: 'legacy-backend',
      backend_relative_root: 'Backends/four',
      created_by_actor_id: 'actor-a',
      creation_operation_id: '00000000-0000-4000-8000-0000000000e2'
    });
    journal.markProjectReady('github.com/example/four-way');
    const persisted = journal.getProjectById('four-way-id');
    if (persisted === undefined) throw new Error('missing persisted project');
    const adapter = new LegacyProjectAdapter({
      source: journal,
      backend: backend as never,
      vault: vault as never,
      catalogue: catalogue as never
    });
    expect(adapter.scopeFor(persisted.project)).toEqual({
      id: 'four-way-id',
      backend_project: 'legacy-backend',
      relative_root: 'Knowledge/Four',
      repository_aliases: []
    });
    expect(await adapter.ensure(persisted.project)).toEqual({ created: true });
    expect(ensureCalls[0]).toEqual(['legacy-backend', '/app/data/Backends/four']);
    expect(await adapter.verify(persisted.project)).toBe(true);
    expect(verifyCalls[0]).toEqual(['legacy-backend', '/app/data/Backends/four']);
    expect(registered).toContain('Knowledge/Four');
  } finally {
    journal.close();
  }
});
