import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { scoreRetrieval, type RetrievalSummary } from '../eval/analyse.mjs';
import {
  MAX_PILOT_RUNS,
  MIN_NEGATIVE_QUERIES,
  MIN_POSITIVE_QUERIES,
  RECALL_TARGET,
  disabledIsolationOk,
  effectiveMcpServers,
  enabledMcpServers,
  instructionStatus,
  pilotOutcome,
  planPilotRuns,
  retrievalGate,
  validateCaseRecord,
  validateCorpus,
  validateRetrieval,
  type CorpusLike,
  type RetrievalLike
} from '../eval/plan.mjs';
import { startHttpHarness } from '../support/harness.js';
import { modelTextFromEvents } from '../eval/instruction.mjs';
import { parseAgentEvents } from '../eval/agent.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as T;
}

const corpus = readJson<CorpusLike>('tests/eval/corpus.json');
const retrieval = readJson<RetrievalLike>('tests/eval/retrieval.json');

function cleanMetrics(overrides: Partial<RetrievalSummary> = {}): RetrievalSummary {
  return {
    cases: 1,
    positive_cases: 1,
    negative_cases: 0,
    recall_at_5: 1,
    precision_at_5: 1,
    recall_target_met: true,
    negative_cases_passed: 0,
    negative_cases_failed: 0,
    leakage_events: 0,
    mean_elapsed_ms: 1,
    ...overrides
  };
}

test('calculates relevance using labels rather than backend scores', () => {
  expect(scoreRetrieval(['n1', 'n3'], ['n1', 'n2'])).toEqual({
    recall_at_k: 0.5,
    precision_at_k: 0.5
  });
});

test('treats duplicate ids as a single retrieved source', () => {
  expect(scoreRetrieval(['n1', 'n1', 'n2'], ['n1', 'n2'])).toEqual({
    recall_at_k: 1,
    precision_at_k: 1
  });
});

test('scores an empty positive label set by whether anything leaked', () => {
  expect(scoreRetrieval([], [])).toEqual({ recall_at_k: 1, precision_at_k: 0 });
  expect(scoreRetrieval(['n9'], [])).toEqual({ recall_at_k: 0, precision_at_k: 0 });
});

test('the SDK initialization response carries the gateway guidance', async () => {
  const harness = await startHttpHarness();
  try {
    const client = await harness.connect(harness.token, 'second-brain-eval-instructions');
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('brain_recall');
      expect(instructions).toContain('candidate');
      expect(instructions).toContain('untrusted data');
    } finally {
      await client.close();
    }
  } finally {
    await harness.close();
  }
});

test('the corpus has unique identities and covers every required fixture', () => {
  expect(validateCorpus(corpus)).toEqual([]);
  const keys = corpus.notes.map((note) => note.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const required of [
    'streaming-lesson',
    'routing-decision',
    'legacy-routing-superseded',
    'cache-warm-playbook',
    'batching-hypothesis',
    'quota-expired-fact',
    'profile-secret',
    'handoff-session',
    'misleading-note',
    'ttft-paraphrase'
  ]) {
    expect(keys).toContain(required);
  }
});

test('the retrieval labels are valid and meet the query minimums', () => {
  const keys = new Set(corpus.notes.map((note) => note.key));
  expect(validateRetrieval(retrieval, keys)).toEqual([]);
  const positive = retrieval.queries.filter((query) => query.label === 'positive');
  const negative = retrieval.queries.filter((query) => query.label !== 'positive');
  expect(positive.length).toBeGreaterThanOrEqual(MIN_POSITIVE_QUERIES);
  expect(negative.length).toBeGreaterThanOrEqual(MIN_NEGATIVE_QUERIES);
});

test('the pilot run plan is capped before starting', () => {
  expect(planPilotRuns(6, 2, MAX_PILOT_RUNS)).toBe(MAX_PILOT_RUNS);
  expect(planPilotRuns(6, 2, 10)).toBe(10);
  expect(planPilotRuns(100, 100, 1000)).toBe(MAX_PILOT_RUNS);
  expect(planPilotRuns(0, 2, MAX_PILOT_RUNS)).toBe(0);
});

