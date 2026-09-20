import { getEncoding } from 'js-tiktoken';
import { expect, test } from 'vitest';
import type { Head, NoteKind, RecallResult, SourceRef, StoredRevision } from '../../src/core/types.js';
import {
  BUDGET_EXHAUSTED_WARNING,
  countReferenceTokens,
  packRecall
} from '../../src/retrieval/budget.js';
import { rankEligible, type EligibleHit } from '../../src/retrieval/rank.js';

const reference = getEncoding('cl100k_base');

const operationId = '00000000-0000-4000-8000-000000000000';

function noteContent(kind: NoteKind): StoredRevision['note']['content'] {
  switch (kind) {
    case 'lesson':
      return { kind: 'lesson', situation: 'situation', lesson: 'lesson', applicability: 'applies' };
    case 'playbook':
      return {
        kind: 'playbook',
        use_when: 'use',
        prerequisites: ['p'],
        steps: ['s'],
        verification: ['v']
      };
    case 'decision':
      return { kind: 'decision', context: 'c', decision: 'd', rationale: 'r' };
    case 'session':
      return { kind: 'session', task: 't', state: 's', next_actions: ['n'], session_id: 'session-1' };
    case 'fact':
      return { kind: 'fact', claim: 'c', applicability: 'a' };
    case 'preference':
      return {
        kind: 'preference',
        preference: 'p',
        applicability: 'a',
        source_statement_ref: 'ref'
      };
    case 'note':
      return { kind: 'note', summary: 's', body_markdown: 'b' };
  }
  throw new Error('unsupported note kind');
}

function headFor(kind: NoteKind, suffix: string): Head {
  const id = `00000000-0000-4000-8000-0000000000${suffix}`;
  const revisionId = `00000000-0000-4000-8001-0000000000${suffix}`;
  const revision: StoredRevision = {
    id,
    revision_id: revisionId,
    parents: [],
    scope: 'freellmapi',
    status: 'active',
    note: {
      title: `note ${suffix}`,
      tags: [],
      content: noteContent(kind),
      evidence: [],
      related_ids: []
    },
    created_at: '2026-09-01T00:00:00.000Z',
    modified_at: '2026-09-01T00:00:00.000Z',
    operation_id: operationId,
    extra_frontmatter: {},
    extra_markdown: ''
  };
  const source: SourceRef = {
    id,
    revision_id: revisionId,
    scope: 'freellmapi',
    title: revision.note.title,
    kind,
    status: 'active',
    etag: 'a'.repeat(64),
    relative_path: `freellmapi/Lessons/${id}/${revisionId}.md`,
    warnings: []
  };
  return { revision, source, raw_hash: 'b'.repeat(64), state: 'ready' };
}

function eligible(kind: NoteKind, rank: number, suffix: string): EligibleHit {
  return { head: headFor(kind, suffix), rank, matched_section: 'section', reasons: [] };
}

function item(id: string, excerpt: string, warnings: string[] = []): RecallResult['items'][number] {
  return {
    id,
    revision_id: id,
    scope: 'freellmapi',
    title: 't',
    kind: 'lesson',
    status: 'active',
    etag: 'c'.repeat(8),
    relative_path: 'freellmapi/x.md',
    warnings,
    excerpt,
    reasons: ['backend_rank']
  };
}

const metadata = {
  retrieval_id: '11111111-1111-4111-8111-111111111111',
  mode: 'hybrid' as const,
  partial: false,
  warnings: ['kept-warning']
};

test('countReferenceTokens matches the cl100k_base reference tokenizer', () => {
  expect(countReferenceTokens('')).toBe(0);
  expect(countReferenceTokens('hello world')).toBe(reference.encode('hello world').length);
  expect(countReferenceTokens('unicorn 🦄 café')).toBe(reference.encode('unicorn 🦄 café').length);
});

test('ranks by backend rank while preserving the phase-relevant kind window', () => {
  const general = rankEligible(
    [eligible('note', 5, '01'), eligible('note', 9, '02'), eligible('note', 7, '03')],
    'general'
  );
  expect(general.map((hit) => hit.rank)).toEqual([9, 7, 5]);

  const debugging = rankEligible(
    [eligible('note', 10, '04'), eligible('lesson', 9, '05'), eligible('note', 8, '06')],
    'debugging'
  );
  expect(debugging.map((hit) => hit.head.source.kind)).toEqual(['lesson', 'note', 'note']);
  expect(debugging.map((hit) => hit.rank)).toEqual([9, 10, 8]);

  const planning = rankEligible(
    [eligible('lesson', 4, '07'), eligible('decision', 3, '08')],
    'planning'
  );
  expect(planning[0]?.head.source.kind).toBe('decision');

  const handoff = rankEligible(
    [eligible('lesson', 4, '09'), eligible('session', 3, '0a')],
    'handoff'
  );
  expect(handoff[0]?.head.source.kind).toBe('session');
});

