import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertFreshLabel,
  assignSplits,
  authorRetrievalLabel,
  ConflictingLabelError,
  defaultApproved,
  exportLabeledRetrieval,
  isExportableLabel,
  StaleLabelError,
  type RetrievalLabelInput
} from '../../src/retrieval/feedback-export.js';
import { parseArguments, runCli } from '../../src/cli.js';
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

test('the feedback label CLI parses its exact command line', () => {
  const hash = 'a'.repeat(64);
  const parsed = parseArguments([
    'feedback',
    'label',
    '--query-id',
    'q-1',
    '--source-type',
    'human_reviewed',
    '--label',
    '2',
    '--source-hash',
    hash,
    '--path',
    'Projects/Beta/Note.md',
    '--notes',
    'direct support'
  ]);
  expect(parsed.command).toBe('feedback');
  expect(parsed.positionals).toEqual(['label']);
  expect(parsed.flags.get('query-id')).toBe('q-1');
  expect(parsed.flags.get('source-type')).toBe('human_reviewed');
  expect(parsed.flags.get('label')).toBe('2');
  expect(parsed.flags.get('source-hash')).toBe(hash);
  expect(parsed.flags.get('path')).toBe('Projects/Beta/Note.md');
  expect(parsed.flags.get('notes')).toBe('direct support');
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

test('authorRetrievalLabel is idempotent, rejects stale hashes, and never approves agent usage', () => {
  const journal = Journal.open(':memory:');
  try {
    const base = {
      trace_id: 'trace-1',
      query_id: 'q1',
      source_type: 'human_reviewed' as const,
      source_hash: 'a'.repeat(64),
      logical_id: 'doc-a',
      label: 2 as const,
      current: { source_hash: 'a'.repeat(64) }
    };
    const first = authorRetrievalLabel(journal, base);
    expect(first.created).toBe(true);
    const replay = authorRetrievalLabel(journal, base);
    expect(replay).toMatchObject({ created: false, recorded: true, label_id: first.label_id });
    expect(journal.listRetrievalLabels()).toHaveLength(1);
    expect(() => authorRetrievalLabel(journal, { ...base, label: 1 })).toThrow(ConflictingLabelError);
    expect(() =>
      authorRetrievalLabel(journal, { ...base, current: { source_hash: 'b'.repeat(64) } })
    ).toThrow(StaleLabelError);
    const agent = authorRetrievalLabel(journal, {
      ...base,
      logical_id: 'doc-b',
      source_hash: 'c'.repeat(64),
      current: { source_hash: 'c'.repeat(64) },
      source_type: 'agent_proposed'
    });
    expect(journal.getRetrievalLabel(agent.label_id)?.approved).toBe(false);
  } finally {
    journal.close();
  }
});

test('manifest_hash covers exported label content, not only counts', async () => {
  const first = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 1,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64), label: 1 })]
  });
  const second = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 1,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64), label: 2 })]
  });
  expect(first.counts.exported).toBe(second.counts.exported);
  expect(first.manifest.content_sha256).not.toBe(second.manifest.content_sha256);
  expect(first.manifest.manifest_hash).not.toBe(second.manifest.manifest_hash);
});

test('the manifest records aggregated model fingerprints and question versions', async () => {
  const labels = [label({ query_id: 'q1', source_hash: 'a'.repeat(64) })];
  const withMetadata = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 1,
    labels,
    modelFingerprints: ['f'.repeat(64)],
    questionVersions: ['relevance-2026-09-23.1']
  });
  expect(withMetadata.manifest.model_fingerprints).toEqual(['f'.repeat(64)]);
  expect(withMetadata.manifest.question_versions).toEqual(['relevance-2026-09-23.1']);
  const withoutMetadata = await exportLabeledRetrieval({
    output: temporaryOutput(),
    includeText: false,
    splitSeed: 1,
    labels
  });
  expect(withoutMetadata.manifest.manifest_hash).not.toBe(withMetadata.manifest.manifest_hash);
});

test('include-text is fail-closed per row when text is unavailable', async () => {
  const output = temporaryOutput();
  const result = await exportLabeledRetrieval({
    output,
    includeText: true,
    splitSeed: 1,
    labels: [label({ query_id: 'q1', source_hash: 'a'.repeat(64) })],
    textLookup: { queryText: () => 'PRIVATE QUERY', noteText: () => undefined }
  });
  expect(result.counts.exported).toBe(0);
  expect(result.counts.excluded_missing_text).toBe(1);
  expect(rows(output)).toHaveLength(0);
});