test('the retrieval gate fails on leaks, negative failures, failed cases, and low recall', () => {
  expect(retrievalGate(cleanMetrics(), [{ outcome: 'pass', leaked: false }]).ok).toBe(true);
  expect(retrievalGate(cleanMetrics({ leakage_events: 1 }), [{ outcome: 'pass', leaked: true }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ negative_cases_failed: 1 }), [{ outcome: 'pass', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics(), [{ outcome: 'fail', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ recall_at_5: RECALL_TARGET - 0.01 }), [{ outcome: 'pass', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ recall_at_5: 0.5 }), [{ outcome: 'pass', leaked: false }], 0.4).ok).toBe(true);
});

test('the case record schema requires the mandated fields', () => {
  const complete: Record<string, unknown> = {
    case_id: 'r01',
    memory_condition: 'enabled',
    model_identifier: null,
    client: 'second-brain-eval/0.1.0',
    retrieved_ids: [],
    tool_timeline: ['brain_recall'],
    outcome: 'pass',
    elapsed_ms: 1,
    token_usage: null
  };
  expect(validateCaseRecord(complete)).toEqual([]);
  const missing: Record<string, unknown> = { ...complete };
  delete missing.retrieved_ids;
  expect(validateCaseRecord(missing)).toContain('retrieved_ids');
  expect(validateCaseRecord({ ...complete, token_usage: 0 })).toContain('token_usage is neither null nor an object');
});

test('effective MCP servers merge later documents over earlier ones', () => {
  const servers = effectiveMcpServers([
    { info: { mcp: { servers: { browsermcp: { type: 'local' }, 'second-brain': { type: 'remote' } } } } },
    { info: { mcp: { servers: { 'second-brain': { type: 'remote', disabled: true } } } } }
  ]);
  expect(servers).toEqual([
    { name: 'browsermcp', disabled: false },
    { name: 'second-brain', disabled: true }
  ]);
});

test('enabled MCP servers are detected regardless of alias, and disabled isolation requires zero', () => {
  const withAlias = [
    { name: 'browsermcp', disabled: false },
    { name: 'my-brain-endpoint', disabled: false }
  ];
  expect(enabledMcpServers(withAlias).map((server) => server.name)).toEqual([
    'browsermcp',
    'my-brain-endpoint'
  ]);
  expect(disabledIsolationOk(withAlias)).toEqual({
    ok: false,
    enabled: ['browsermcp', 'my-brain-endpoint']
  });
  const fullyDisabled = [
    { name: 'browsermcp', disabled: true },
    { name: 'my-brain-endpoint', disabled: true }
  ];
  expect(disabledIsolationOk(fullyDisabled)).toEqual({ ok: true, enabled: [] });
  expect(disabledIsolationOk([])).toEqual({ ok: true, enabled: [] });
});

test('an invalid isolation run makes the pilot aggregate non-RUN and failed', () => {
  expect(pilotOutcome([{ outcome: 'matched' }, { outcome: 'missed' }])).toEqual({
    status: 'RUN',
    failed: false,
    reasons: []
  });
  const invalid = pilotOutcome([{ outcome: 'matched' }, { outcome: 'invalid_isolation' }]);
  expect(invalid.status).not.toBe('RUN');
  expect(invalid.failed).toBe(true);
  expect(invalid.reasons.join(' ')).toContain('invalid isolation');
});

test('instruction evidence is read from the model text, not raw tool payloads', () => {
  const stdout = [
    JSON.stringify({ type: 'tool_use', part: { tool: 'x', state: { output: 'FACT-LEAK-1' } } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'the fact is FACT-REPORTED' } })
  ].join('\n');
  const text = modelTextFromEvents(stdout);
  expect(text).toContain('FACT-REPORTED');
  expect(text).not.toContain('FACT-LEAK-1');
  const onlyTool = JSON.stringify({
    type: 'tool_use',
    part: { tool: 'x', state: { output: 'FACT-LEAK-2' } }
  });
  expect(modelTextFromEvents(onlyTool)).not.toContain('FACT-LEAK-2');
});

test('instruction RUN requires preflight, a clean exit, and the marker', () => {
  const base = {
    preflight_visible: true,
    exit_code: 0,
    timed_out: false,
    marker_seen: true,
    fact_seen: false
  };
  expect(instructionStatus(base).status).toBe('RUN');
  expect(instructionStatus(base).observed).toEqual({ marker: true, fact: false, tool_payload: false });
  expect(instructionStatus({ ...base, preflight_visible: false }).status).toBe('NOT RUN');
  expect(instructionStatus({ ...base, exit_code: 1 }).status).toBe('NOT RUN');
  expect(instructionStatus({ ...base, timed_out: true }).status).toBe('NOT RUN');
  expect(instructionStatus({ ...base, marker_seen: false }).status).toBe('NOT RUN');
  expect(instructionStatus({ ...base, marker_seen: false, fact_seen: true }).status).toBe('NOT RUN');
  expect(instructionStatus({ ...base, marker_seen: false, fact_seen: true }).observed.tool_payload).toBe(true);
});

test('agent evidence separates tool payloads from model answers and records behavior timing', () => {
  const stdout = [
    JSON.stringify({ type: 'tool_use', part: { tool: 'brain_recall', state: { status: 'completed', output: JSON.stringify({ items: [{ id: 'memory-1' }] }) } } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Implemented the bounded retry and added tests.' } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'brain_capture', state: { status: 'completed', output: JSON.stringify({ outcome: 'stored' }) } } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'brain_review', state: { status: 'completed', output: JSON.stringify({ outcome: 'stored' }) } } })
  ].join('\n');
  const parsed = parseAgentEvents(stdout);
  expect(parsed.answer_text).toContain('Implemented the bounded retry');
  expect(parsed.answer_text).not.toContain('memory-1');
  expect(parsed.tool_timeline).toEqual(['brain_recall', 'brain_capture', 'brain_review']);
  expect(parsed.retrieved_ids).toEqual(['memory-1']);
  expect(parsed.recall_before_substantive_work).toBe(true);
  expect(parsed.candidates_captured).toBe(1);
  expect(parsed.review_performed).toBe(true);
});

test('agent tasks are substantive work rather than memory quotation lookups', () => {
  const tasks = readJson<{ tasks: { prompt: string; expected_artifact: string }[] }>('tests/eval/tasks.json');
  expect(tasks.tasks).toHaveLength(6);
  for (const task of tasks.tasks) {
    expect(task.expected_artifact.length).toBeGreaterThan(0);
    expect(task.prompt).not.toMatch(/quote|recite/i);
    expect(task.prompt).toMatch(/implement|debug|design|review|plan|write/i);
  }
});