test('does not promote a preferred kind further than two adjacent backend-rank positions', () => {
  const ranked = rankEligible(
    [
      eligible('note', 10, '0b'),
      eligible('note', 9, '0c'),
      eligible('note', 8, '0d'),
      eligible('lesson', 7, '0e')
    ],
    'debugging'
  );
  // position 4 competes with positions 2-3 and moves up exactly two places
  expect(ranked.map((hit) => hit.head.source.kind)).toEqual(['note', 'lesson', 'note', 'note']);
  expect(ranked.map((hit) => hit.rank)).toEqual([10, 7, 9, 8]);

  const far = rankEligible(
    [
      eligible('note', 10, '0f'),
      eligible('note', 9, '10'),
      eligible('note', 8, '11'),
      eligible('note', 7, '12'),
      eligible('note', 6, '13'),
      eligible('lesson', 5, '14')
    ],
    'debugging'
  );
  const lessonIndex = far.findIndex((hit) => hit.head.source.kind === 'lesson');
  expect(lessonIndex).toBeGreaterThanOrEqual(3);
});

test('tie-breaks across the boundary between backend positions three and four', () => {
  const thirdPosition = rankEligible(
    [
      eligible('note', 10, '15'),
      eligible('note', 9, '16'),
      eligible('lesson', 8, '17'),
      eligible('note', 7, '18')
    ],
    'debugging'
  );
  expect(thirdPosition.map((hit) => hit.head.source.kind)).toEqual(['lesson', 'note', 'note', 'note']);
  expect(thirdPosition.map((hit) => hit.rank)).toEqual([8, 10, 9, 7]);

  const fourthPosition = rankEligible(
    [
      eligible('note', 10, '19'),
      eligible('note', 9, '1a'),
      eligible('note', 8, '1b'),
      eligible('lesson', 7, '1c')
    ],
    'debugging'
  );
  expect(fourthPosition.map((hit) => hit.head.source.kind)).toEqual(['note', 'lesson', 'note', 'note']);
  expect(fourthPosition.map((hit) => hit.rank)).toEqual([10, 7, 9, 8]);
});

test('clamps the requested reference token budget into the validated range', () => {
  expect(packRecall([], metadata, 10).budget.limit).toBe(256);
  expect(packRecall([], metadata, 255).budget.limit).toBe(256);
  expect(packRecall([], metadata, 1500).budget.limit).toBe(1500);
  expect(packRecall([], metadata, 4000).budget.limit).toBe(4000);
  expect(packRecall([], metadata, 999999).budget.limit).toBe(4000);
});

test('used is the reference token count of the serialized result and never exceeds the limit', () => {
  const result = packRecall([item('id-a', 'hello world')], metadata, 1500);
  expect(result.budget.used).toBe(countReferenceTokens(JSON.stringify(result)));
  expect(result.budget.used).toBeLessThanOrEqual(result.budget.limit);

  for (const budget of [1, 256, 512, 1500, 4000, 999999]) {
    const packed = packRecall([item('id-b', 'some excerpt text')], metadata, budget);
    expect(packed.budget.used).toBe(countReferenceTokens(JSON.stringify(packed)));
    expect(packed.budget.used).toBeLessThanOrEqual(packed.budget.limit);
  }
});

test('trims excerpts to fit the budget and keeps every warning label', () => {
  const items = Array.from({ length: 12 }, (_value, index) =>
    item(`00000000-0000-4000-8000-0000000000${index.toString(16)}`, 'word '.repeat(2000))
  );
  const packed = packRecall(items, metadata, 256);
  expect(packed.budget.used).toBeLessThanOrEqual(256);
  expect(packed.budget.used).toBe(countReferenceTokens(JSON.stringify(packed)));
  expect(packed.partial).toBe(true);
  expect(packed.warnings).toContain(BUDGET_EXHAUSTED_WARNING);
  expect(packed.warnings).toContain('kept-warning');
  expect(packed.items.length).toBeGreaterThanOrEqual(1);
  expect(packed.items.length).toBeLessThan(12);
});

test('never splits a Unicode code point when trimming an excerpt', () => {
  const excerpt =
    'alpha beta gamma delta '.repeat(120) + '😀🌍🚀🌟'.repeat(30);
  const packed = packRecall([item('id-astral', excerpt)], metadata, 256);
  const result = packed.items[0]?.excerpt ?? '';
  expect(result.includes('\uFFFD')).toBe(false);
  expect([...result].join('')).toBe(result);
  expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test('keeps the serialized result under the hard 128 KiB byte cap', () => {
  const items = Array.from({ length: 12 }, (_value, index) =>
    item(`id-${index}`, 'alpha beta gamma delta '.repeat(600))
  );
  const packed = packRecall(items, metadata, 4000);
  expect(packed.budget.used).toBeLessThanOrEqual(4000);
  expect(Buffer.byteLength(JSON.stringify(packed), 'utf8')).toBeLessThanOrEqual(128 * 1024);
});

test('pre-bounds a pathological excerpt before tokenizing it', () => {
  const packed = packRecall([item('id-pathological', 'x'.repeat(200000))], metadata, 1500);
  expect(packed.budget.used).toBeLessThanOrEqual(packed.budget.limit);
  expect(packed.items[0]?.excerpt.length ?? 0).toBeLessThanOrEqual(1100);
  expect([...(packed.items[0]?.excerpt ?? '')].join('')).toBe(packed.items[0]?.excerpt ?? '');
});
