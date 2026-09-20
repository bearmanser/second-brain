import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeRevision,
  encodeRevision,
  makeEtag,
  payloadHash,
  renderRevision
} from '../../src/notes/codec.js';
import {
  EVIDENCE_SECTION_TITLE,
  KIND_FOLDERS,
  NOTE_REGISTRY,
  RELATED_SECTION_TITLE,
  sectionTitle
} from '../../src/notes/registry.js';
import { revisionDirectory } from '../../src/notes/identity.js';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type { NoteContent, NoteInput, ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';
import { scopeFixtures } from '../fixtures/principals.js';

const scope: ScopeConfig = scopeFixtures[0];

const scopeById = (id: string): ScopeConfig => {
  const found = scopeFixtures.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing scope fixture ${id}`);
  return found;
};

const contentFor = (kind: NoteContent['kind']): NoteContent => {
  switch (kind) {
    case 'lesson':
      return {
        kind: 'lesson',
        situation: 'Latency regressed after the proxy was introduced.',
        lesson: 'Compare direct and proxied timings before blaming the proxy.',
        applicability: 'Synthetic streaming benchmarks.',
        limitations: ['Only one prompt was measured.']
      };
    case 'decision':
      return {
        kind: 'decision',
        context: 'The gateway needed a private backend.',
        decision: 'Use the Basic Memory adapter over private HTTP.',
        rationale: 'It preserves the documented note envelope.',
        alternatives: ['Write Markdown directly'],
        consequences: ['One more process to operate'],
        reconsider_when: 'A native SQLite backend becomes available.'
      };
    case 'playbook':
      return {
        kind: 'playbook',
        use_when: 'A candidate needs promotion.',
        prerequisites: ['Reviewer credential'],
        steps: ['Read the candidate', 'Check evidence', 'Approve with the exact etag'],
        verification: ['The head is active with an approval fingerprint.'],
        cautions: ['Approval is not independent verification.']
      };
    case 'fact':
      return {
        kind: 'fact',
        claim: 'The pinned image reports Basic Memory 4.0.0b1.',
        applicability: 'The compatibility baseline recorded in this repository.',
        valid_until: '2027-01-01T00:00:00Z'
      };
    case 'preference':
      return {
        kind: 'preference',
        preference: 'Prefer hybrid recall over text-only recall.',
        applicability: 'Routine planning and debugging.',
        source_statement_ref: 'user-statement-fixture-1',
        exceptions: ['When embeddings are unavailable and fallback is allowed.']
      };
    case 'session':
      return {
        kind: 'session',
        task: 'Implement typed contracts.',
        state: 'Schemas and fixtures are in place.',
        next_actions: ['Run the full suite'],
        session_id: 'session-contracts',
        blockers: ['None'],
        branch: 'feat/second-brain',
        repository_ref: 'second-brain'
      };
    case 'note':
      return {
        kind: 'note',
        summary: 'Flexible note for otherwise untyped material.',
        body_markdown: '# Heading\n\nFree-form **Markdown** body.\n\n## Nested section\n\nMore body.'
      };
  }
};

const noteFor = (kind: NoteContent['kind'], overrides: Partial<NoteInput> = {}): NoteInput => ({
  title: `Synthetic ${kind} title`,
  tags: ['streaming', `kind-${kind}`],
  content: contentFor(kind),
  evidence: [
    {
      kind: 'test_run',
      ref: `benchmark-${kind}`,
      description: `Synthetic ${kind} measurements`,
      observed_at: '2026-09-01T00:00:00Z'
    }
  ],
  related_ids: kind === 'lesson' ? [] : [fixtureIds.revision],
  ...overrides
});

const makeRevision = (note: NoteInput, overrides: Partial<StoredRevision> = {}): StoredRevision => ({
  id: fixtureIds.note,
  revision_id: fixtureIds.revision,
  parents: [],
  scope: 'freellmapi',
  status: 'candidate',
  note,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: '2026-09-01T00:05:00Z',
  operation_id: fixtureIds.idempotencyKey,
  extra_frontmatter: { owner_label: 'Keep this' },
  extra_markdown: '## Extra observations\n\nA human added this section in Obsidian.',
  ...overrides
});

const lessonRevision = makeRevision(lessonFixture);

const expectBrainCode = (run: () => unknown, code: BrainErrorCode): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`expected BrainError ${code} but nothing was thrown`);
};

test('preserves manual additions outside typed fields', () => {
  const raw = readFileSync('tests/fixtures/vault/lesson.md', 'utf8');
  const revision = decodeRevision(raw);
  expect(revision.extra_frontmatter.owner_label).toBe('Keep this');
  expect(revision.extra_markdown).toContain('## Extra observations');
  expect(payloadHash(revision)).toMatch(/^[a-f0-9]{64}$/);
});

test('round-trips every note kind and keeps extra sections in every revised output', () => {
  const kinds = Object.keys(NOTE_REGISTRY) as NoteContent['kind'][];
  expect(kinds).toHaveLength(7);
  for (const kind of kinds) {
    const revision = makeRevision(noteFor(kind));
    const raw = renderRevision(revision, scope);
    const decoded = decodeRevision(raw);
    expect(decoded.note).toEqual(revision.note);
    expect(decoded.extra_frontmatter).toEqual({ owner_label: 'Keep this' });
    expect(decoded.extra_markdown).toContain('## Extra observations');
    expect(decoded.status).toBe('candidate');
    expect(decoded.scope).toBe('freellmapi');

    const write = encodeRevision(revision, scope);
    expect(write.body).toContain('## Extra observations');
    expect(write.metadata.brain_schema_version).toBe(1);
  }
});

test('maps the exact frontmatter fields for a revision', () => {
  const revision = makeRevision(lessonFixture, {
    parents: [{ revision_id: fixtureIds.revision, raw_hash: 'a'.repeat(64) }],
    status: 'active',
    approval: {
      principal_id: '00000000-0000-4000-8000-000000000003',
      rationale: 'Approved after review.',
      payload_hash: 'b'.repeat(64)
    },
    replacement_id: fixtureIds.replacement
  });
  const write = encodeRevision(revision, scope);
  expect(write.metadata).toMatchObject({
    brain_title: lessonFixture.title,
    brain_id: fixtureIds.note,
    brain_revision_id: fixtureIds.revision,
    brain_scope: 'freellmapi',
    brain_status: 'active',
    brain_schema_version: 1,
    brain_operation_id: fixtureIds.idempotencyKey,
    brain_approved_by: '00000000-0000-4000-8000-000000000003',
    brain_approval_rationale: 'Approved after review.',
    brain_approval_payload_hash: 'b'.repeat(64),
    brain_replacement_id: fixtureIds.replacement,
    created: '2026-09-01T00:00:00Z',
    modified: '2026-09-01T00:05:00Z'
  });
  expect(write.metadata.brain_parents).toEqual([`${fixtureIds.revision}@${'a'.repeat(64)}`]);
  expect(write.metadata.title).toContain(fixtureIds.revision);

  const decoded = decodeRevision(renderRevision(revision, scope));
  expect(decoded.parents).toEqual([{ revision_id: fixtureIds.revision, raw_hash: 'a'.repeat(64) }]);
  expect(decoded.approval).toEqual(revision.approval);
  expect(decoded.replacement_id).toBe(fixtureIds.replacement);
});

test('omits optional frontmatter fields when they are absent', () => {
  const write = encodeRevision(lessonRevision, scope);
  expect(write.metadata).not.toHaveProperty('brain_replacement_id');
  expect(write.metadata).not.toHaveProperty('brain_approved_by');
  expect(write.metadata.brain_parents).toEqual([]);
});

test('uses generated directories that never depend on a model-supplied path', () => {
  const write = encodeRevision(lessonRevision, scope);
  expect(write.directory).toBe(revisionDirectory('lesson', fixtureIds.note));
  expect(write.directory).toBe(`Lessons/${fixtureIds.note}`);
  expect(write.directory).not.toContain('..');
  expect(KIND_FOLDERS.note).toBe('Notes');
  expect(write.storage_title).toBe(`${lessonFixture.title} r${fixtureIds.revision}`);
  expect(write.permalink.startsWith('freellmapi/lessons/')).toBe(true);
  expect(write.body).not.toContain('---\ntitle:');
});

test('verifies the configured scope instead of reading global state', () => {
  const mismatched = makeRevision(lessonFixture, { scope: 'profile' });
  expectBrainCode(() => encodeRevision(mismatched, scope), 'INVALID_INPUT');
  expectBrainCode(() => encodeRevision(lessonRevision, scopeById('shared')), 'INVALID_INPUT');
});

test('makeEtag binds the revision identity to the raw hash', () => {
  const rawHash = 'c'.repeat(64);
  expect(makeEtag(fixtureIds.revision, rawHash)).toMatch(/^[a-f0-9]{64}$/);
  expect(makeEtag(fixtureIds.revision, rawHash)).toBe(makeEtag(fixtureIds.revision, rawHash));
  expect(makeEtag(fixtureIds.revision, rawHash)).not.toBe(makeEtag(fixtureIds.note, rawHash));
  expect(makeEtag(fixtureIds.revision, rawHash)).not.toBe(makeEtag(fixtureIds.revision, 'd'.repeat(64)));
});

test('payloadHash excludes approval, runtime, and index state', () => {
  const base = payloadHash(makeRevision(lessonFixture));
  const changedState = payloadHash(
    makeRevision(lessonFixture, {
      status: 'active',
      created_at: '2027-01-01T00:00:00Z',
      modified_at: '2027-01-01T00:05:00Z',
      operation_id: fixtureIds.replacement,
      parents: [{ revision_id: fixtureIds.revision, raw_hash: 'a'.repeat(64) }],
      approval: {
        principal_id: '00000000-0000-4000-8000-000000000003',
        rationale: 'Approved.',
        payload_hash: 'b'.repeat(64)
      },
      replacement_id: fixtureIds.replacement
    })
  );
  expect(changedState).toBe(base);

  const changedTitle = payloadHash(makeRevision({ ...lessonFixture, title: 'A different lesson title' }));
  expect(changedTitle).not.toBe(base);

  const reordered = payloadHash(makeRevision(lessonFixture, { extra_frontmatter: { b: 2, a: 1 } }));
  const sameKeys = payloadHash(makeRevision(lessonFixture, { extra_frontmatter: { a: 1, b: 2 } }));
  expect(reordered).toBe(sameKeys);
  expect(reordered).not.toBe(payloadHash(makeRevision(lessonFixture, { extra_frontmatter: {} })));

  const crlf = payloadHash(makeRevision(lessonFixture, { extra_markdown: '## Extra\r\n\r\nline' }));
  const lf = payloadHash(makeRevision(lessonFixture, { extra_markdown: '## Extra\n\nline' }));
  expect(crlf).toBe(lf);
});

test('rejects duplicate reserved headings instead of guessing', () => {
  const raw = renderRevision(lessonRevision, scope).replace(
    '## Lesson\n\n',
    '## Lesson\n\nFirst lesson paragraph.\n\n## Lesson\n\nSecond lesson paragraph.\n\n'
  );
  expectBrainCode(() => decodeRevision(raw), 'INVALID_INPUT');
});

test('treats headings inside code fences as section content', () => {
  const raw = renderRevision(lessonRevision, scope).replace(
    lessonFixture.content.kind === 'lesson' ? lessonFixture.content.situation : '',
    'Before the fence.\n\n```text\n## Extra observations\n```\n\nAfter the fence.'
  );
  const revision = decodeRevision(raw);
  const content = revision.note.content;
  expect(content.kind).toBe('lesson');
  if (content.kind === 'lesson') {
    expect(content.situation).toContain('## Extra observations');
    expect(content.situation).toContain('After the fence.');
  }
  expect(revision.extra_markdown).toContain('## Extra observations');
  expect(revision.extra_markdown).not.toContain('After the fence.');
});