test('feedback label and void round-trip through the CLI over a temporary state volume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'feedback-state-'));
  temporaryDirectories.push(root);
  const state = join(root, 'state');
  const vault = join(root, 'vault');
  mkdirSync(state, { recursive: true });
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  const noteRelative = 'Notes/Trace.md';
  const noteRaw = '# Trace\n\nsource text\n';
  writeFileSync(join(vault, noteRelative), noteRaw);
  const hash = createHash('sha256').update(noteRaw, 'utf8').digest('hex');
  const output = join(state, 'laya-training.jsonl');
  const voidedOutput = join(state, 'voided.jsonl');
  const labelArgs = [
    'feedback',
    'label',
    '--state',
    state,
    '--vault',
    vault,
    '--trace-id',
    'trace-e2e',
    '--query-id',
    'q-e2e',
    '--source-type',
    'human_reviewed',
    '--label',
    '2',
    '--source-hash',
    hash,
    '--path',
    noteRelative,
    '--logical-id',
    'note-a',
    '--question-version',
    'relevance-2026-09-23.1',
    '--model-fingerprint',
    'f'.repeat(64),
    '--notes',
    'direct support'
  ];
  expect(await runCli(labelArgs, {})).toBe(0);
  expect(await runCli(labelArgs, {})).toBe(0);
  expect(
    await runCli(['feedback', 'export', '--state', state, '--output', output, '--split-seed', '20260923'], {})
  ).toBe(0);
  const exported = rows(output);
  expect(exported).toHaveLength(1);
  expect(exported[0]?.label).toBe(2);
  expect(exported[0]?.source_type).toBe('human_reviewed');
  expect(exported[0]?.model_fingerprint).toBe('f'.repeat(64));
  expect(exported[0]?.question_version).toBe('relevance-2026-09-23.1');

  const labelId = String(exported[0]?.label_id);
  expect(await runCli(['feedback', 'void', '--state', state, '--label-id', labelId], {})).toBe(0);
  expect(
    await runCli(['feedback', 'export', '--state', state, '--output', voidedOutput, '--split-seed', '20260923'], {})
  ).toBe(0);
  expect(rows(voidedOutput)).toHaveLength(0);
});

function labelVaultFixture(): { root: string; state: string; vault: string; hash: string; noteRelative: string } {
  const root = mkdtempSync(join(tmpdir(), 'feedback-fresh-'));
  temporaryDirectories.push(root);
  const state = join(root, 'state');
  const vault = join(root, 'vault');
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  mkdirSync(state, { recursive: true });
  const noteRelative = 'Notes/Fresh.md';
  const raw = '# Fresh\n\nfresh source\n';
  writeFileSync(join(vault, noteRelative), raw);
  return {
    root,
    state,
    vault,
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    noteRelative
  };
}

function labelArguments(
  fixture: { state: string; vault: string; noteRelative: string },
  sourceHash: string,
  path: string,
  queryId: string
): string[] {
  return [
    'feedback',
    'label',
    '--state',
    fixture.state,
    '--vault',
    fixture.vault,
    '--query-id',
    queryId,
    '--source-type',
    'human_reviewed',
    '--label',
    '1',
    '--source-hash',
    sourceHash,
    '--path',
    path,
    '--logical-id',
    'note-fresh'
  ];
}

test('a fresh label succeeds from a live vault path and a stale source hash is rejected', async () => {
  const fixture = labelVaultFixture();
  expect(
    await runCli(labelArguments(fixture, fixture.hash, fixture.noteRelative, 'q-fresh'), {})
  ).toBe(0);
  await expect(
    runCli(labelArguments(fixture, 'a'.repeat(64), fixture.noteRelative, 'q-stale'), {})
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('labeling fails closed when the source file is missing or outside the vault', async () => {
  const fixture = labelVaultFixture();
  await expect(
    runCli(labelArguments(fixture, fixture.hash, 'Notes/Missing.md', 'q-missing'), {})
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    runCli(labelArguments(fixture, fixture.hash, '../escape.md', 'q-outside'), {})
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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
  const embeddedHashes = new Map<string, string>();
  for (const line of lines) {
    expect(Object.keys(line.labels).length).toBeGreaterThan(0);
    for (const value of Object.values(line.labels)) {
      expect([0, 1, 2]).toContain(value);
    }
    for (const note of line.notes) {
      expect(createHash('sha256').update(note.text, 'utf8').digest('hex')).toBe(note.source_hash);
      const previous = embeddedHashes.get(note.source_hash);
      if (previous !== undefined) expect(previous).toBe(note.text);
      embeddedHashes.set(note.source_hash, note.text);
    }
  }
  const committedHashes = JSON.parse(
    readFileSync(join(dirname(fixture), 'source-hashes.json'), 'utf8')
  ) as Record<string, string>;
  const committedValues = [...new Set(Object.values(committedHashes))].sort();
  const embeddedValues = [...new Set(embeddedHashes.keys())].sort();
  expect(embeddedValues).toEqual(committedValues);
  expect(lines.some((line) => line.language === 'no')).toBe(true);
  expect(lines.some((line) => line.no_answer === true)).toBe(true);
  expect(dirname(fixture)).toContain('local-retrieval');
});
