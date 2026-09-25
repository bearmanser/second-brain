import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Projects, normalizeRemote } from '../../src/projects.js';
import { Vault } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

const projectNote = (repos: string[], body = ''): string =>
  `---\ntype: project\nrepositories:${repos.length === 0 ? ' []' : repos.map((r) => `\n  - ${r}`).join('')}\n---\n\n${body}`;

function setup(files: Record<string, string>): { projects: Projects; root: string } {
  const root = scratch('projects');
  writeTree(root, { 'Projects/.keep/x.txt': '', ...files });
  return { projects: new Projects(new Vault(root)), root };
}

test('normalizes git remotes', () => {
  expect(normalizeRemote('https://github.com/bearmanser/second-brain.git')).toBe('github.com/bearmanser/second-brain');
  expect(normalizeRemote('git@github.com:Doccary/doccary.git')).toBe('github.com/Doccary/doccary');
  expect(normalizeRemote('ssh://git@GitHub.com:22/a/b')).toBe('github.com/a/b');
  expect(normalizeRemote('https://GitLab.example:8443/group/sub/repo')).toBe('gitlab.example:8443/group/sub/repo');
  for (const bad of ['', ' https://github.com/a/b', 'https://user:pw@github.com/a/b', 'https://user@github.com/a/b',
    'http://github.com/a/b', 'https://github.com/a/b?x=1', 'ftp://x/y', 'https://github.com/a/../b', 'root@host:a/b']) {
    expect(() => normalizeRemote(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
});

test('lists projects from folders and project notes', () => {
  const { projects } = setup({
    'Projects/Second Brain/Second Brain.md': projectNote(['github.com/bearmanser/second-brain'], '# Second Brain\n'),
    'Projects/Shared/lesson.md': '# L\n'
  });
  expect(projects.list()).toEqual([
    { name: 'Second Brain', key: 'second-brain', repositories: ['github.com/bearmanser/second-brain'],
      notePath: 'Projects/Second Brain/Second Brain.md', hasNote: true },
    { name: 'Shared', key: 'shared', repositories: [], notePath: 'Projects/Shared/Shared.md', hasNote: false }
  ]);
});

test('resolves by name or key and reports missing and ambiguous projects', () => {
  const { projects } = setup({ 'Projects/Second Brain/n.md': '', 'Projects/A B/n.md': '', 'Projects/a-b/n.md': '' });
  expect(projects.resolve('second brain').name).toBe('Second Brain');
  expect(projects.resolve('second-brain').name).toBe('Second Brain');
  expect(() => projects.resolve('nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(() => projects.resolve('a-b')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
});

test('ensure returns the project that already lists the remote', () => {
  const { projects } = setup({
    'Projects/Second Brain/Second Brain.md': projectNote(['github.com/bearmanser/second-brain'])
  });
  const result = projects.ensure('git@github.com:bearmanser/second-brain.git');
  expect(result).toMatchObject({ created: false, project: { name: 'Second Brain' } });
});

test('ensure creates a project folder and note for a new remote', () => {
  const { projects, root } = setup({});
  const result = projects.ensure('https://github.com/acme/widgets');
  expect(result).toMatchObject({ created: true, project: { name: 'widgets', key: 'widgets', repositories: ['github.com/acme/widgets'] } });
  expect(readFileSync(join(root, 'Projects/widgets/widgets.md'), 'utf8')).toBe(
    '---\ntype: project\nrepositories:\n  - github.com/acme/widgets\n---\n\n# widgets\n'
  );
});

test('ensure binds an unbound folder with the same name and keeps its note body', () => {
  const { projects, root } = setup({
    'Projects/doccary/doccary.md': projectNote([], '# doccary\n\nOverview.\n'),
    'Projects/plain/n.md': ''
  });
  expect(projects.ensure('https://github.com/x/doccary')).toMatchObject({ created: false });
  expect(readFileSync(join(root, 'Projects/doccary/doccary.md'), 'utf8')).toContain('Overview.');
  expect(projects.ensure('https://github.com/x/plain')).toMatchObject({ created: false, project: { hasNote: true } });
});

test('ensure adds a suffix when the same-named folder belongs to another remote', () => {
  const { projects } = setup({ 'Projects/api/api.md': projectNote(['github.com/one/api']) });
  expect(projects.ensure('https://github.com/two/api')).toMatchObject({ created: true, project: { name: 'api (2)' } });
});