test('retains unknown top-level sections in source order', () => {
  const raw = renderRevision(lessonRevision, scope).replace(
    '## Extra observations',
    '## Alpha notes\n\nAlpha body.\n\n## Beta notes\n\nBeta body.\n\n## Extra observations'
  );
  const revision = decodeRevision(raw);
  const alpha = revision.extra_markdown.indexOf('## Alpha notes');
  const beta = revision.extra_markdown.indexOf('## Beta notes');
  const extra = revision.extra_markdown.indexOf('## Extra observations');
  expect(alpha).toBeGreaterThanOrEqual(0);
  expect(beta).toBeGreaterThan(alpha);
  expect(extra).toBeGreaterThan(beta);
});

test('rejects YAML duplicate keys, aliases, and explicit tags', () => {
  const duplicateKey = renderRevision(lessonRevision, scope).replace(
    /^brain_id: /m,
    'brain_id: 00000000-0000-4000-8000-000000000009\nbrain_id: '
  );
  expectBrainCode(() => decodeRevision(duplicateKey), 'INVALID_INPUT');

  const aliased = renderRevision(lessonRevision, scope).replace(
    '\n---\n\n',
    '\nanchored: &a 1\nreference: *a\n---\n\n'
  );
  expectBrainCode(() => decodeRevision(aliased), 'INVALID_INPUT');

  const tagged = renderRevision(lessonRevision, scope).replace(
    '\n---\n\n',
    '\ntagged: !!binary aGk=\n---\n\n'
  );
  expectBrainCode(() => decodeRevision(tagged), 'INVALID_INPUT');
});

