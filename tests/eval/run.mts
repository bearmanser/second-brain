import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecallRequest } from '../../src/core/types.js';
import { startDockerHarness, startLegacyHttpHarness } from '../support/harness.js';
import { scoreRetrieval, summariseRetrieval, type ScoredRetrievalCase } from './analyse.mjs';
import { makeLexicalSearch } from './lexical-backend.mjs';
import {
  dockerSeedProvider,
  httpSeedProvider,
  seedCorpus,
  type CorpusFile,
  type SeedConnectionProvider,
  type SeedRegistry
} from './seed.mjs';
import {
  RECALL_TARGET,
  retrievalGate,
  validateCaseRecord,
  validateCorpus,
  validateRetrieval,
  type RetrievalLike
} from './plan.mjs';
import { runAgentPilot } from './agent.mjs';
import { runInstructionProbe } from './instruction.mjs';
import {
  EVALUATION_MODES,
  buildCrossModeReport,
  dedupeLogicalIds,
  summariseLocalRetrieval,
  type CrossModeObservation,
  type CrossModeQuery,
  type LocalEvaluationQuery
} from '../../src/retrieval/evaluation.js';
import { readEvaluationDataset } from '../../src/retrieval/evaluation-dataset.js';
import {
  EVAL_CLIENT_NAME,
  EVAL_CLIENT_VERSION,
  REPO_ROOT,
  asRecord,
  isEntryPoint,
  parseArgs,
  stringArray,
  structuredContent,
  writeJson
} from './io.mjs';

export interface RetrievalQuery {
  id: string;
  label: 'positive' | 'negative';
  category: string;
  scope: string;
  query: string;
  topics?: string[];
  phase?: RecallRequest['phase'];
  mode?: 'hybrid' | 'text';
  limit?: number;
  kinds?: RecallRequest['kinds'];
  include_shared?: boolean;
  include_candidates?: boolean;
  session_id?: string;
  relevant: string[];
}

export interface RetrievalFile {
  version: number;
  k: number;
  forbidden_markers: string[];
  queries: RetrievalQuery[];
}

function recallArguments(query: RetrievalQuery): RecallRequest {
  const request: RecallRequest = {
    scope: query.scope,
    query: query.query,
    mode: query.mode ?? 'text',
    limit: query.limit ?? 5
  };
  if (query.topics !== undefined) request.topics = query.topics;
  if (query.phase !== undefined) request.phase = query.phase;
  if (query.kinds !== undefined) request.kinds = query.kinds;
  if (query.include_shared !== undefined) request.include_shared = query.include_shared;
  if (query.include_candidates !== undefined) request.include_candidates = query.include_candidates;
  if (query.session_id !== undefined) request.session_id = query.session_id;
  return request;
}

export type RetrievalBackend = 'basic-memory-docker' | 'lexical-fixture';

export interface RetrievalRunOutput {
  run_id: string;
  mode: 'retrieval';
  generated_at: string;
  client: { name: string; version: string };
  model_identifier: null;
  opencode_version: string | null;
  backend: RetrievalBackend;
  release_gate_backend: 'basic-memory-docker';
  release_gate_metric: boolean;
  corpus: { notes: number; seeded_keys: string[] };
  seeding: { tool_timeline: string[]; elapsed_ms: number };
  metrics: ReturnType<typeof summariseRetrieval>;
  gate: { ok: boolean; reasons: string[] };
  target_recall_at_5: number;
  forbidden_markers: string[];
  cases: Array<Record<string, unknown>>;
}

