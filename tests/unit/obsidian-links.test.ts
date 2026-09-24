import { expect, test } from 'vitest';
import {
  aliasLink,
  deriveBacklinks,
  extractLinks,
  extractRelationships,
  validateSupersessionGraph
} from '../../src/notes/links.js';

test('links keep anchors and ignore code examples', () => {
  const raw = '[[Projects/Second Brain/Research/Laya#Limits|Laya]]\n' +
    '`[[Not a link]]`\n```text\n[[Also not a link]]\n```\n' +
    '![[Attachments/diagram.png]]\n[[Decision#^evidence]]\n';
  expect(extractLinks(raw).map(x => x.target)).toEqual([
    'Projects/Second Brain/Research/Laya', 'Attachments/diagram.png', 'Decision'
  ]);
  expect(extractLinks(raw)[0].fragment).toBe('Limits');
  expect(extractLinks(raw)[2].fragment).toBe('^evidence');
});

test('extracted references expose source offsets, syntax, labels, and embeds', () => {
  const raw = '[[Knowledge/Laya#Limits|Classifier]] and ![[Attachments/diagram.png]]\n';
  const links = extractLinks(raw);
  expect(raw.slice(links[0].start, links[0].end)).toBe('[[Knowledge/Laya#Limits|Classifier]]');
  expect(links[0]).toMatchObject({
    target: 'Knowledge/Laya',
    fragment: 'Limits',
    label: 'Classifier',
    embed: false,
    syntax: 'wikilink'
  });
  expect(raw.slice(links[1].start, links[1].end)).toBe('![[Attachments/diagram.png]]');
  expect(links[1]).toMatchObject({
    target: 'Attachments/diagram.png',
    embed: true,
    syntax: 'wikilink'
  });
});

test('ignores escaped brackets and inline code while keeping real links', () => {
  const raw = '\\[[Not a link]] and `[[Also not]]` then [[Real]]\n';
  expect(extractLinks(raw).map(x => x.target)).toEqual(['Real']);
});

test('parses frontmatter link lists and scalars using node positions', () => {
  const raw =
    '---\nproject: "[[Projects/Second Brain/Second Brain]]"\n' +
    'related:\n  - "[[Knowledge/Laya]]"\n---\n\n[[Body]]\n';
  const links = extractLinks(raw);
  expect(links.map(x => x.target)).toEqual([
    'Projects/Second Brain/Second Brain', 'Knowledge/Laya', 'Body'
  ]);
  for (const link of links) {
    const fragment = link.fragment === undefined ? '' : `#${link.fragment}`;
    const label = link.label === undefined ? '' : `|${link.label}`;
    expect(raw.slice(link.start, link.end)).toBe(`[[${link.target}${fragment}${label}]]`);
  }
});

test('parses standard Markdown links and images but ignores external URLs', () => {
  const raw = 'See [Laya](../Knowledge/Laya.md#Limits) and ![diagram](../Attachments/diagram.png).\n' +
    'External [site](https://example.com) stays untouched.\n';
  const links = extractLinks(raw);
  expect(links.map(x => x.target)).toEqual(['../Knowledge/Laya.md', '../Attachments/diagram.png']);
  expect(links[0]).toMatchObject({ fragment: 'Limits', label: 'Laya', embed: false, syntax: 'markdown' });
  expect(links[1]).toMatchObject({ embed: true, syntax: 'markdown' });
  expect(raw.slice(links[0].start, links[0].end)).toBe('[Laya](../Knowledge/Laya.md#Limits)');
});

test('keeps percent-encoded targets verbatim and unescapes table pipes', () => {
  const raw = '[[My%20Note]]\n| [[Knowledge/Laya\\|Alias]] |\n';
  const links = extractLinks(raw);
  expect(links.map(x => x.target)).toEqual(['My%20Note', 'Knowledge/Laya']);
  expect(links[1].label).toBe('Alias');
});

test('represents related, supersedes, depends_on, and implements as typed edges', () => {
  const raw = '---\nrelated:\n  - "[[Knowledge/A]]"\n' +
    'supersedes:\n  - "[[Knowledge/Old]]"\n' +
    'depends_on:\n  - "[[Knowledge/Base]]"\n' +
    'implements:\n  - "[[Knowledge/Spec]]"\n---\n\n# Note\n';
  expect(extractRelationships(raw).map(edge => [edge.kind, edge.reference.target])).toEqual([
    ['related', 'Knowledge/A'],
    ['supersedes', 'Knowledge/Old'],
    ['depends_on', 'Knowledge/Base'],
    ['implements', 'Knowledge/Spec']
  ]);
});

test('derives backlinks from edges instead of storing inverse metadata', () => {
  const edges = [{ kind: 'related' as const, source: 'A.md', target: 'B.md' }];
  expect(deriveBacklinks(edges)).toEqual([{ kind: 'related', source: 'B.md', target: 'A.md' }]);
});

test('only explicit relationship properties become typed edges', () => {
  const raw = '---\nproject: "[[Projects/Second Brain/Second Brain]]"\nrelated:\n  - "[[Knowledge/A]]"\n---\n\n# Note\n';
  expect(extractRelationships(raw).map(edge => edge.kind)).toEqual(['related']);
});

test('rejects self-supersession and supersession cycles but allows related cycles', () => {
  expect(
    validateSupersessionGraph([{ kind: 'supersedes', source: 'A.md', target: 'A.md' }])
  ).toMatchObject({ ok: false, reason: 'self-supersession' });
  expect(
    validateSupersessionGraph([
      { kind: 'supersedes', source: 'A.md', target: 'B.md' },
      { kind: 'supersedes', source: 'B.md', target: 'A.md' }
    ])
  ).toMatchObject({ ok: false, reason: 'supersession-cycle' });
  expect(
    validateSupersessionGraph([
      { kind: 'related', source: 'A.md', target: 'B.md' },
      { kind: 'related', source: 'B.md', target: 'A.md' }
    ])
  ).toEqual({ ok: true });
});

test('generates alias links from a canonical path rather than a bare alias', () => {
  expect(aliasLink('Knowledge/Laya', 'Classifier')).toBe('[[Knowledge/Laya|Classifier]]');
});

test('rejects a wikilink whose match crosses an inline-code region', () => {
  const raw = '[[Note `code`]]\n';
  expect(extractLinks(raw)).toEqual([]);
});

test('rejects a wikilink whose match crosses an HTML region', () => {
  const raw = '[[Note <span>]]\n';
  expect(extractLinks(raw)).toEqual([]);
});

test('does not scan Markdown link destinations for wikilinks', () => {
  const raw = '[see]([[Destination]]) and [[Real]]\n';
  const links = extractLinks(raw);
  expect(links.filter((link) => link.syntax === 'wikilink').map((link) => link.target)).toEqual([
    'Real'
  ]);
  expect(links.find((link) => link.syntax === 'markdown')).toMatchObject({
    target: '[[Destination]]'
  });
});

test('keeps escaped brackets inside a wikilink and reports raw offsets', () => {
  const raw = '[[Notes\\[draft\\]]]\n';
  const links = extractLinks(raw);
  expect(links.map((link) => link.target)).toEqual(['Notes[draft]']);
  expect(raw.slice(links[0].start, links[0].end)).toBe('[[Notes\\[draft\\]]]');
});
