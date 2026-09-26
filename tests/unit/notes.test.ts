import { existsSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SearchIndex } from '../../src/index/search-index.js';
import { Sync } from '../../src/index/sync.js';
import { Notes } from '../../src/notes.js';
import { Projects } from '../../src/projects.js';
import { Store } from '../../src/store.js';
import { Vault, sha256 } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

const NOW = new Date('2026-09-25T12:00:00.000Z');

function setup(files: Record<string, string> = {}) {
  const root = scratch('notes');
  writeTree(root, { 'Projects/Doccary/Doccary.md': '---\ntype: project\nrepositories: []\n---\n\n# Doccary\n', ...files });
  const vault = new Vault(root);
  const index = SearchIndex.open(':memory:');
  const sync = new Sync(vault, index);
  const store = Store.open(':memory:');
  let counter = 0;
  const notes = new Notes({
    vault, index, sync, store, projects: new Projects(vault),
    now: () => NOW, newId: () => `id-${++counter}`
  });
  sync.scan();
  const file = (path: string): string => readFileSync(join(root, path), 'utf8');
  return { notes, index, store, root, file };
}

test('captures a note into its project folder and indexes it', () => {
  const { notes, index, file } = setup();
  const result = notes.capture({ title: 'Token audit: parent/worker', body: 'Findings.', type: 'fact', tags: ['sec'], project: 'doccary' });
  expect(result).toEqual({ id: 'id-1', path: 'Projects/Doccary/Token audit parent worker.md', hash: sha256(file(result.path)) });
  expect(file(result.path)).toBe(
    '---\nid: id-1\ntype: fact\ntags:\n  - sec\ncreated: 2026-09-25T12:00:00.000Z\nupdated: 2026-09-25T12:00:00.000Z\n---\n\n# Token audit: parent/worker\n\nFindings.\n'
  );
  expect(index.get(result.path)).toMatchObject({ id: 'id-1', project: 'Doccary', type: 'fact' });
});

test('captures without a project into Notes/ and suffixes collisions, including the project note name', () => {
  const { notes } = setup();
  expect(notes.capture({ title: 'Loose', body: '' }).path).toBe('Notes/Loose.md');
  expect(notes.capture({ title: 'Loose', body: '' }).path).toBe('Notes/Loose (2).md');
  expect(notes.capture({ title: 'Doccary', body: '', project: 'Doccary' }).path).toBe('Projects/Doccary/Doccary (2).md');
});

