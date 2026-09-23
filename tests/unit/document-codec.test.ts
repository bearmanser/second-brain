import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  documentFromNote,
  parseDocument,
  parseSources,
  renderDocument,
  renderSources
} from '../../src/notes/document-codec.js';
import {
  DEFAULT_TYPE_FOR_KIND,
  DOCUMENT_STATUSES,
  contentKindForType
} from '../../src/notes/document.js';
import { NOTE_REGISTRY } from '../../src/notes/registry.js';
import { decodeRevision, decodeRevisionV1 } from '../../src/notes/codec.js';
import { BrainError } from '../../src/contracts/errors.js';
import type { Evidence, NoteInput } from '../../src/core/types.js';

test('readable documents preserve custom properties and freeform content', () => {
  const raw = '---\ntype: research\nstatus: active\ncustom: keep\naliases:\n  - Laya classifier\n---\n\n# Laya\n\n> [!note]\n> Human text.\n';
  const parsed = parseDocument(raw, 'Knowledge/Laya.md');
  const again = parseDocument(renderDocument(parsed), parsed.path);
  expect(again.properties.custom).toBe('keep');
  expect(again.aliases).toEqual(['Laya classifier']);
  expect(again.body).toContain('> Human text.');
  expect(again.id).toBeUndefined();
});

test('the readable document constants match the contract', () => {
  expect(DOCUMENT_STATUSES).toEqual(['candidate', 'active', 'superseded', 'archived']);
  expect(DEFAULT_TYPE_FOR_KIND).toEqual({
    lesson: 'lesson',
    decision: 'decision',
    playbook: 'playbook',
    fact: 'fact',
    preference: 'preference',
    session: 'session',
    note: 'note'
  });
});