export async function runRetrieval(
  args: Map<string, string>,
  opencodeVersion: string | null
): Promise<{ output: RetrievalRunOutput; failed: boolean }> {
  const corpusPath = args.get('corpus') ?? join(REPO_ROOT, 'tests/eval/corpus.json');
  const queriesPath = args.get('queries') ?? join(REPO_ROOT, 'tests/eval/retrieval.json');
  const corpusBytes = await readFile(corpusPath);
  const queryBytes = await readFile(queriesPath);
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as CorpusFile;
  const retrieval = JSON.parse(queryBytes.toString('utf8')) as RetrievalFile;
  const corpusErrors = validateCorpus(corpus);
  const retrievalErrors = validateRetrieval(
    retrieval as unknown as RetrievalLike,
    new Set(corpus.notes.map((note) => note.key))
  );
  const fixtureErrors = [...corpusErrors, ...retrievalErrors];
  if (fixtureErrors.length > 0) {
    throw new Error(`evaluation fixtures are invalid: ${fixtureErrors.join('; ')}`);
  }
  const runId = `retrieval-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const backendArg = args.get('backend') ?? 'basic-memory-docker';
  if (backendArg !== 'basic-memory-docker' && backendArg !== 'lexical-fixture') {
    throw new Error(`unknown retrieval backend: ${backendArg}`);
  }
  const backend: RetrievalBackend = backendArg;

  let provider: SeedConnectionProvider;
  let closeTarget: () => Promise<void>;
  if (backend === 'basic-memory-docker') {
    const docker = await startDockerHarness();
    provider = dockerSeedProvider(docker);
    closeTarget = () => docker.close();
  } else {
    const http = await startLegacyHttpHarness();
    http.backend.search = makeLexicalSearch(http.backend.root);
    provider = httpSeedProvider(http);
    closeTarget = () => http.close();
  }

  const registry: SeedRegistry = { by_id: new Map(), by_key: new Map(), timeline: [] };
  const cases: Array<Record<string, unknown>> = [];
  try {
    const seedStarted = Date.now();
    await seedCorpus(provider, corpus, registry);
    const seedElapsed = Date.now() - seedStarted;

    const clients = {
      worker: await provider.connect('worker', 'second-brain-eval-worker'),
      reviewer: await provider.connect('reviewer', 'second-brain-eval-reviewer'),
      owner: await provider.connect('owner', 'second-brain-eval-owner')
    };
    try {
      for (const query of retrieval.queries) {
        const client =
          query.scope === 'profile' || query.scope === 'shared' ? clients.owner : clients.worker;
        const started = Date.now();
        const result = await client.callTool({
          name: 'brain_recall',
          arguments: recallArguments(query) as unknown as Record<string, unknown>
        });
        const elapsed = Date.now() - started;
        const structured = structuredContent(result);
        const items = Array.isArray(structured.items) ? structured.items : [];
        const retrievedIds = items.map((item) => String(asRecord(item).id));
        const retrievedKeys = retrievedIds.map((id) => registry.by_id.get(id) ?? id);
        const serialized = JSON.stringify(structured);
        const leaked = retrieval.forbidden_markers.some((marker) => serialized.includes(marker));
        const score = scoreRetrieval(retrievedKeys, query.relevant);
        const passed = leaked
          ? false
          : query.label === 'positive'
            ? query.relevant.some((key) => retrievedKeys.includes(key))
            : retrievedKeys.length === 0;
        cases.push({
          case_id: query.id,
          category: query.category,
          label: query.label,
          memory_condition: 'enabled',
          model_identifier: null,
          client: `${EVAL_CLIENT_NAME}/${EVAL_CLIENT_VERSION}`,
          scope: query.scope,
          query: query.query,
          filters: {
            kinds: query.kinds ?? null,
            include_shared: query.include_shared ?? false,
            include_candidates: query.include_candidates ?? false,
            session_id: query.session_id ?? null
          },
          retrieved_ids: retrievedIds,
          retrieved_keys: retrievedKeys,
          relevant_keys: query.relevant,
          tool_timeline: ['brain_recall'],
          outcome: passed ? 'pass' : 'fail',
          elapsed_ms: elapsed,
          token_usage: null,
          recall_at_k: score.recall_at_k,
          precision_at_k: score.precision_at_k,
          leaked
        });
      }
    } finally {
      await Promise.allSettled([
        clients.worker.close(),
        clients.reviewer.close(),
        clients.owner.close()
      ]);
    }

    const scored: ScoredRetrievalCase[] = cases.map((entry) => ({
      id: String(entry.case_id),
      label: entry.label as ScoredRetrievalCase['label'],
      relevant: stringArray(entry.relevant_keys),
      retrieved: stringArray(entry.retrieved_keys),
      score: {
        recall_at_k: Number(entry.recall_at_k),
        precision_at_k: Number(entry.precision_at_k)
      },
      leaked: entry.leaked === true,
      elapsed_ms: Number(entry.elapsed_ms)
    }));
    const metrics = summariseRetrieval(scored);
    const gate = retrievalGate(
      metrics,
      cases.map((entry) => ({
        outcome: String(entry.outcome),
        leaked: entry.leaked === true
      }))
    );
    for (const record of cases) {
      const missing = validateCaseRecord(record);
      if (missing.length > 0) {
        throw new Error(`case ${String(record.case_id)} misses required fields: ${missing.join(', ')}`);
      }
    }
    const output: RetrievalRunOutput = {
      run_id: runId,
      mode: 'retrieval',
      generated_at: new Date().toISOString(),
      client: { name: EVAL_CLIENT_NAME, version: EVAL_CLIENT_VERSION },
      model_identifier: null,
      opencode_version: opencodeVersion,
      backend,
      release_gate_backend: 'basic-memory-docker',
      release_gate_metric: backend === 'basic-memory-docker',
      corpus: { notes: corpus.notes.length, seeded_keys: [...registry.by_key.keys()] },
      seeding: { tool_timeline: registry.timeline, elapsed_ms: seedElapsed },
      metrics,
      gate,
      target_recall_at_5: RECALL_TARGET,
      forbidden_markers: retrieval.forbidden_markers,
      cases
    };
    const defaultName =
      backend === 'basic-memory-docker' ? 'retrieval.json' : 'retrieval-lexical-fixture.json';
    const outPath = args.get('out') ?? join(REPO_ROOT, 'tests/eval/results', defaultName);
    await writeJson(outPath, output);
    const exportPath = args.get('export');
    if (exportPath !== undefined) {
      await writeJson(exportPath, {
        version: 1,
        corpus_sha256: createHash('sha256').update(corpusBytes).digest('hex'),
        queries_sha256: createHash('sha256').update(queryBytes).digest('hex'),
        corpus,
        queries: retrieval,
        result: output
      });
    }
    return { output, failed: !gate.ok };
  } finally {
    await closeTarget();
  }
}

export function formatRetrievalSummary(output: RetrievalRunOutput): string {
  const lines = [
    `run ${output.run_id}`,
    `backend ${output.backend}${output.release_gate_metric ? '' : ` (offline fallback; release-gate backend is ${output.release_gate_backend})`}; notes ${output.corpus.notes}; queries ${output.metrics.cases}`,
    `recall@5 ${output.metrics.recall_at_5} (target ${output.target_recall_at_5}); precision@5 ${output.metrics.precision_at_5}`,
    `positive ${output.metrics.positive_cases}; negative ${output.metrics.negative_cases}; negative passed ${output.metrics.negative_cases_passed}; negative failed ${output.metrics.negative_cases_failed}`,
    `leakage events ${output.metrics.leakage_events}`,
    `gate ${output.gate.ok ? 'pass' : `fail (${output.gate.reasons.join('; ')})`}`,
    `mean elapsed ${output.metrics.mean_elapsed_ms} ms`
  ];
  for (const entry of output.cases) {
    const marker = entry.outcome === 'pass' ? 'pass' : 'FAIL';
    lines.push(
      `  [${marker}] ${String(entry.case_id)} ${String(entry.label)} retrieved=${JSON.stringify(entry.retrieved_keys)} relevant=${JSON.stringify(entry.relevant_keys)} recall=${String(entry.recall_at_k)} precision=${String(entry.precision_at_k)} leaked=${String(entry.leaked)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

export const RETRIEVAL_ACTIONS = ['retrieval', 'agent', 'instruction'] as const;

export interface EvaluationInvocation {
  action: 'retrieval' | 'agent' | 'instruction';
  mode: string | undefined;
  backend: string | undefined;
  dataset: string | undefined;
}

export function parseEvaluationArgs(argv: readonly string[]): EvaluationInvocation {
  const args = parseArgs([...argv]);
  const requested = args.get('mode');
  const action: EvaluationInvocation['action'] =
    requested === 'agent' || requested === 'instruction' ? requested : 'retrieval';
  const mode =
    action === 'retrieval' && requested !== undefined && requested !== 'retrieval'
      ? requested
      : undefined;
  return { action, mode, backend: args.get('backend'), dataset: args.get('dataset') };
}

export interface LocalDatasetRunOutput {
  run_id: string;
  mode: string;
  backend: 'local';
  dataset: string;
  dataset_sha256: string;
  metrics: ReturnType<typeof summariseLocalRetrieval>;
}

export async function readLocalDataset(path: string): Promise<LocalEvaluationQuery[]> {
  return (await readEvaluationDataset(path)).queries;
}

async function runLocalDatasetEvaluation(
  args: Map<string, string>,
  mode: string
): Promise<{ output: LocalDatasetRunOutput; failed: boolean }> {
  const datasetPath = args.get('dataset');
  if (datasetPath === undefined) throw new Error('--dataset is required for --backend local');
  const dataset = await readEvaluationDataset(datasetPath);
  const output: LocalDatasetRunOutput = {
    run_id: `local-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
    mode,
    backend: 'local',
    dataset: datasetPath,
    dataset_sha256: dataset.sha256,
    metrics: summariseLocalRetrieval(dataset.queries)
  };
  const outPath = args.get('out') ?? join(REPO_ROOT, 'tests/eval/results', `local-${mode}.json`);
  await writeJson(outPath, output);
  return { output, failed: false };
}

function formatLocalDatasetSummary(output: LocalDatasetRunOutput): string {
  const metrics = output.metrics;
  return [
    `run ${output.run_id}`,
    `backend local; mode ${output.mode}; dataset ${output.dataset} (${output.dataset_sha256.slice(0, 12)})`,
    `queries ${metrics.queries}; measurable recall ${metrics.measurable_recall}`,
    `candidate recall@50 ${String(metrics.candidate_recall_at_50)}; graph recall@${metrics.graph_recall_bound} ${String(metrics.graph_recall_at_50)}`,
    `nDCG@10 ${String(metrics.ndcg_at_10)}; MRR ${String(metrics.mrr)}; unjudged ${metrics.unjudged_candidates}`,
    `no-answer queries ${metrics.no_answer_queries}; no-answer false positives ${metrics.no_answer_false_positives}`,
    `fallback rate ${metrics.fallback_rate}; p50 ${String(metrics.latency_p50_ms)} ms; p95 ${String(metrics.latency_p95_ms)} ms`,
    ...Object.entries(metrics.by_slice)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([slice, entry]) =>
          `  slice ${slice}: queries ${entry.queries}; candidate recall@50 ${String(entry.candidate_recall_at_50)}; ` +
          `nDCG@10 ${String(entry.ndcg_at_10)}; fallback ${entry.fallback_rate}`
      )
  ].join('\n');
}

export interface LocalComparisonRunOutput {
  run_id: string;
  backend: 'local';
  dataset: string;
  dataset_sha256: string;
  report: ReturnType<typeof buildCrossModeReport>;
}

function comparisonObservations(query: LocalEvaluationQuery): CrossModeObservation[] {
  const textRanked = dedupeLogicalIds(query.candidates);
  const graphRanked = dedupeLogicalIds(query.graph_candidates ?? []);
  const merged = dedupeLogicalIds([...textRanked, ...graphRanked]);
  const latency = query.latency_ms;
  return [
    {
      mode: 'local_text',
      ranked: textRanked,
      available: true,
      ...(latency === undefined ? {} : { latency_ms: latency })
    },
    {
      mode: 'local_text_graph',
      ranked: merged,
      graph_ranked: graphRanked,
      available: true,
      ...(latency === undefined ? {} : { latency_ms: latency })
    },
    {
      mode: 'laya_reranked',
      ranked: textRanked,
      available: false,
      fallback: true,
      model_backed: false,
      ...(latency === undefined ? {} : { latency_ms: latency })
    }
  ];
}

async function runLocalComparison(args: Map<string, string>): Promise<LocalComparisonRunOutput> {
  const datasetPath = args.get('dataset');
  if (datasetPath === undefined) throw new Error('--dataset is required for --compare');
  const dataset = await readEvaluationDataset(datasetPath);
  const queries: CrossModeQuery[] = dataset.queries.map((query) => ({
    query_id: query.query_id,
    slice: query.slice ?? 'unspecified',
    labels: query.labels,
    eligible: dedupeLogicalIds([...query.candidates, ...(query.graph_candidates ?? [])]),
    ...(query.direct_answer === undefined ? {} : { direct_answer: query.direct_answer }),
    ...(query.no_answer === true ? { no_answer: true } : {}),
    modes: comparisonObservations(query)
  }));
  const report = buildCrossModeReport(queries, {
    rss_bytes: process.memoryUsage().rss
  });
  const output: LocalComparisonRunOutput = {
    run_id: `local-compare-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
    backend: 'local',
    dataset: datasetPath,
    dataset_sha256: dataset.sha256,
    report
  };
  const outPath = args.get('out') ?? join(REPO_ROOT, 'tests/eval/results', 'local-comparison.json');
  await writeJson(outPath, output);
  return output;
}

function formatComparisonSummary(output: LocalComparisonRunOutput): string {
  const report = output.report;
  const lines = [
    `run ${output.run_id}`,
    `backend local; dataset ${output.dataset} (${output.dataset_sha256.slice(0, 12)})`,
    `queries ${report.universe.queries}; eligible documents ${report.universe.documents}`
  ];
  for (const mode of EVALUATION_MODES) {
    const entry = report.modes[mode];
    if (!entry.available) {
      lines.push(`${mode}: NOT RUN`);
      continue;
    }
    const suffix =
      mode === 'legacy_baseline'
        ? ` (frozen aggregate: recall@5 ${report.legacy_baseline.recall_at_5}, precision@5 ${report.legacy_baseline.precision_at_5}, mean ${report.legacy_baseline.mean_elapsed_ms} ms; V2 metrics not measured)`
        : '';
    const modelSuffix =
      mode === 'laya_reranked' && report.not_run.includes('laya_reranked')
        ? ' (model-backed NOT RUN; lexical fallback order)'
        : '';
    lines.push(
      `${mode}${suffix}${modelSuffix}: recall@50 ${String(entry.candidate_recall_at_50)}; ` +
        `nDCG@10 ${String(entry.ndcg_at_10)}; MRR ${String(entry.mrr)}; ` +
        `fallback ${entry.fallback_rate}; p50 ${String(entry.latency_p50_ms)} ms; ` +
        `p95 ${String(entry.latency_p95_ms)} ms; rss ${String(entry.rss_bytes_peak)}`
    );
  }
  for (const [mode, entry] of Object.entries(report.fallback_order).sort()) {
    if (entry === undefined) continue;
    lines.push(
      `${mode} fallback order (not a model run): recall@50 ${String(entry.candidate_recall_at_50)}; ` +
        `nDCG@10 ${String(entry.ndcg_at_10)}; MRR ${String(entry.mrr)}; fallback ${entry.fallback_rate}; ` +
        `p50 ${String(entry.latency_p50_ms)} ms`
    );
  }
  for (const [mode, slices] of Object.entries(report.by_slice)) {
    for (const [slice, entry] of Object.entries(slices).sort(([left], [right]) => (left < right ? -1 : 1))) {
      lines.push(
        `  ${mode} / ${slice}: queries ${entry.queries}; recall@50 ${String(entry.candidate_recall_at_50)}; ` +
          `nDCG@10 ${String(entry.ndcg_at_10)}; MRR ${String(entry.mrr)}; fallback ${entry.fallback_rate}; ` +
          `p50 ${String(entry.latency_p50_ms)} ms`
      );
    }
  }
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const invocation = parseEvaluationArgs(argv);
  const args = parseArgs(argv);
  if (invocation.action === 'retrieval') {
    if (args.get('compare') === 'true' || invocation.mode === 'compare') {
      const output = await runLocalComparison(args);
      process.stdout.write(`${formatComparisonSummary(output)}\n`);
      return 0;
    }
    if (invocation.backend === 'local' || invocation.dataset !== undefined) {
      const { output } = await runLocalDatasetEvaluation(args, invocation.mode ?? 'text');
      process.stdout.write(`${formatLocalDatasetSummary(output)}\n`);
      return 0;
    }
    const { output, failed } = await runRetrieval(args, null);
    process.stdout.write(formatRetrievalSummary(output));
    return failed ? 1 : 0;
  }
  if (invocation.action === 'agent') {
    const result = await runAgentPilot(args);
    process.stdout.write(`${result.summary}\n`);
    return result.failed ? 1 : 0;
  }
  const result = await runInstructionProbe(args);
  process.stdout.write(`${result.summary}\n`);
  return result.failed ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
