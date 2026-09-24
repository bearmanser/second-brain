import { expect, test } from 'vitest';
import {
  acceptRelationships,
  resolveLink,
  resolveRelationships
} from '../../src/notes/link-resolver.js';

const catalogue = new Map<string, string | undefined>([
  ['Home.md', 'id-home'],
  ['Knowledge/Laya.md', 'id-laya-knowledge'],
  ['Projects/Second Brain/Research/Laya.md', 'id-laya-project'],
  ['Knowledge/My Note.md', 'id-space'],
  ['Attachments/diagram.png', undefined],
  ['Projects/A/Note.md', 'id-a-note']
]);

const relativeCatalogue = new Map<string, string | undefined>([
  ['Outside.md', 'id-outside'],
  ['Knowledge/Laya.md', 'id-laya-knowledge'],
  ['Projects/A/Laya.md', 'id-a-laya'],
  ['Projects/A/Note.md', 'id-a-note']
]);

test('resolves a unique short filename and returns its managed id', () => {
  expect(resolveLink({ target: 'Home' }, 'Knowledge/Other.md', catalogue)).toEqual({
    state: 'resolved',
    path: 'Home.md',
    id: 'id-home'
  });
});

test('returns ambiguous candidates for duplicate short filenames', () => {
  expect(resolveLink({ target: 'Laya' }, 'Home.md', catalogue)).toEqual({
    state: 'ambiguous',
    target: 'Laya',
    paths: ['Knowledge/Laya.md', 'Projects/Second Brain/Research/Laya.md']
  });
});

test('returns unresolved for a missing target', () => {
  expect(resolveLink({ target: 'Missing' }, 'Home.md', catalogue)).toEqual({
    state: 'unresolved',
    target: 'Missing'
  });
});

test('resolves a full path even when a duplicate short filename exists', () => {
  expect(
    resolveLink({ target: 'Projects/Second Brain/Research/Laya' }, 'Home.md', catalogue)
  ).toEqual({
    state: 'resolved',
    path: 'Projects/Second Brain/Research/Laya.md',
    id: 'id-laya-project'
  });
});

test('resolves self-links', () => {
  expect(resolveLink({ target: 'Home' }, 'Home.md', catalogue)).toEqual({
    state: 'resolved',
    path: 'Home.md',
    id: 'id-home'
  });
});

test('resolves a managed id target through the catalogue', () => {
  expect(resolveLink({ target: 'id-laya-knowledge' }, 'Home.md', catalogue)).toEqual({
    state: 'resolved',
    path: 'Knowledge/Laya.md',
    id: 'id-laya-knowledge'
  });
});

test('resolves percent-encoded spaces', () => {
  expect(resolveLink({ target: 'My%20Note' }, 'Home.md', catalogue)).toEqual({
    state: 'resolved',
    path: 'Knowledge/My Note.md',
    id: 'id-space'
  });
});

test('resolves Markdown links relative to the source document', () => {
  expect(
    resolveLink(
      { target: '../../Knowledge/Laya.md', syntax: 'markdown' },
      'Projects/A/Note.md',
      catalogue
    )
  ).toEqual({
    state: 'resolved',
    path: 'Knowledge/Laya.md',
    id: 'id-laya-knowledge'
  });
});

test('does not treat an alias as an Obsidian filename', () => {
  expect(resolveLink({ target: 'Laya classifier' }, 'Home.md', catalogue)).toEqual({
    state: 'unresolved',
    target: 'Laya classifier'
  });
});

test('never resolves a link outside the vault', () => {
  expect(resolveLink({ target: 'https://example.com/brain' }, 'Home.md', catalogue)).toEqual({
    state: 'unresolved',
    target: 'https://example.com/brain'
  });
});

test('resolves an attachment embed by path', () => {
  expect(resolveLink({ target: 'Attachments/diagram.png' }, 'Home.md', catalogue)).toEqual({
    state: 'resolved',
    path: 'Attachments/diagram.png'
  });
});

test('resolves typed relationship edges through the catalogue', () => {
  const edges = [
    {
      kind: 'supersedes' as const,
      reference: {
        target: 'Knowledge/Laya',
        embed: false,
        start: 0,
        end: 0,
        syntax: 'wikilink' as const
      }
    }
  ];
  expect(resolveRelationships(edges, 'Home.md', catalogue)).toEqual([
    { kind: 'supersedes', source: 'Home.md', target: 'Knowledge/Laya.md', id: 'id-laya-knowledge' }
  ]);
});

test('omits unresolved and ambiguous relationship edges instead of guessing', () => {
  const edges = [
    {
      kind: 'related' as const,
      reference: { target: 'Missing', embed: false, start: 0, end: 0, syntax: 'wikilink' as const }
    },
    {
      kind: 'related' as const,
      reference: { target: 'Laya', embed: false, start: 0, end: 0, syntax: 'wikilink' as const }
    }
  ];
  expect(resolveRelationships(edges, 'Home.md', catalogue)).toEqual([]);
});

test('returns ambiguous candidates when a bare filename matches the root and a project', () => {
  const withRoot = new Map<string, string | undefined>([
    ['Laya.md', 'id-root'],
    ['Projects/Other/Laya.md', 'id-other'],
    ['Notes/Note.md', undefined]
  ]);
  expect(resolveLink({ target: 'Laya' }, 'Notes/Note.md', withRoot)).toEqual({
    state: 'ambiguous',
    target: 'Laya',
    paths: ['Laya.md', 'Projects/Other/Laya.md']
  });
});

test('resolves an explicit ./ relative link from the source directory', () => {
  expect(resolveLink({ target: './Laya.md' }, 'Projects/A/Note.md', relativeCatalogue)).toEqual({
    state: 'resolved',
    path: 'Projects/A/Laya.md',
    id: 'id-a-laya'
  });
});

test('does not fall back to an unrelated project for an explicit relative link', () => {
  const noSibling = new Map<string, string | undefined>([
    ['Knowledge/Laya.md', 'id-laya-knowledge'],
    ['Projects/A/Note.md', 'id-a-note']
  ]);
  expect(resolveLink({ target: './Laya.md' }, 'Projects/A/Note.md', noSibling)).toEqual({
    state: 'unresolved',
    target: './Laya.md'
  });
});

test('rejects a relative link that escapes the vault root', () => {
  expect(
    resolveLink({ target: '../../../../Outside.md' }, 'Projects/A/Note.md', relativeCatalogue)
  ).toEqual({ state: 'unresolved', target: '../../../../Outside.md' });
});

test('rejects a resolved self-supersession at the relationship boundary', () => {
  const edges = [
    {
      kind: 'supersedes' as const,
      reference: {
        target: 'Knowledge/Laya',
        embed: false,
        start: 0,
        end: 0,
        syntax: 'wikilink' as const
      }
    }
  ];
  expect(() => resolveRelationships(edges, 'Knowledge/Laya.md', catalogue)).toThrowError(
    /supersede/i
  );
});

test('rejects a supersession cycle at the relationship boundary', () => {
  expect(() =>
    acceptRelationships([
      { kind: 'supersedes', source: 'A.md', target: 'B.md' },
      { kind: 'supersedes', source: 'B.md', target: 'A.md' }
    ])
  ).toThrowError(/cycle/i);
});

test('allows an ordinary related cycle at the relationship boundary', () => {
  const edges = [
    { kind: 'related' as const, source: 'A.md', target: 'B.md' },
    { kind: 'related' as const, source: 'B.md', target: 'A.md' }
  ];
  expect(acceptRelationships(edges)).toEqual(edges);
});