const structuredNotes: NoteInput[] = [
  {
    title: 'Lesson note',
    tags: ['lesson-tag'],
    content: {
      kind: 'lesson',
      situation: 'Latency regressed.',
      lesson: 'Measure before blaming.',
      applicability: 'Streaming benchmarks.',
      limitations: ['One prompt.']
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Decision note',
    tags: [],
    content: {
      kind: 'decision',
      context: 'The gateway needed a backend.',
      decision: 'Keep FTS5.',
      rationale: 'Markdown stays authoritative.',
      alternatives: ['Hosted backend'],
      consequences: ['Rebuildable index'],
      reconsider_when: 'Semantic recall is required.'
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Playbook note',
    tags: [],
    content: {
      kind: 'playbook',
      use_when: 'A candidate needs promotion.',
      prerequisites: ['A readable document'],
      steps: ['Read it', 'Review evidence'],
      verification: ['The note renders'],
      cautions: ['Do not invent facts.']
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Fact note',
    tags: [],
    content: {
      kind: 'fact',
      claim: 'FTS5 is local.',
      applicability: 'The disposable index.',
      valid_until: '2027-01-01T00:00:00Z'
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Preference note',
    tags: [],
    content: {
      kind: 'preference',
      preference: 'Prefer readable notes.',
      applicability: 'Vault authoring.',
      source_statement_ref: 'conversation-1',
      exceptions: ['Machine exports']
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Session note',
    tags: [],
    content: {
      kind: 'session',
      task: 'Define the format.',
      state: 'In progress.',
      next_actions: ['Write tests'],
      session_id: 'session-1',
      branch: 'feat/local-brain-v2',
      repository_ref: 'second-brain'
    },
    evidence: [],
    related_ids: []
  },
  {
    title: 'Note note',
    tags: [],
    content: { kind: 'note', summary: 'A summary.', body_markdown: 'Freeform body.' },
    evidence: [],
    related_ids: []
  }
];

test('all seven structured content kinds render into normal headings', () => {
  for (const note of structuredNotes) {
    const document = documentFromNote(note, {
      path: `Knowledge/${note.title}.md`,
      created: '2026-09-23'
    });
    expect(document.type).toBe(DEFAULT_TYPE_FOR_KIND[note.content.kind]);
    expect(document.status).toBe('candidate');
    const raw = renderDocument(document);
    expect(raw).not.toContain('```yaml');
    const again = parseDocument(raw, document.path);
    expect(again.type).toBe(document.type);
    expect(again.title).toBe(note.title);
    const content = note.content as unknown as Record<string, unknown>;
    for (const spec of NOTE_REGISTRY[note.content.kind].sections) {
      if (content[spec.field] === undefined) continue;
      expect(again.body).toContain(`## ${spec.title}`);
    }
    const firstField = NOTE_REGISTRY[note.content.kind].sections[0].field;
    expect(again.body).toContain(String(content[firstField]));
  }
});

test('dates accept ISO dates and RFC3339 offsets without changing them', () => {
  const raw = '---\ntype: note\nstatus: active\ncreated: 2026-09-23\nupdated: 2026-09-23T14:30:00+02:00\n---\n\n# Dates\n';
  const parsed = parseDocument(raw, 'Knowledge/Dates.md');
  expect(parsed.created).toBe('2026-09-23');
  expect(parsed.updated).toBe('2026-09-23T14:30:00+02:00');
  const again = parseDocument(renderDocument(parsed), parsed.path);
  expect(again.created).toBe('2026-09-23');
  expect(again.updated).toBe('2026-09-23T14:30:00+02:00');
});

test('a timestamp without a timezone is reportable as malformed', () => {
  const raw = '---\ntype: note\ncreated: 2026-09-23T14:30:00\n---\n\n# Dates\n';
  expect(() => parseDocument(raw, 'Knowledge/Dates.md')).toThrow(BrainError);
});

test('malformed YAML is reported as a typed error instead of a crash', () => {
  try {
    parseDocument('---\ntype: [unclosed\n---\n\n# Broken\n', 'Broken.md');
    expect.unreachable('malformed YAML should be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe('INVALID_INPUT');
  }
});

test('an unterminated frontmatter block is reportable', () => {
  expect(() => parseDocument('---\ntype: note\n\n# Broken\n', 'Broken.md')).toThrow(
    /unterminated frontmatter/
  );
});

test('a newer schema version is unsupported rather than misparsed', () => {
  try {
    parseDocument('---\nbrain_schema_version: 3\ntype: note\n---\n\n# Future\n', 'Future.md');
    expect.unreachable('a newer schema version should be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe('UNSUPPORTED_SCHEMA');
  }
  expect(() =>
    parseDocument('---\nbrain_schema_version: 1\ntype: lesson\n---\n\n# Legacy\n', 'Legacy.md')
  ).toThrow(BrainError);
});

test('explicit YAML tags and aliases are rejected', () => {
  expect(() =>
    parseDocument('---\ntype: note\ncustom: !custom value\n---\n\n# Tagged\n', 'Tagged.md')
  ).toThrow(BrainError);
  expect(() =>
    parseDocument(
      '---\ntype: note\nbase: &anchor\n  inner: 1\ncopy: *anchor\n---\n\n# Aliased\n',
      'Aliased.md'
    )
  ).toThrow(/aliases are not supported/);
});

test('duplicate frontmatter keys are reported', () => {
  expect(() =>
    parseDocument('---\ntype: note\ntype: lesson\n---\n\n# Duplicate\n', 'Duplicate.md')
  ).toThrow(BrainError);
});

test('Obsidian callouts and code fences survive a round trip untouched', () => {
  const raw = '---\ntype: note\nstatus: active\n---\n\n# Mixed\n\n> [!warning]\n> Keep this callout.\n\n```ts\nconst value = 1;\n---\n```\n';
  const parsed = parseDocument(raw, 'Knowledge/Mixed.md');
  const again = parseDocument(renderDocument(parsed), parsed.path);
  expect(again.body).toContain('> [!warning]');
  expect(again.body).toContain('> Keep this callout.');
  expect(again.body).toContain('```ts');
  expect(again.body).toContain('const value = 1;');
});

test('an indented --- inside a YAML block scalar does not close the frontmatter early', () => {
  const raw = '---\ntype: note\ndescription: |\n  first\n  ---\n  last\n---\n\n# Block\n';
  const parsed = parseDocument(raw, 'Block.md');
  expect(parsed.properties.description).toBe('first\n---\nlast\n');
  expect(parsed.body).toContain('# Block');
});

test('ordinary Markdown without frontmatter is readable with safe defaults', () => {
  const parsed = parseDocument('# Plain\n\nText.\n', 'Knowledge/Plain.md');
  expect(parsed.title).toBe('Plain');
  expect(parsed.type).toBe('note');
  expect(parsed.status).toBe('candidate');
  expect(parsed.properties).toEqual({});
  expect(parsed.id).toBeUndefined();
});

test('a malformed file is reportable without stopping the whole vault index', () => {
  const files = [
    { path: 'Good.md', raw: '---\ntype: note\nstatus: active\n---\n\n# Good\n' },
    { path: 'Broken.md', raw: '---\ntype: [unclosed\n---\n\n# Broken\n' },
    { path: 'Tagged.md', raw: '---\ntype: note\ncustom: !custom value\n---\n\n# Tagged\n' }
  ];
  const documents: string[] = [];
  const failures: { path: string; code: string }[] = [];
  for (const file of files) {
    try {
      documents.push(parseDocument(file.raw, file.path).path);
    } catch (error) {
      expect(error).toBeInstanceOf(BrainError);
      failures.push({ path: file.path, code: (error as BrainError).code });
    }
  }
  expect(documents).toEqual(['Good.md']);
  expect(failures).toEqual([
    { path: 'Broken.md', code: 'INVALID_INPUT' },
    { path: 'Tagged.md', code: 'INVALID_INPUT' }
  ]);
});

test('parsing never allocates a logical id', () => {
  const parsed = parseDocument('---\ntype: note\n---\n\n# No id\n', 'No id.md');
  expect(parsed.id).toBeUndefined();
  expect(Object.keys(parsed.properties)).not.toContain('id');
});

test('lifecycle defaults to candidate and is never inferred from a directory', () => {
  expect(parseDocument('---\ntype: note\n---\n\n# A\n', 'Archive/A.md').status).toBe('candidate');
  expect(parseDocument('---\ntype: note\n---\n\n# B\n', 'Decisions/B.md').status).toBe('candidate');
  expect(parseDocument('---\ntype: note\nstatus: active\n---\n\n# C\n', 'Inbox/C.md').status).toBe(
    'active'
  );
  expect(
    parseDocument('---\ntype: note\nstatus: archived\n---\n\n# D\n', 'Projects/D.md').status
  ).toBe('archived');
});

test('an old AI hypothesis is not promoted to an approved fact', () => {
  const hypothesis = documentFromNote(
    {
      title: 'Possible cause',
      tags: [],
      related_ids: [],
      content: { kind: 'fact', claim: 'The proxy causes latency.', applicability: 'Synthetic.' },
      evidence: [{ kind: 'hypothesis', ref: 'agent-run-1', description: 'Agent suggested this.' }]
    },
    { path: 'Inbox/Possible cause.md' }
  );
  expect(hypothesis.status).toBe('candidate');
  const again = parseDocument(renderDocument(hypothesis), hypothesis.path);
  expect(again.status).toBe('candidate');
  expect(again.body).toContain('**hypothesis**');
});

test('custom properties stay flat values across a deterministic round trip', () => {
  const raw = '---\ntype: note\nstatus: active\ncount: 3\nflag: true\nnested:\n  inner: kept\nlist:\n  - one\n  - two\n---\n\n# Custom\n';
  const parsed = parseDocument(raw, 'Custom.md');
  expect(parsed.properties).toEqual({
    count: 3,
    flag: true,
    nested: { inner: 'kept' },
    list: ['one', 'two']
  });
  const again = parseDocument(renderDocument(parsed), parsed.path);
  expect(again.properties).toEqual(parsed.properties);
  expect(renderDocument(parsed)).toBe(renderDocument(parsed));
});

test('type describes the note while tags only organize it', () => {
  expect(contentKindForType('decision')).toBe('decision');
  expect(contentKindForType('research')).toBe('note');
  const parsed = parseDocument(
    '---\ntype: research\ntags:\n  - decision\n---\n\n# Laya\n',
    'Knowledge/Laya.md'
  );
  expect(parsed.type).toBe('research');
  expect(parsed.tags).toEqual(['decision']);
});

test('human aliases and tags survive an agent revision', () => {
  const parsed = parseDocument(
    '---\ntype: note\naliases:\n  - Human alias\ntags:\n  - human-tag\n---\n\n# Note\n',
    'Note.md'
  );
  const revised = documentFromNote(
    {
      title: 'Note',
      tags: [],
      content: { kind: 'note', summary: 'A summary.', body_markdown: 'Body.' },
      evidence: [],
      related_ids: []
    },
    { path: parsed.path, aliases: parsed.aliases, tags: parsed.tags }
  );
  const again = parseDocument(renderDocument(revised), revised.path);
  expect(again.aliases).toEqual(['Human alias']);
  expect(again.tags).toEqual(['human-tag']);
});

test('V2 evidence renders labeled Markdown sources with kind and observed date', () => {
  const evidence: Evidence[] = [
    {
      kind: 'test_run',
      ref: 'benchmark-fixture-1',
      description: 'Synthetic direct/proxy measurements'
    },
    {
      kind: 'reference',
      ref: 'https://example.com/laya',
      description: 'Laya model card',
      observed_at: '2026-09-15'
    }
  ];
  const section = renderSources(evidence);
  expect(section).toContain('## Sources');
  expect(section).toContain('**test_run**');
  expect(section).toContain('**reference**');
  expect(section).toContain('[https://example.com/laya](https://example.com/laya)');
  expect(section).toContain('(observed 2026-09-15)');
  expect(section).not.toContain('```');
  const parsed = parseSources(section);
  expect(parsed.evidence).toEqual(evidence);
  expect(parsed.human).toEqual([]);
});

test('human additions to a Sources section are retained verbatim', () => {
  const section = renderSources([
    { kind: 'repository', ref: 'src/notes/document.ts', description: 'Readable document codec' }
  ]);
  const withHuman = `${section}\n\nPrefer the local snapshot when the link is stale.`;
  const parsed = parseSources(withHuman);
  expect(parsed.evidence).toHaveLength(1);
  expect(parsed.evidence[0].kind).toBe('repository');
  expect(parsed.human.join('\n')).toContain('Prefer the local snapshot when the link is stale.');
});

test('structured agent input renders headings and sources without a YAML fence', () => {
  const document = documentFromNote(
    {
      title: 'Retrieval design',
      tags: ['retrieval'],
      related_ids: ['44b093c5-71db-4785-b9a5-bb8118304278'],
      content: {
        kind: 'decision',
        context: 'Local retrieval is required.',
        decision: 'Use FTS5.',
        rationale: 'It is disposable.',
        alternatives: ['Hosted backend'],
        consequences: ['Rebuildable index']
      },
      evidence: [{ kind: 'repository', ref: 'src/notes/document.ts', description: 'Codec' }]
    },
    { path: 'Knowledge/Retrieval design.md', created: '2026-09-23' }
  );
  const raw = renderDocument(document);
  expect(raw).toContain('## Context');
  expect(raw).toContain('## Decision');
  expect(raw).toContain('## Sources');
  expect(raw).toContain('## Related');
  expect(raw).not.toContain('```yaml');
});

test('the readable decision fixture round-trips with custom properties intact', () => {
  const raw = readFileSync(
    new URL('../fixtures/vault-v2/readable-decision.md', import.meta.url),
    'utf8'
  );
  const parsed = parseDocument(raw, 'Projects/Second Brain/Decisions/Local retrieval design.md');
  expect(parsed.type).toBe('decision');
  expect(parsed.status).toBe('candidate');
  expect(parsed.id).toBe('7f0b5c2a-9d1e-4a3b-8c4d-5e6f7a8b9c0d');
  expect(parsed.created).toBe('2026-09-23');
  expect(parsed.updated).toBe('2026-09-23T14:30:00+02:00');
  expect(parsed.aliases).toEqual(['Local retrieval design']);
  expect(parsed.properties.custom_property).toBe('keep me');
  expect(parsed.body).toContain('> [!note]');
  expect(parsed.body).not.toContain('```yaml');
  const again = parseDocument(renderDocument(parsed), parsed.path);
  expect(again.properties.custom_property).toBe('keep me');
  expect(again.body).toContain('Obsidian callout preserved as written.');
  const sources = parseSources(parsed.body.slice(parsed.body.indexOf('## Sources')));
  expect(sources.evidence).toHaveLength(1);
  expect(sources.evidence[0]).toEqual({
    kind: 'user_statement',
    ref: 'conversation-1',
    description: 'The human asked for local retrieval.',
    observed_at: '2026-09-20'
  });
  expect(sources.human.join('\n')).toContain('Human addition: this note is maintained by hand.');
});

test('explicit V1 decoding remains available beside the V2 codec', () => {
  expect(decodeRevisionV1).toBe(decodeRevision);
});
