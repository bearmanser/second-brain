import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertFreshLabel,
  assignSplits,
  defaultApproved,
  exportLabeledRetrieval,
  isExportableLabel,
  StaleLabelError,
  type RetrievalLabelInput
} from '../../src/retrieval/feedback-export.js';
import { parseArguments } from '../../src/cli.js';
import { parseEvaluationArgs } from '../eval/run.mjs';
import { Journal } from '../../src/storage/journal.js';

const temporaryDirectories: string[] = [];

function temporaryOutput(): string {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-export-'));
  temporaryDirectories.push(directory);
  return join(directory, 'labels.jsonl');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function label(
  overrides: Partial<RetrievalLabelInput> & Pick<RetrievalLabelInput, 'query_id' | 'source_hash'>
): RetrievalLabelInput {
  return {
    label_id: `label-${overrides.query_id}-${overrides.source_hash.slice(0, 4)}`,
    trace_id: `trace-${overrides.query_id}`,
    source_type: 'human_reviewed',
    label: 2,
    ...overrides
  };
}

function rows(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('unjudged candidates are never exported as negative labels', async () => {
  const output = temporaryOutput();
  const result = await exportLabeledRetrieval({
    output,
    includeText: false,
    splitSeed: 20260923,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64), label: 2, logical_id: 'doc-a' })],
    candidatesByQuery: new Map([['q1', ['doc-a', 'doc-b', 'doc-c']]])
  });
  expect(result.counts.unjudged).toBe(2);
  const exported = rows(output);
  expect(exported).toHaveLength(1);
  expect(exported.every((row) => row.label !== 0)).toBe(true);
});

test("an agent's used-this-note event is never promoted to a gold label", async () => {
  const output = temporaryOutput();
  const agentUsage = label({
    query_id: 'q1',
    source_hash: 'a'.repeat(64),
    source_type: 'agent_proposed',
    label: 2,
    logical_id: 'doc-a'
  });
  expect(defaultApproved('agent_proposed')).toBe(false);
  expect(defaultApproved('human_reviewed')).toBe(true);
  expect(isExportableLabel({ ...agentUsage, approved: false, voided_at: null })).toBe(false);
  const result = await exportLabeledRetrieval({
    output,
    includeText: false,
    splitSeed: 1,
    labels: [
      agentUsage,
      label({
        query_id: 'q2',
        source_hash: 'b'.repeat(64),
        source_type: 'human_reviewed',
        label: 2,
        logical_id: 'doc-b'
      })
    ]
  });
  expect(result.counts.excluded_not_approved).toBe(1);
  expect(rows(output)).toHaveLength(1);
  expect(rows(output)[0]?.query_id).toBe('q2');
});

test('a stale source hash is rejected for a current-version judgment', () => {
  expect(() =>
    assertFreshLabel(
      { source_hash: 'a'.repeat(64), revision_id: 'rev-1' },
      { source_hash: 'b'.repeat(64), revision_id: 'rev-1' }
    )
  ).toThrow(StaleLabelError);
  expect(() =>
    assertFreshLabel(
      { source_hash: 'a'.repeat(64), revision_id: 'rev-2' },
      { source_hash: 'a'.repeat(64), revision_id: 'rev-1' }
    )
  ).toThrow(StaleLabelError);
  expect(() =>
    assertFreshLabel(
      { source_hash: 'a'.repeat(64), revision_id: 'rev-1' },
      { source_hash: 'a'.repeat(64), revision_id: 'rev-1' }
    )
  ).not.toThrow();
});

test('near-duplicate queries and revisions never cross data splits', () => {
  const entries: RetrievalLabelInput[] = [
    label({ label_id: 'l1', query_id: 'q1', query_family: 'how does recall work', source_hash: 'a'.repeat(64), logical_id: 'doc-a' }),
    label({ label_id: 'l2', query_id: 'q2', query_family: 'how does recall work', source_hash: 'b'.repeat(64), logical_id: 'doc-b' }),
    label({ label_id: 'l3', query_id: 'q3', query_family: 'unrelated question', source_family: 'doc-a', source_hash: 'c'.repeat(64), logical_id: 'doc-a' })
  ];
  const assignment = assignSplits(entries, 20260923);
  expect(assignment.split_for.get('l1')).toBe(assignment.split_for.get('l2'));
  expect(assignment.split_for.get('l1')).toBe(assignment.split_for.get('l3'));
  expect(assignment.components).toBe(1);
  expect(assignment.limitations.length).toBeGreaterThan(0);
});