test('rejects reserved-field collisions and malformed parents', () => {
  const colliding = makeRevision(lessonFixture, {
    extra_frontmatter: { brain_id: fixtureIds.replacement }
  });
  expectBrainCode(() => encodeRevision(colliding, scope), 'INVALID_INPUT');

  const badParent = renderRevision(lessonRevision, scope).replace(
    'brain_parents: []',
    'brain_parents:\n  - not-a-uuid@zzz'
  );
  expectBrainCode(() => decodeRevision(badParent), 'INVALID_INPUT');
});

test('rejects unparseable managed notes and future schemas', () => {
  expectBrainCode(() => decodeRevision('# Not a managed note\n'), 'INVALID_INPUT');

  const unknownType = renderRevision(lessonRevision, scope).replace('type: lesson', 'type: bogus');
  expectBrainCode(() => decodeRevision(unknownType), 'INVALID_INPUT');

  const futureSchema = renderRevision(lessonRevision, scope).replace(
    'brain_schema_version: 1',
    'brain_schema_version: 2'
  );
  expectBrainCode(() => decodeRevision(futureSchema), 'UNSUPPORTED_SCHEMA');

  const badSection = renderRevision(lessonRevision, scope).replace('```yaml\n- kind: test_run', '```text\n- kind: test_run');
  expectBrainCode(() => decodeRevision(badSection), 'INVALID_INPUT');

  const badStatus = renderRevision(lessonRevision, scope).replace('brain_status: candidate', 'brain_status: bogus');
  expectBrainCode(() => decodeRevision(badStatus), 'INVALID_INPUT');

  const badTimestamp = renderRevision(lessonRevision, scope).replace(
    'created: 2026-09-01T00:00:00Z',
    'created: 2026-09-01T00:00:00+02:00'
  );
  expectBrainCode(() => decodeRevision(badTimestamp), 'INVALID_INPUT');
});

