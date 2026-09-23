import { expect, test } from 'vitest';
import { projectFilter, ProjectRegistry, type Project } from '../../src/projects/registry.js';

const projects: Project[] = [
  { id: 'freellmapi', display_name: 'freellmapi', relative_root: 'Projects/freellmapi', repository_identity: 'github.com/example/freellmapi' },
  { id: 'shared', display_name: 'Shared', relative_root: 'Shared' },
  { id: 'profile', display_name: 'Profile', relative_root: 'Profile' }
];

test('omitting a project means the whole brain, not a permission scope', () => {
  expect(projectFilter({})).toEqual({ mode: 'all' });
  expect(projectFilter({ project: 'second-brain' })).toEqual({
    mode: 'project', identifier: 'second-brain'
  });
  expect(projectFilter({ scope: 'second-brain' })).toEqual({
    mode: 'project', identifier: 'second-brain'
  });
  expect(projectFilter({ project: 'second-brain', scope: 'second-brain' })).toEqual({
    mode: 'project', identifier: 'second-brain'
  });
});

test('rejects conflicting aliases instead of guessing', () => {
  expect(() => projectFilter({ project: 'second-brain', scope: 'other-project' })).toThrow(
    /INVALID_INPUT/
  );
  expect(() => projectFilter({ project: '' })).toThrow(/INVALID_INPUT/);
  expect(() => projectFilter({ project: '../escape' })).toThrow(/INVALID_INPUT/);
  expect(() => projectFilter({ scope: 'project\\path' })).toThrow(/INVALID_INPUT/);
});

test('resolves stable IDs, repository identities and aliases to one project', () => {
  const registry = new ProjectRegistry(projects, [
    { identifier: 'free-llm-api', project_id: 'freellmapi' }
  ]);
  const expected = {
    id: 'freellmapi',
    display_name: 'freellmapi',
    relative_root: 'Projects/freellmapi',
    repository_identity: 'github.com/example/freellmapi'
  };
  expect(registry.get('freellmapi')).toEqual(expected);
  expect(registry.get('github.com/example/freellmapi')).toEqual(expected);
  expect(registry.get('free-llm-api')).toEqual(expected);
  expect(registry.get('unknown-project')).toBeUndefined();
  expect(() => registry.get('')).toThrow(/INVALID_INPUT/);
  expect(() => registry.get('a/../../b')).toThrow(/INVALID_INPUT/);
});

test('keeps display names as metadata rather than an implicit lookup key', () => {
  const registry = new ProjectRegistry([
    { id: 'project-a', display_name: 'readable-name', relative_root: 'Projects/a' }
  ]);
  expect(registry.get('project-a')).toEqual({
    id: 'project-a',
    display_name: 'readable-name',
    relative_root: 'Projects/a'
  });
  expect(registry.get('readable-name')).toBeUndefined();
});

test('rejects an alias or root that collides with a different project', () => {
  expect(
    () => new ProjectRegistry(projects, [{ identifier: 'shared', project_id: 'profile' }])
  ).toThrow(/CONFLICT/);
  expect(
    () =>
      new ProjectRegistry(projects, [{ identifier: 'profile', project_id: 'freellmapi' }])
  ).toThrow(/CONFLICT/);
  expect(
    () =>
      new ProjectRegistry([
        ...projects,
        { id: 'collision', display_name: 'Collision', relative_root: 'Shared' }
      ])
  ).toThrow(/CONFLICT/);
});

test('rejects duplicate identities registered with different metadata', () => {
  expect(
    () =>
      new ProjectRegistry([
        { id: 'project-a', display_name: 'A', relative_root: 'Projects/a' },
        { id: 'project-a', display_name: 'B', relative_root: 'Projects/b' }
      ])
  ).toThrow(/CONFLICT/);
});

test('all returns copies of the registered usable universe in registration order', () => {
  const registry = new ProjectRegistry(projects);
  expect(registry.all().map((project) => project.id)).toEqual(['freellmapi', 'shared', 'profile']);
  const first = registry.get('shared');
  if (first !== undefined) first.display_name = 'Mutated';
  expect(registry.get('shared')?.display_name).toBe('Shared');
});

test('retains known unusable projects for operational reporting', () => {
  const registry = new ProjectRegistry(projects, [], ['freellmapi']);
  expect(registry.all().map((project) => project.id)).toEqual(['shared', 'profile']);
  expect(registry.get('freellmapi')).toBeDefined();
  expect(registry.isUsable('freellmapi')).toBe(false);
  expect(registry.isUsable('shared')).toBe(true);
  expect(registry.unusableProjects().map((project) => project.id)).toEqual(['freellmapi']);
});