test('default exports carry hashes and metadata but no raw text', async () => {
  const output = temporaryOutput();
  const result = await exportLabeledRetrieval({
    output,
    includeText: false,
    splitSeed: 7,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64), logical_id: 'doc-a', question_id: 'relevance', question_version: '1' })],
    textLookup: {
      queryText: () => 'PRIVATE QUERY TEXT',
      noteText: () => 'PRIVATE NOTE TEXT'
    }
  });
  expect(result.manifest.include_text).toBe(false);
  const serialized = readFileSync(output, 'utf8');
  expect(serialized).not.toContain('PRIVATE QUERY TEXT');
  expect(serialized).not.toContain('PRIVATE NOTE TEXT');
  expect(serialized).toContain('a'.repeat(64));
});

test('include-text exports the approved labels with their raw text', async () => {
  const output = temporaryOutput();
  const result = await exportLabeledRetrieval({
    output,
    includeText: true,
    splitSeed: 7,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64), logical_id: 'doc-a' })],
    textLookup: {
      queryText: () => 'PRIVATE QUERY TEXT',
      noteText: () => 'PRIVATE NOTE TEXT'
    }
  });
  expect(result.manifest.include_text).toBe(true);
  const exported = rows(output);
  expect(exported[0]?.query_text).toBe('PRIVATE QUERY TEXT');
  expect(exported[0]?.note_text).toBe('PRIVATE NOTE TEXT');
});

test('voided or corrected judgments are removable from later exports', async () => {
  const output = temporaryOutput();
  const result = await exportLabeledRetrieval({
    output,
    includeText: false,
    splitSeed: 7,
    labels: [
      label({ label_id: 'kept', query_id: 'q1', source_hash: 'a'.repeat(64) }),
      label({
        label_id: 'voided',
        query_id: 'q1',
        source_hash: 'b'.repeat(64),
        voided_at: '2026-09-23T00:00:00.000Z'
      })
    ]
  });
  expect(result.counts.excluded_voided).toBe(1);
  expect(rows(output).map((row) => row.label_id)).toEqual(['kept']);
});

test('the manifest records counts, splits, and a stable hash', async () => {
  const first = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 20260923,
    labels: [
      label({ label_id: 'l1', query_id: 'q1', source_hash: 'a'.repeat(64), logical_id: 'doc-a' }),
      label({
        label_id: 'l2',
        query_id: 'q2',
        source_hash: 'b'.repeat(64),
        logical_id: 'doc-b',
        source_type: 'synthetic'
      })
    ],
    datasetId: 'local-retrieval',
    datasetSha256: 'd'.repeat(64)
  });
  const second = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 20260923,
    labels: [
      label({ label_id: 'l1', query_id: 'q1', source_hash: 'a'.repeat(64), logical_id: 'doc-a' }),
      label({
        label_id: 'l2',
        query_id: 'q2',
        source_hash: 'b'.repeat(64),
        logical_id: 'doc-b',
        source_type: 'synthetic'
      })
    ],
    datasetId: 'local-retrieval',
    datasetSha256: 'd'.repeat(64)
  });
  expect(first.counts.by_source.human_reviewed).toBe(1);
  expect(first.counts.by_source.synthetic).toBe(1);
  expect(first.counts.exported).toBe(2);
  expect(first.manifest.dataset_sha256).toBe('d'.repeat(64));
  expect(first.manifest.manifest_hash).toBe(second.manifest.manifest_hash);
  expect(first.manifest.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
});

test('the eval runner parses explicit backend, retrieval mode, and dataset', () => {
  expect(parseEvaluationArgs(['--backend', 'local', '--mode', 'text', '--dataset', '/var/lib/second-brain/evaluations/retrieval.jsonl'])).toEqual({
    action: 'retrieval',
    mode: 'text',
    backend: 'local',
    dataset: '/var/lib/second-brain/evaluations/retrieval.jsonl'
  });
  expect(parseEvaluationArgs(['--backend', 'local', '--mode', 'reranked', '--dataset', '/data/retrieval.jsonl'])).toEqual({
    action: 'retrieval',
    mode: 'reranked',
    backend: 'local',
    dataset: '/data/retrieval.jsonl'
  });
  expect(parseEvaluationArgs([])).toEqual({ action: 'retrieval', mode: undefined, backend: undefined, dataset: undefined });
});