test('rejects managed fields and sections deleted by a manual edit', () => {
  const raw = renderRevision(lessonRevision, scope);
  expectBrainCode(() => decodeRevision(raw.replace(/^brain_parents: \[\]\n/m, '')), 'INVALID_INPUT');
  expectBrainCode(() => decodeRevision(raw.replace('tags:\n  - streaming\n', '')), 'INVALID_INPUT');
  expectBrainCode(() => decodeRevision(raw.replace('## Evidence\n\n', '')), 'INVALID_INPUT');
  expectBrainCode(() => decodeRevision(raw.replace('## Related\n\n', '')), 'INVALID_INPUT');
});

test('truncates the storage title so the revision suffix still fits the C3 bound', () => {
  const title = '😀'.repeat(160);
  const revision = makeRevision({ ...lessonFixture, title });
  const write = encodeRevision(revision, scope);
  expect([...write.storage_title].length).toBeLessThanOrEqual(160);
  expect(write.storage_title.endsWith(` r${fixtureIds.revision}`)).toBe(true);
  expect(write.metadata.brain_title).toBe(title);
  expect(decodeRevision(renderRevision(revision, scope)).note.title).toBe(title);
});

test('rejects an oversized rendered note instead of writing it', () => {
  const oversized = makeRevision(lessonFixture, { extra_markdown: 'x'.repeat(80 * 1024) });
  expectBrainCode(() => encodeRevision(oversized, scope), 'LIMIT_EXCEEDED');
  expectBrainCode(() => renderRevision(oversized, scope), 'LIMIT_EXCEEDED');
});

