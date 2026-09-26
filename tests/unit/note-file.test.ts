import { expect, test } from 'vitest';
import { parseNote, renderNote, renderProjectNote, splitFrontmatter } from '../../src/vault/note-file.js';

const NOTE = [
  '---',
  'id: 8a431d1f-1cd5-4892-9386-50bbca8307d1',
  'type: lesson',
  'tags:',
  '  - laya',
  'created: 2026-09-24T07:36:00.360Z',
  'updated: 2026-09-24T07:36:00.360Z',
  '---',
  '',
  '# Laya is slow on CPU',
  '',
  '## Situation',
  'Measured.',
  ''
].join('\n');

test('parses managed notes', () => {
  const parsed = parseNote(NOTE);
  expect(parsed).toEqual({
    id: '8a431d1f-1cd5-4892-9386-50bbca8307d1',
    type: 'lesson',
    tags: ['laya'],
    created: '2026-09-24T07:36:00.360Z',
    updated: '2026-09-24T07:36:00.360Z',
    title: 'Laya is slow on CPU',
    body: '## Situation\nMeasured.\n',
    isProject: false,
    repositories: []
  });
});

test('parses CRLF notes identically', () => {
  const parsed = parseNote(NOTE.replace(/\n/g, '\r\n'));
  expect(parsed.title).toBe('Laya is slow on CPU');
  expect(parsed.id).toBe('8a431d1f-1cd5-4892-9386-50bbca8307d1');
  expect(parsed.tags).toEqual(['laya']);
});

test('parses hand-written notes without frontmatter or H1', () => {
  expect(parseNote('just text\n')).toMatchObject({ id: null, type: 'note', tags: [], title: null, body: 'just text\n' });
  expect(parseNote('')).toMatchObject({ title: null, body: '' });
  expect(parseNote('---\n---\n# T\n')).toMatchObject({ title: 'T', body: '' });
  expect(parseNote('---\ntype: weird\n---\n# T\nx')).toMatchObject({ type: 'note' });
});

test('recognizes project notes and their repositories', () => {
  const parsed = parseNote('---\ntype: project\nrepositories:\n  - github.com/a/b\n---\n# A\n');
  expect(parsed.isProject).toBe(true);
  expect(parsed.repositories).toEqual(['github.com/a/b']);
});

test('rejects frontmatter that is not a YAML mapping', () => {
  expect(() => parseNote('---\nid: [unclosed\n---\n# T\n')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => parseNote('---\n- a\n- b\n---\n# T\n')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('splits frontmatter from content', () => {
  expect(splitFrontmatter('---\na: 1\n---\n\n# T\n')).toEqual({ frontmatter: 'a: 1', content: '\n# T\n' });
  expect(splitFrontmatter('# T\n')).toEqual({ frontmatter: null, content: '# T\n' });
});

test('renders fresh notes that round-trip', () => {
  const raw = renderNote({
    id: 'n1', type: 'fact', tags: ['a', 'b'], created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z', title: 'Title', body: 'Body line\n'
  });
  expect(raw).toBe(
    '---\nid: n1\ntype: fact\ntags:\n  - a\n  - b\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n\n# Title\n\nBody line\n'
  );
  expect(parseNote(raw)).toMatchObject({ id: 'n1', type: 'fact', tags: ['a', 'b'], title: 'Title', body: 'Body line\n' });
  expect(renderNote({ id: 'n', type: 'note', tags: [], created: 'c', updated: 'u', title: 'Empty', body: '' }))
    .toBe('---\nid: n\ntype: note\ntags: []\ncreated: c\nupdated: u\n---\n\n# Empty\n');
});

test('preserves unknown frontmatter keys from the previous file', () => {
  const previous = '---\nsource: web clip   # kept\nid: old\ntype: note\n---\n# Old\n';
  const raw = renderNote(
    { id: 'old', type: 'lesson', tags: [], created: 'c', updated: 'u', title: 'New', body: 'b' },
    previous
  );
  expect(raw).toMatch(/^source: web clip\s+# kept$/m);
  expect(parseNote(raw)).toMatchObject({ type: 'lesson', title: 'New', body: 'b\n' });
});

test('renders project notes and keeps their existing body', () => {
  expect(renderProjectNote('Shared', [])).toBe('---\ntype: project\nrepositories: []\n---\n\n# Shared\n');
  const previous = '---\ntype: project\nrepositories: []\n---\n\n# Doccary\n\nOverview text.\n';
  const raw = renderProjectNote('Doccary', ['github.com/doccary/doccary'], previous);
  expect(parseNote(raw).repositories).toEqual(['github.com/doccary/doccary']);
  expect(raw).toContain('Overview text.');
});