test('rejects invalid captures', () => {
  const { notes } = setup();
  expect(() => notes.capture({ title: 'x', body: '# Heading first' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.capture({ title: 'two\nlines', body: '' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.capture({ title: '   ', body: '' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.capture({ title: 'x', body: '', project: 'missing' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(() => notes.capture({ title: 'x', body: 'y'.repeat(70_000) })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  expect(() => notes.capture({ title: 'x', body: '', tags: [''] })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('capture is idempotent per key and payload', () => {
  const { notes, root, store } = setup();
  const first = notes.capture({ title: 'Once', body: 'b', idempotency_key: 'key-00001' });
  const again = notes.capture({ title: 'Once', body: 'b', idempotency_key: 'key-00001' });
  expect(again).toEqual(first);
  expect(existsSync(join(root, 'Notes/Once (2).md'))).toBe(false);
  expect(() => notes.capture({ title: 'Different', body: 'b', idempotency_key: 'key-00001' }))
    .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  const payload = sha256(JSON.stringify({ title: 'Crashed', body: 'c', type: 'note', tags: [], project: null }));
  store.reserveIdempotency({ key: 'key-00002', payload_hash: payload, note_id: 'reserved-id', path: 'Notes/Crashed.md', created_at: 'x' });
  expect(notes.capture({ title: 'Crashed', body: 'c', idempotency_key: 'key-00002' })).toMatchObject({ id: 'reserved-id', path: 'Notes/Crashed.md' });
});

test('update checks the hash, rewrites fields, renames, moves, and preserves unknown keys', () => {
  const { notes, file, root } = setup({ 'Projects/Shared/.keep/x': '' });
  const created = notes.capture({ title: 'Plan', body: 'v1', tags: ['a'], project: 'Doccary' });
  writeFileSync(join(root, created.path), file(created.path).replace('---\nid:', '---\nsource: clip\nid:'));
  const current = sha256(file(created.path));
  expect(() => notes.update({ id: created.id, expected_hash: created.hash, body: 'v2' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  const renamed = notes.update({ id: created.id, expected_hash: current, title: 'Plan revised', body: 'v2' });
  expect(renamed.path).toBe('Projects/Doccary/Plan revised.md');
  expect(existsSync(join(root, created.path))).toBe(false);
  expect(file(renamed.path)).toContain('source: clip');
  expect(file(renamed.path)).toContain('created: 2026-09-25T12:00:00.000Z');
  const moved = notes.update({ id: created.id, expected_hash: renamed.hash, project: 'shared' });
  expect(moved.path).toBe('Projects/Shared/Plan revised.md');
  expect(() => notes.update({ id: created.id, expected_hash: moved.hash })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.update({ path: 'Projects/Doccary/Doccary.md', expected_hash: 'x'.repeat(64), body: 'b' }))
    .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
});

test('update gives hand-written notes an id and title without losing content', () => {
  const { notes, file, root } = setup({ 'Notes/scribble.md': 'Loose thoughts\n\nmore\n' });
  utimesSync(join(root, 'Notes/scribble.md'), new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
  const result = notes.update({ path: 'Notes/scribble.md', expected_hash: sha256(file('Notes/scribble.md')), tags: ['t'] });
  expect(result).toMatchObject({ id: 'id-1', path: 'Notes/scribble.md' });
  expect(file('Notes/scribble.md')).toBe(
    '---\nid: id-1\ntype: note\ntags:\n  - t\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-09-25T12:00:00.000Z\n---\n\n# scribble\n\nLoose thoughts\n\nmore\n'
  );
});

test('refuses to edit project notes', () => {
  const { notes, file } = setup();
  const path = 'Projects/Doccary/Doccary.md';
  expect(() => notes.update({ path, expected_hash: sha256(file(path)), body: 'x' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('delete checks the hash, trashes the file, and drops index rows and feedback', () => {
  const { notes, index, store, root } = setup();
  const created = notes.capture({ title: 'Gone soon', body: 'x' });
  notes.feedback({ id: created.id, verdict: 'stale' });
  expect(() => notes.delete({ id: created.id, expected_hash: 'f'.repeat(64) })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  expect(notes.delete({ id: created.id, expected_hash: created.hash })).toEqual({ trashed_path: '.trash/Gone soon.md' });
  expect(existsSync(join(root, '.trash/Gone soon.md'))).toBe(true);
  expect(index.get(created.path)).toBeUndefined();
  expect(store.feedbackSummary(created.id)).toEqual({});
});

test('read returns the view with body, fallbacks, feedback, and demotion', () => {
  const { notes, root } = setup({ 'Notes/hand.md': 'no frontmatter\n' });
  const created = notes.capture({ title: 'Readable', body: 'Body text.', project: 'Doccary' });
  expect(notes.read({ id: created.id })).toMatchObject({
    id: created.id, path: created.path, project: 'Doccary', title: 'Readable', type: 'note',
    body: 'Body text.\n', feedback: {}, demoted: false, hash: created.hash
  });
  notes.feedback({ id: created.id, verdict: 'incorrect', reason: 'wrong number' });
  expect(notes.read({ id: created.id })).toMatchObject({ feedback: { incorrect: 1 }, demoted: true });
  const updated = notes.update({ id: created.id, expected_hash: created.hash, body: 'Fixed.' });
  expect(notes.read({ id: created.id })).toMatchObject({ demoted: false, hash: updated.hash });
  utimesSync(join(root, 'Notes/hand.md'), new Date(0), new Date('2026-02-02T00:00:00.000Z'));
  expect(notes.read({ path: 'Notes/hand.md' })).toMatchObject({ id: null, title: 'hand', created: '2026-02-02T00:00:00.000Z' });
  writeFileSync(join(root, 'Notes/huge.md'), `# Huge\n\n${'z'.repeat(300_000)}`);
  expect(() => notes.read({ path: 'Notes/huge.md' })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
});

test('resolves ids after an external rename, and reports bad references', () => {
  const { notes, root } = setup({
    'Notes/dup1.md': '---\nid: twin\n---\n# One\n',
    'Notes/dup2.md': '---\nid: twin\n---\n# Two\n'
  });
  const created = notes.capture({ title: 'Movable', body: 'x', project: 'Doccary' });
  renameSync(join(root, created.path), join(root, 'Projects/Doccary/Renamed in Obsidian.md'));
  expect(notes.read({ id: created.id }).path).toBe('Projects/Doccary/Renamed in Obsidian.md');
  expect(() => notes.read({})).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.read({ id: 'x', path: 'Notes/a.md' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => notes.read({ id: 'nope' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(() => notes.read({ id: 'twin' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  expect(() => notes.read({ path: '../escape.md' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('feedback requires an id on the note', () => {
  const { notes } = setup({ 'Notes/hand.md': '# Hand\n' });
  expect(() => notes.feedback({ path: 'Notes/hand.md', verdict: 'useful' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
