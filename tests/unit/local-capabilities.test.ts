import { expect, test } from 'vitest';
import { expectTypeOf } from 'vitest';
import type {
  LocalHandlerDeps,
  LocalMutationCoordinatorPort,
  ProjectResolutionPort,
  SourceBoundCursorPort,
  ProjectEnsureResult,
  ProjectEnsureResultV2,
  StatusResult,
  StatusResultV2
} from '../../src/core/types.js';

test('local handler dependencies expose the frozen capabilities', () => {
  expectTypeOf<LocalHandlerDeps['mutations']>().toEqualTypeOf<LocalMutationCoordinatorPort>();
  expectTypeOf<LocalHandlerDeps['projects']>().toEqualTypeOf<ProjectResolutionPort>();
  expectTypeOf<LocalHandlerDeps['cursors']>().toEqualTypeOf<SourceBoundCursorPort>();
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('documents');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('catalogue');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('index');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('journal');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('worker');
});

test('V2 public result shapes do not carry backend-specific fields', () => {
  expectTypeOf<ProjectEnsureResultV2>().not.toHaveProperty('backend_ready');
  expectTypeOf<StatusResultV2['health']>().not.toHaveProperty('backend');
  expectTypeOf<StatusResultV2['health']>().not.toHaveProperty('embeddings');
  expectTypeOf<StatusResultV2['health']>().toHaveProperty('index');
  expectTypeOf<StatusResultV2['health']>().toHaveProperty('worker');

  const ensure: ProjectEnsureResultV2 = {
    operation_id: 'op',
    repository_identity: 'github.com/example/repo',
    project_id: 'repo',
    relative_root: 'Projects/Repo',
    created: true,
    materialized: true,
    warnings: []
  };
  expect(ensure.project_id).toBe('repo');

  const status: StatusResultV2 = {
    version: '0.1.0',
    protocol_version: '2',
    schema_version: 1,
    protocol: 2,
    projects: [{ id: 'repo', display_name: 'Repo', relative_root: 'Projects/Repo', state: 'ready' }],
    health: { gateway: 'ready', index: 'ready', worker: 'disabled' },
    features: { reranking: false, text_search: true, fallback: true },
    pending_operations: 0
  };
  expect(status.health.index).toBe('ready');
});

test('the legacy result shapes keep their backend fields separate', () => {
  expectTypeOf<ProjectEnsureResult>().toHaveProperty('backend_ready');
  expectTypeOf<StatusResult['health']>().toHaveProperty('backend');
  expectTypeOf<StatusResult['health']>().toHaveProperty('embeddings');

  const legacyEnsure: ProjectEnsureResult = {
    operation_id: 'op',
    repository_identity: 'github.com/example/repo',
    scope: 'repo',
    created: true,
    backend_ready: true,
    materialized: true,
    warnings: []
  };
  expect(legacyEnsure.backend_ready).toBe(true);
  const legacyStatus: StatusResult = {
    version: '0.1.0',
    protocol_version: '1',
    schema_version: 1,
    scopes: [{ id: 'shared' }],
    health: { gateway: 'ready', backend: 'ready', embeddings: 'unknown' },
    pending_operations: 0
  };
  expect(legacyStatus.health.backend).toBe('ready');
});
