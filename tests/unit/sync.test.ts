import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';
import { Sync } from '../../src/index/sync.js';
import { Vault } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

function setup(files: Record<string, string>): { sync: Sync; index: SearchIndex; root: string } {
  const root = scratch('sync');
  writeTree(root, files);
  const index = SearchIndex.open(':memory:');
  return { sync: new Sync(new Vault(root), index), index, root };
}

test('indexes notes, skips project notes, and derives titles and projects', () => {
  const { sync, index } = setup({
    'Projects/Second Brain/Second Brain.md': '---\ntype: project\nrepositories: []\n---\n# Second Brain\n',
    'Projects/Second Brain/a.md': '---\nid: a1\ntype: lesson\ntags: [x]\n---\n# Alpha lesson\n\nbody words\n',
    'Notes/untitled draft.md': 'no heading here\n'
  });
  sync.scan();
  expect(index.all().map((n) => [n.path, n.title, n.project, n.type, n.id])).toEqual([
    ['Notes/untitled draft.md', 'untitled draft', null, 'note', null],
    ['Projects/Second Brain/a.md', 'Alpha lesson', 'Second Brain', 'lesson', 'a1']
  ]);
  expect(index.search('words', {}, 10)[0].path).toBe('Projects/Second Brain/a.md');
  expect(sync.problems()).toEqual([]);
});

test('picks up external edits and deletions on the next scan', () => {
  const { sync, index, root } = setup({ 'Notes/a.md': '# A\n\nold text\n', 'Notes/b.md': '# B\n' });
  sync.scan();
  writeFileSync(join(root, 'Notes/a.md'), '# A\n\nnew content here\n');
  utimesSync(join(root, 'Notes/a.md'), new Date(), new Date(Date.now() + 5000));
  rmSync(join(root, 'Notes/b.md'));
  sync.scan();
  expect(index.search('new', {}, 10)).toHaveLength(1);
  expect(index.search('old', {}, 10)).toHaveLength(0);
  expect(index.get('Notes/b.md')).toBeUndefined();
});

test('reports broken frontmatter and misplaced project notes, and clears fixed problems', () => {
  const { sync, index, root } = setup({
    'Notes/broken.md': '---\nid: [oops\n---\n# Broken\n',
    'Notes/fake project.md': '---\ntype: project\n---\n# Fake\n'
  });
  sync.scan();
  expect(index.all()).toEqual([]);
  expect(sync.problems().map((p) => p.path)).toEqual(['Notes/broken.md', 'Notes/fake project.md']);
  expect(sync.problems()[1].problem).toMatch(/Projects\/<Name>\/<Name>\.md/);
  writeFileSync(join(root, 'Notes/broken.md'), '---\nid: fixed\n---\n# Broken\n');
  sync.scan();
  expect(sync.problems().map((p) => p.path)).toEqual(['Notes/fake project.md']);
  expect(index.get('Notes/broken.md')?.id).toBe('fixed');
});

test('reports duplicate ids on every path that shares them', () => {
  const { sync } = setup({ 'Notes/a.md': '---\nid: same\n---\n# A\n', 'Notes/b.md': '---\nid: same\n---\n# B\n' });
  sync.scan();
  expect(sync.problems()).toEqual([
    { path: 'Notes/a.md', problem: 'duplicate id same (also: Notes/b.md)' },
    { path: 'Notes/b.md', problem: 'duplicate id same (also: Notes/a.md)' }
  ]);
});

test('indexFile removes paths that no longer exist', () => {
  const { sync, index, root } = setup({ 'Notes/a.md': '# A\n' });
  sync.scan();
  rmSync(join(root, 'Notes/a.md'));
  sync.indexFile('Notes/a.md');
  expect(index.get('Notes/a.md')).toBeUndefined();
});