test('the feedback export CLI parses its exact command line', () => {
  const parsed = parseArguments([
    'feedback',
    'export',
    '--output',
    '/var/lib/second-brain/evaluations/laya-training.jsonl',
    '--include-text',
    '--split-seed',
    '20260923'
  ]);
  expect(parsed.command).toBe('feedback');
  expect(parsed.positionals).toEqual(['export']);
  expect(parsed.flags.get('output')).toBe('/var/lib/second-brain/evaluations/laya-training.jsonl');
  expect(parsed.flags.get('include-text')).toBe(true);
  expect(parsed.flags.get('split-seed')).toBe('20260923');
});

test('retrieval labels are durable and a voided judgment is removable', () => {
  const journal = Journal.open(':memory:');
  try {
    const stored = journal.recordRetrievalLabel({
      trace_id: 'trace-1',
      source_type: 'agent_proposed',
      query_id: 'q1',
      logical_id: 'doc-a',
      source_hash: 'a'.repeat(64),
      label: 2
    });
    expect(stored.approved).toBe(false);
    const human = journal.recordRetrievalLabel({
      trace_id: 'trace-2',
      source_type: 'human_reviewed',
      query_id: 'q1',
      logical_id: 'doc-b',
      source_hash: 'b'.repeat(64),
      label: 2
    });
    expect(journal.listRetrievalLabels()).toHaveLength(2);
    expect(journal.voidRetrievalLabel(human.label_id, '2026-09-24T00:00:00.000Z')).toBe(1);
    expect(journal.getRetrievalLabel(human.label_id)?.voided_at).toBe('2026-09-24T00:00:00.000Z');
    expect(journal.voidRetrievalLabel(human.label_id)).toBe(0);
    expect(isExportableLabel(journal.getRetrievalLabel(human.label_id)!)).toBe(false);
  } finally {
    journal.close();
  }
});

test('retrieval traces persist versioning, fallback, and candidate positions', () => {
  const journal = Journal.open(':memory:');
  const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  try {
    journal.recordRetrievalV2({
      retrieval_id: id(0x501),
      actor_id: 'system',
      filter: { mode: 'project', identifier: 'freellmapi' },
      searched_project_ids: ['freellmapi'],
      primary_project_id: 'freellmapi',
      returned_ids: [{ scope: 'freellmapi', id: id(0xa1), revision_id: id(0xb1) }],
      item_count: 1,
      token_used: 10,
      token_limit: 1500,
      mode: 'text',
      outcome: 'ok',
      partial: false,
      duration_ms: 12,
      fallback_reason: 'disabled',
      candidate_positions: [0, 2],
      query_id: 'q-1',
      question_id: 'relevance',
      question_version: '1',
      model_fingerprint: 'f'.repeat(64)
    });
    const read = journal.getRetrievalV2(id(0x501));
    expect(read?.trace_version).toBe(1);
    expect(read?.fallback_reason).toBe('disabled');
    expect(read?.candidate_positions).toEqual([0, 2]);
    expect(read?.query_id).toBe('q-1');
    expect(read?.question_version).toBe('1');
  } finally {
    journal.close();
  }
});

interface FixtureLine {
  query_id: string;
  query: string;
  language?: string;
  slice?: string;
  candidates: string[];
  labels: Record<string, number>;
  no_answer?: boolean;
  notes: { source_hash: string; text: string }[];
}

test('the frozen local-retrieval fixture has 100 to 300 judged synthetic queries', () => {
  const fixture = fileURLToPath(new URL('../eval/fixtures/local-retrieval/dataset.jsonl', import.meta.url));
  const lines = readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
  expect(lines.length).toBeGreaterThanOrEqual(100);
  expect(lines.length).toBeLessThanOrEqual(300);
  const ids = lines.map((line) => line.query_id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const line of lines) {
    expect(Object.keys(line.labels).length).toBeGreaterThan(0);
    for (const value of Object.values(line.labels)) {
      expect([0, 1, 2]).toContain(value);
    }
    for (const note of line.notes) {
      expect(createHash('sha256').update(note.text, 'utf8').digest('hex')).toBe(note.source_hash);
    }
  }
  expect(lines.some((line) => line.language === 'no')).toBe(true);
  expect(lines.some((line) => line.no_answer === true)).toBe(true);
  expect(dirname(fixture)).toContain('local-retrieval');
});
