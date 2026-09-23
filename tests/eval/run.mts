import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecallRequest } from '../../src/core/types.js';
import { startDockerHarness, startHttpHarness } from '../support/harness.js';
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
  EVAL_CLIENT_NAME,
  EVAL_CLIENT_VERSION,
  REPO_ROOT,
  asRecord,
  isEntryPoint,
  parseArgs,
  readJson,
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
  const corpus = await readJson<CorpusFile>(corpusPath);
  const retrieval = await readJson<RetrievalFile>(queriesPath);
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
    const http = await startHttpHarness();
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
      const [corpusBytes, queryBytes] = await Promise.all([readFile(corpusPath), readFile(queriesPath)]);
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

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const mode = args.get('mode') ?? 'retrieval';
  if (mode === 'retrieval') {
    const { output, failed } = await runRetrieval(args, null);
    process.stdout.write(formatRetrievalSummary(output));
    return failed ? 1 : 0;
  }
  if (mode === 'agent') {
    const result = await runAgentPilot(args);
    process.stdout.write(`${result.summary}\n`);
    return result.failed ? 1 : 0;
  }
  if (mode === 'instruction') {
    const result = await runInstructionProbe(args);
    process.stdout.write(`${result.summary}\n`);
    return result.failed ? 1 : 0;
  }
  process.stderr.write(`unknown mode: ${mode}\n`);
  return 2;
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
