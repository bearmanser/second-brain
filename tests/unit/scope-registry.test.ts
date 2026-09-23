import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type {
  LegacyProjectBackendBinding,
  PersistedProject,
  ScopeConfig
} from '../../src/core/types.js';
import { ScopeRegistry, type ScopeRegistrySource } from '../../src/projects/scope-registry.js';
import { Journal } from '../../src/storage/journal.js';

const staticScopes: ScopeConfig[] = [
  { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'Projects/freellmapi', repository_aliases: ['free-api'] },
  { id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] },
  { id: 'profile', backend_project: 'profile', relative_root: 'Profile', repository_aliases: [] }
];

const readyProject = (overrides: Partial<PersistedProject> = {}): PersistedProject => ({
  project: {
    id: 'second-brain',
    display_name: 'second-brain',
    relative_root: 'Projects/second-brain',
    repository_identity: 'github.com/bearmanser/second-brain'
  },
  state: 'ready',
  provisioning: { created_by_actor_id: 'actor-a', creation_operation_id: 'operation-a' },
  updated_at: '2026-09-21T09:00:00.000Z',
  ...overrides
});

const sourceFrom = (
  projects: PersistedProject[],
  bindings: Record<string, LegacyProjectBackendBinding> = {}
): ScopeRegistrySource => ({
  listProjects: () => projects,
  getProjectBinding: (id) =>
    bindings[id] ?? { backend_project: id, backend_relative_root: `Projects/${id}` }
});

test('loads configured static projects and resolves their aliases', () => {
  const registry = new ScopeRegistry(staticScopes);
  expect(registry.all().map((scope) => scope.id)).toEqual(['freellmapi', 'shared', 'profile']);
  expect(registry.get('free-api')?.id).toBe('freellmapi');
  expect(registry.get('freellmapi')).toEqual({
    id: 'freellmapi',
    backend_project: 'freellmapi',
    relative_root: 'Projects/freellmapi',
    repository_aliases: []
  });
  expect(registry.get('unknown-project')).toBeUndefined();
});

test('merges persisted ready projects into one collision-checked namespace', () => {
  const registry = new ScopeRegistry(
    staticScopes,
    sourceFrom([readyProject()], {
      'second-brain': { backend_project: 'second-brain', backend_relative_root: 'Projects/second-brain' }
    })
  );
  expect(registry.all().map((scope) => scope.id)).toEqual([
    'freellmapi',
    'shared',
    'profile',
    'second-brain'
  ]);
  expect(registry.get('second-brain')).toMatchObject({
    id: 'second-brain',
    backend_project: 'second-brain',
    relative_root: 'Projects/second-brain'
  });
  expect(registry.get('github.com/bearmanser/second-brain')?.id).toBe('second-brain');
});

test('keeps static identifiers authoritative and rejects colliding aliases', () => {
  expect(
    () =>
      new ScopeRegistry([
        ...staticScopes,
        { id: 'other', backend_project: 'other', relative_root: 'Projects/other', repository_aliases: ['free-api'] }
      ])
  ).toThrow(/CONFLICT/);

  const registry = new ScopeRegistry(staticScopes);
  expect(() =>
    registry.registerReadyProject(
      readyProject({
        project: { id: 'shared', display_name: 'shared', relative_root: 'Projects/shared' }
      })
    )
  ).toThrow(/INVALID_INPUT/);
  expect(() =>
    registry.registerReadyProject(
      readyProject({
        project: { id: 'free-api', display_name: 'free-api', relative_root: 'Projects/free-api' }
      })
    )
  ).toThrow(/CONFLICT/);
});

test('registers only ready projects and rejects duplicates with different mappings', () => {
  const registry = new ScopeRegistry(staticScopes);
  expect(() => registry.registerReadyProject(readyProject({ state: 'provisioning' }))).toThrow(
    /INVALID_INPUT/
  );
  expect(() => registry.registerReadyProject(readyProject({ state: 'recovery_required' }))).toThrow(
    /INVALID_INPUT/
  );
  registry.registerReadyProject(readyProject());
  registry.registerReadyProject(readyProject());
  expect(() =>
    registry.registerReadyProject(
      readyProject({
        project: {
          id: 'second-brain',
          display_name: 'second-brain',
          relative_root: 'Projects/other-root'
        }
      })
    )
  ).toThrow(/CONFLICT/);
});

test('quarantined projects stay known but leave the usable universe', () => {
  const registry = new ScopeRegistry(staticScopes, sourceFrom([readyProject()]));
  registry.quarantineProject('second-brain');
  expect(registry.all().map((scope) => scope.id)).toEqual(['freellmapi', 'shared', 'profile']);
  expect(registry.get('second-brain')?.id).toBe('second-brain');
  expect(registry.isUsable('second-brain')).toBe(false);
  expect(registry.isUsable('freellmapi')).toBe(true);
  expect(registry.unusable().map((scope) => scope.id)).toEqual(['second-brain']);
});

test('does not expose a permission surface', () => {
  const registry = new ScopeRegistry(staticScopes);
  const members = Object.getOwnPropertyNames(Object.getPrototypeOf(registry));
  expect(members).not.toContain('permissions');
  expect(members).not.toContain('visibleTo');
  expect(members).not.toContain('registerGrant');
  expect(members).not.toContain('grantProject');
});

test('keeps a recovery-required project known but unusable after restart', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'scope-registry-recovery-'));
  const path = join(root, 'journal.db');
  try {
    const first = Journal.open(path);
    first.reserveProject({
      repository_identity: 'github.com/bearmanser/recovering',
      project_id: 'recovering',
      created_by_actor_id: 'actor-a',
      creation_operation_id: '00000000-0000-4000-8000-0000000000c2'
    });
    first.markProjectReady('github.com/bearmanser/recovering');
    first.markProjectRecoveryRequired('github.com/bearmanser/recovering', 'ready_verification', 'CONFLICT');
    first.close();

    const reopened = Journal.open(path, { requireExisting: true });
    const registry = new ScopeRegistry(staticScopes, reopened);
    expect(registry.get('recovering')).toMatchObject({ id: 'recovering' });
    expect(() => registry.require('recovering')).toThrow(/RECOVERY_REQUIRED/);
    expect(registry.all().map((scope) => scope.id)).not.toContain('recovering');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails rather than fabricating a backend project when a binding is missing', () => {
  const project = readyProject({
    project: { id: 'no-binding', display_name: 'no-binding', relative_root: 'Projects/no-binding' }
  });
  const source: ScopeRegistrySource = {
    listProjects: () => [project],
    getProjectBinding: () => undefined
  };
  const registry = new ScopeRegistry(staticScopes, source);
  expect(() => registry.get('no-binding')).toThrow(/RECOVERY_REQUIRED/);
});

test('reopening the journal returns the same stable project id and root without a grant', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'scope-registry-'));
  const path = join(root, 'journal.db');
  try {
    const first = Journal.open(path);
    first.reserveProject({
      repository_identity: 'github.com/bearmanser/second-brain',
      project_id: 'second-brain',
      created_by_actor_id: 'actor-a',
      creation_operation_id: '00000000-0000-4000-8000-0000000000c1'
    });
    first.markProjectReady('github.com/bearmanser/second-brain');
    first.close();

    const reopened = Journal.open(path, { requireExisting: true });
    const registry = new ScopeRegistry(staticScopes, reopened);
    expect(registry.get('github.com/bearmanser/second-brain')).toMatchObject({
      id: 'second-brain',
      backend_project: 'second-brain',
      relative_root: 'Projects/second-brain'
    });
    expect(registry.all().map((scope) => scope.id)).toContain('second-brain');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