test('round-trips non-Latin text and titles containing quotes or colons', () => {
  const title = 'Aplicación 直接: "streaming" — notes';
  const revision = makeRevision({
    ...lessonFixture,
    title,
    content: {
      kind: 'lesson',
      situation: 'La aplicación 直接 se comporta distinto: "medido".',
      lesson: 'Medir antes de atribuir: la causa no es el proxy.',
      applicability: '泛用適用性。',
      limitations: ['Une seule mesure.', '未翻譯']
    }
  });
  const decoded = decodeRevision(renderRevision(revision, scope));
  expect(decoded.note.title).toBe(title);
  expect(decoded.note.content).toEqual(revision.note.content);
});

test('preserves the flexible note body as Markdown even when it repeats reserved headings', () => {
  const body = '# Title\n\n## Body\n\n## Summary\n\nStill body content.';
  const note: NoteInput = {
    title: 'Flexible markdown note',
    tags: [],
    content: { kind: 'note', summary: 'A short summary.', body_markdown: body },
    evidence: [],
    related_ids: []
  };
  const revision = makeRevision(note, { extra_markdown: '## Extra observations\n\nKept.' });
  const decoded = decodeRevision(renderRevision(revision, scope));
  expect(decoded.note.content).toEqual(note.content);
  expect(decoded.extra_markdown).toContain('Extra observations');
});

test('accepts a UTF-8 BOM and CRLF line endings without changing content', () => {
  const raw = renderRevision(lessonRevision, scope);
  const crlf = `\ufeff${raw.replace(/\n/g, '\r\n')}`;
  const decoded = decodeRevision(crlf);
  expect(decoded.note).toEqual(lessonRevision.note);
  expect(decoded.extra_markdown).toContain('## Extra observations');
});

test('reads an oversized existing note but never renders an oversized revision', () => {
  const raw = `${renderRevision(lessonRevision, scope)}\n${'x'.repeat(80 * 1024)}`;
  const decoded = decodeRevision(raw);
  expect(decoded.extra_markdown.length).toBeGreaterThan(80 * 1024);
  expectBrainCode(() => encodeRevision(decoded, scope), 'LIMIT_EXCEEDED');
  expectBrainCode(() => renderRevision(decoded, scope), 'LIMIT_EXCEEDED');
});

test('exposes a stable registry of section titles and folders', () => {
  const expected: Record<NoteContent['kind'], string[]> = {
    lesson: ['Situation', 'Lesson', 'Applicability', 'Limitations'],
    decision: ['Context', 'Decision', 'Rationale', 'Alternatives', 'Consequences', 'Reconsider when'],
    playbook: ['Use when', 'Prerequisites', 'Steps', 'Verification', 'Cautions'],
    fact: ['Claim', 'Applicability', 'Valid until'],
    preference: ['Preference', 'Applicability', 'Source statement ref', 'Exceptions'],
    session: ['Task', 'State', 'Next actions', 'Session id', 'Blockers', 'Branch', 'Repository ref'],
    note: ['Summary', 'Body']
  };
  const folders: Record<NoteContent['kind'], string> = {
    lesson: 'Lessons',
    decision: 'Decisions',
    playbook: 'Playbooks',
    fact: 'Facts',
    preference: 'Preferences',
    session: 'Sessions',
    note: 'Notes'
  };
  for (const kind of Object.keys(NOTE_REGISTRY) as NoteContent['kind'][]) {
    const titles = NOTE_REGISTRY[kind].sections.map((section) => section.title);
    expect(titles).toEqual(expected[kind]);
    expect(new Set(titles).size).toBe(titles.length);
    expect(NOTE_REGISTRY[kind].folder).toBe(folders[kind]);
    expect(NOTE_REGISTRY[kind].folder).toBe(KIND_FOLDERS[kind]);
    for (const section of NOTE_REGISTRY[kind].sections) {
      expect(sectionTitle(kind, section.field)).toBe(section.title);
    }
  }
  expect(sectionTitle('lesson', 'evidence')).toBe(EVIDENCE_SECTION_TITLE);
  expect(sectionTitle('lesson', 'related_ids')).toBe(RELATED_SECTION_TITLE);
});
