import { expect, test } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';
import { Sync } from '../../src/index/sync.js';
import { Projects } from '../../src/projects.js';
import { recall } from '../../src/recall.js';
import { status } from '../../src/status.js';
import { Store } from '../../src/store.js';
import { VERSION } from '../../src/types.js';
import { Vault, sha256 } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

const note = (id: string, type: string, title: string, body: string): string =>
  `---\nid: ${id}\ntype: ${type}\ntags: [t]\n---\n\n# ${title}\n\n${body}\n`;

function setup() {
  const root = scratch('recall');
  const files = {
    'Projects/Second Brain/Second Brain.md': '---\ntype: project\nrepositories:\n  - github.com/a/b\n---\n# Second Brain\n',
    'Projects/Second Brain/budget.md': note('b1', 'lesson', 'Reranker budget', `## Situation\nbudget exceeded\n\n## Lesson\nbudget matters ${'x'.repeat(900)}`),
    'Projects/Second Brain/other.md': note('b2', 'decision', 'Other decision', 'the budget was mentioned once'),
    'Projects/Shared/shared.md': note('s1', 'playbook', 'Shared budget playbook', 'budget steps'),
    'Notes/loose.md': 'unrelated\n'
  };
  writeTree(root, files);
  const vault = new Vault(root);
  const index = SearchIndex.open(':memory:');
  const sync = new Sync(vault, index);
  sync.scan();
  const store = Store.open(':memory:');
  const projects = new Projects(vault);
  return { deps: { index, store, projects }, sync, store, files };
}

test('returns one item per note with its best chunk, bounded excerpt, and feedback', () => {
  const { deps } = setup();
  const { items } = recall(deps, { query: 'budget' });
  expect(items.map((item) => item.path).sort()).toEqual([
    'Projects/Second Brain/budget.md',
    'Projects/Second Brain/other.md',
    'Projects/Shared/shared.md'
  ]);
  expect(items.at(-1)?.path).toBe('Projects/Second Brain/other.md');
  expect(items.find((item) => item.id === 'b1')).toMatchObject({
    project: 'Second Brain', title: 'Reranker budget', type: 'lesson', tags: ['t'], feedback: {}, demoted: false
  });
  for (const item of items) expect(Array.from(item.excerpt).length).toBeLessThanOrEqual(600);
});

test('filters by project name or key, by type, and applies the limit', () => {
  const { deps } = setup();
  expect(recall(deps, { query: 'budget', project: 'shared' }).items.map((i) => i.path)).toEqual(['Projects/Shared/shared.md']);
  expect(recall(deps, { query: 'budget', project: 'Second Brain', types: ['decision'] }).items.map((i) => i.id)).toEqual(['b2']);
  expect(recall(deps, { query: 'budget', limit: 1 }).items).toHaveLength(1);
});

test('ranks demoted notes after all non-demoted matches until the note changes', () => {
  const { deps, store, files } = setup();
  const hash = sha256(files['Projects/Second Brain/budget.md']);
  store.addFeedback({ note_id: 'b1', verdict: 'incorrect', reason: null, note_hash: hash, created_at: 't' });
  const { items } = recall(deps, { query: 'budget' });
  expect(items.at(-1)).toMatchObject({ id: 'b1', demoted: true, feedback: { incorrect: 1 } });
  store.addFeedback({ note_id: 'b1', verdict: 'incorrect', reason: null, note_hash: 'older-hash', created_at: 't' });
  const after = recall(deps, { query: 'budget' }).items;
  expect(after.find((item) => item.id === 'b1')).toMatchObject({ demoted: false });
  expect(after.at(-1)?.path).toBe('Projects/Second Brain/other.md');
});

test('rejects queries without words and unknown projects', () => {
  const { deps } = setup();
  expect(() => recall(deps, { query: '*** ---' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => recall(deps, { query: 'budget', project: 'nope' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
});

test('status reports version, counts, projects, and problems', () => {
  const { deps, sync } = setup();
  expect(status({ index: deps.index, projects: deps.projects, sync })).toEqual({
    version: VERSION,
    notes: 4,
    projects: [
      { name: 'Second Brain', key: 'second-brain', repositories: ['github.com/a/b'], notes: 2 },
      { name: 'Shared', key: 'shared', repositories: [], notes: 1 }
    ],
    problems: []
  });
});
