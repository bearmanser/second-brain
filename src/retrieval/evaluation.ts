import { createHash } from 'node:crypto';

export const CANDIDATE_RECALL_K = 50;
export const GRADED_NDCG_K = 10;

export function gainForLabel(label: number): number {
  if (label !== 1 && label !== 2) return 0;
  return 2 ** label - 1;
}

function boundedK(k: number, size: number): number {
  if (!Number.isFinite(k)) return size;
  const rounded = Math.trunc(k);
  if (rounded < 0) return 0;
  return Math.min(rounded, size);
}

function distinctRanked(ranked: readonly string[], k: number): string[] {
  const limit = boundedK(k, ranked.length);
  const seen = new Set<string>();
  const output: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const id = ranked[index];
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export function recallAtK(
  relevant: ReadonlySet<string>,
  ranked: readonly string[],
  k: number
): number | null {
  if (relevant.size === 0) return null;
  const found = new Set<string>();
  for (const id of distinctRanked(ranked, k)) {
    if (relevant.has(id)) found.add(id);
  }
  return found.size / relevant.size;
}

export function ndcgAtK(
  labels: ReadonlyMap<string, 0 | 1 | 2>,
  ranked: readonly string[],
  k: number
): number | null {
  if (labels.size === 0) return null;
  const idealGains = [...labels.values()].map(gainForLabel).sort((left, right) => right - left);
  const limit = boundedK(k, Math.max(ranked.length, idealGains.length));
  const dcg = distinctRanked(ranked, limit).reduce(
    (total, id, index) => total + gainForLabel(labels.get(id) ?? 0) / Math.log2(index + 2),
    0
  );
  const idcg = idealGains
    .slice(0, limit)
    .reduce((total, gain, index) => total + gain / Math.log2(index + 2), 0);
  if (idcg === 0) return null;
  return dcg / idcg;
}

export function mrrAtK(
  relevant: ReadonlySet<string>,
  ranked: readonly string[],
  k: number
): number | null {
  if (relevant.size === 0) return null;
  const ordered = distinctRanked(ranked, k);
  for (let index = 0; index < ordered.length; index += 1) {
    if (relevant.has(ordered[index])) return 1 / (index + 1);
  }
  return 0;
}

export function unjudgedAtK(
  labels: ReadonlyMap<string, 0 | 1 | 2>,
  ranked: readonly string[],
  k: number
): number {
  return distinctRanked(ranked, k).filter((id) => !labels.has(id)).length;
}

export function noAnswerFalsePositive(ranked: readonly string[], k: number): boolean {
  return distinctRanked(ranked, k).length > 0;
}

export function meanMetric(values: readonly (number | null)[]): number | null {
  const measurable = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (measurable.length === 0) return null;
  return measurable.reduce((total, value) => total + value, 0) / measurable.length;
}

export function percentile(values: readonly number[], quantile: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const clamped = Number.isFinite(quantile) ? Math.min(Math.max(quantile, 0), 1) : 1;
  const rank = Math.max(1, Math.ceil(clamped * finite.length));
  return finite[rank - 1];
}

export interface LocalEvaluationQuery {
  query_id: string;
  query?: string;
  slice?: string;
  language?: string;
  candidates: readonly string[];
  graph_candidates?: readonly string[];
  labels: ReadonlyMap<string, 0 | 1 | 2>;
  direct_answer?: string;
  no_answer?: boolean;
  fallback?: boolean;
  latency_ms?: number;
}

export interface LocalEvaluationMetrics {
  queries: number;
  measurable_recall: number;
  candidate_recall_at_50: number | null;
  graph_recall_at_50: number | null;
  graph_recall_bound: number;
  ndcg_at_10: number | null;
  mrr: number | null;
  unjudged_candidates: number;
  no_answer_queries: number;
  no_answer_false_positives: number;
  fallback_rate: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  by_slice: Record<string, LocalSliceMetrics>;
}

export interface LocalSliceMetrics {
  queries: number;
  measurable_recall: number;
  candidate_recall_at_50: number | null;
  graph_recall_at_50: number | null;
  ndcg_at_10: number | null;
  mrr: number | null;
  unjudged_candidates: number;
  no_answer_false_positives: number;
  fallback_rate: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

export const GRAPH_RECALL_BOUND = 10;

function relevantSet(labels: ReadonlyMap<string, 0 | 1 | 2>): Set<string> {
  const relevant = new Set<string>();
  for (const [id, label] of labels) {
    if (label === 1 || label === 2) relevant.add(id);
  }
  return relevant;
}

function metricsFor(queries: readonly LocalEvaluationQuery[]): LocalSliceMetrics {
  const candidateRecall: (number | null)[] = [];
  const graphRecall: (number | null)[] = [];
  const ndcg: (number | null)[] = [];
  const mrr: (number | null)[] = [];
  let measurable = 0;
  let unjudged = 0;
  let noAnswerFalsePositives = 0;
  let fallback = 0;
  const latencies: number[] = [];
  const graphMeasured = queries.some((query) => query.graph_candidates !== undefined);
  for (const query of queries) {
    const relevant = relevantSet(query.labels);
    if (relevant.size > 0) measurable += 1;
    candidateRecall.push(recallAtK(relevant, query.candidates, CANDIDATE_RECALL_K));
    graphRecall.push(recallAtK(relevant, query.graph_candidates ?? [], GRAPH_RECALL_BOUND));
    ndcg.push(ndcgAtK(query.labels, query.candidates, GRADED_NDCG_K));
    mrr.push(
      query.direct_answer === undefined
        ? null
        : mrrAtK(new Set([query.direct_answer]), query.candidates, GRADED_NDCG_K)
    );
    unjudged += unjudgedAtK(query.labels, query.candidates, CANDIDATE_RECALL_K);
    if (query.no_answer === true && noAnswerFalsePositive(query.candidates, CANDIDATE_RECALL_K)) {
      noAnswerFalsePositives += 1;
    }
    if (query.fallback === true) fallback += 1;
    if (typeof query.latency_ms === 'number' && Number.isFinite(query.latency_ms)) {
      latencies.push(query.latency_ms);
    }
  }
  return {
    queries: queries.length,
    measurable_recall: measurable,
    candidate_recall_at_50: meanMetric(candidateRecall),
    graph_recall_at_50: graphMeasured ? meanMetric(graphRecall) : null,
    ndcg_at_10: meanMetric(ndcg),
    mrr: meanMetric(mrr),
    unjudged_candidates: unjudged,
    no_answer_false_positives: noAnswerFalsePositives,
    fallback_rate: queries.length === 0 ? 0 : fallback / queries.length,
    latency_p50_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95)
  };
}

export function summariseLocalRetrieval(
  queries: readonly LocalEvaluationQuery[]
): LocalEvaluationMetrics {
  const slices = new Map<string, LocalEvaluationQuery[]>();
  for (const query of queries) {
    const slice = query.slice ?? 'unspecified';
    const group = slices.get(slice) ?? [];
    group.push(query);
    slices.set(slice, group);
  }
  const bySlice: Record<string, LocalSliceMetrics> = {};
  for (const [slice, group] of slices) bySlice[slice] = metricsFor(group);
  const overall = metricsFor(queries);
  const noAnswerQueries = queries.filter((query) => query.no_answer === true).length;
  return { ...overall, no_answer_queries: noAnswerQueries, graph_recall_bound: GRAPH_RECALL_BOUND, by_slice: bySlice };
}

export const LEXICAL_QUESTION_ID = 'fts5_lexical';
export const LEXICAL_QUESTION_VERSION = 'lexical-2026-09-23.1';
export const RERANK_QUESTION_ID = 'note_relevance';

export interface RetrievalQueryIdentityInput {
  query: string;
  topics?: readonly string[];
  phase?: string;
  kinds?: readonly string[];
  include_candidates?: boolean;
  include_superseded?: boolean;
  include_archived?: boolean;
}

export function retrievalQueryId(input: RetrievalQueryIdentityInput): string {
  const material = JSON.stringify({
    query: input.query.replace(/\s+/gu, ' ').trim().toLowerCase(),
    topics: [...(input.topics ?? [])]
      .map((topic) => topic.replace(/\s+/gu, ' ').trim().toLowerCase())
      .filter((topic) => topic.length > 0)
      .sort(),
    phase: input.phase ?? null,
    kinds: [...(input.kinds ?? [])].sort(),
    include_candidates: input.include_candidates === true,
    include_superseded: input.include_superseded === true,
    include_archived: input.include_archived === true
  });
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

export interface LegacyRevisionReference {
  logical_id?: string;
  revision_id?: string;
  path?: string;
}

export function legacyLogicalId(
  reference: LegacyRevisionReference,
  mapping: ReadonlyMap<string, string> = new Map()
): string | undefined {
  if (reference.logical_id !== undefined) return reference.logical_id;
  if (reference.revision_id !== undefined && mapping.has(reference.revision_id)) {
    return mapping.get(reference.revision_id);
  }
  if (reference.path !== undefined && mapping.has(reference.path)) return mapping.get(reference.path);
  return reference.path ?? reference.revision_id;
}

export function dedupeLogicalIds(ids: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const id of ids) {
    if (id === undefined || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export const EVALUATION_MODES = [
  'legacy_baseline',
  'local_text',
  'local_text_graph',
  'laya_reranked'
] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export const LEGACY_BASELINE_SOURCE = 'docs/evaluation/vault-v2-baseline.md';

export interface FrozenLegacyBaseline {
  source: string;
  run_id: string;
  backend: string;
  corpus_sha256: string;
  judgments_sha256: string;
  notes: number;
  queries: number;
  positive_cases: number;
  negative_cases: number;
  recall_at_5: number;
  precision_at_5: number;
  negative_cases_passed: number;
  leakage_events: number;
  mean_elapsed_ms: number;
}

export const FROZEN_LEGACY_BASELINE: FrozenLegacyBaseline = {
  source: LEGACY_BASELINE_SOURCE,
  run_id: 'retrieval-2026-09-23T20:13:15.669Z-98b9adf0',
  backend: 'basic-memory-docker',
  corpus_sha256: '5d6ef74fc946144fca514621fd38461a3f73450d1415ea5bbbfe1d73c845569e',
  judgments_sha256: '4e1e395fde4bd148a78b7c05219e496a435b43901a6d009121fe66aa54f64305',
  notes: 11,
  queries: 23,
  positive_cases: 14,
  negative_cases: 9,
  recall_at_5: 0.9286,
  precision_at_5: 0.8536,
  negative_cases_passed: 9,
  leakage_events: 0,
  mean_elapsed_ms: 44.8
};

export interface CrossModeObservation {
  mode: EvaluationMode;
  ranked: readonly string[];
  available: boolean;
  graph_ranked?: readonly string[];
  latency_ms?: number;
  rss_bytes?: number;
  fallback?: boolean;
  model_backed?: boolean;
}

export interface CrossModeQuery {
  query_id: string;
  slice: string;
  labels: ReadonlyMap<string, 0 | 1 | 2>;
  eligible: readonly string[];
  direct_answer?: string;
  no_answer?: boolean;
  modes: readonly CrossModeObservation[];
}

export interface ModeMetrics extends LocalSliceMetrics {
  available: boolean;
  model_backed: boolean;
  graph_recall_bound: number;
  rss_bytes_peak: number | null;
}

export interface CrossModeReport {
  universe: { queries: number; documents: number };
  modes: Record<EvaluationMode, ModeMetrics>;
  fallback_order: Partial<Record<EvaluationMode, ModeMetrics>>;
  by_slice: Record<EvaluationMode, Record<string, LocalSliceMetrics>>;
  legacy_baseline: FrozenLegacyBaseline;
  not_run: EvaluationMode[];
  notes: string[];
}

export interface CrossModeOptions {
  rss_bytes?: number;
  logical_ids?: ReadonlyMap<string, string>;
}

function mapLogicalId(id: string, mapping: ReadonlyMap<string, string> | undefined): string {
  if (mapping === undefined) return id;
  return legacyLogicalId({ revision_id: id, path: id }, mapping) ?? id;
}

function unavailableMode(): ModeMetrics {
  return {
    available: false,
    model_backed: false,
    queries: 0,
    measurable_recall: 0,
    candidate_recall_at_50: null,
    graph_recall_at_50: null,
    graph_recall_bound: GRAPH_RECALL_BOUND,
    ndcg_at_10: null,
    mrr: null,
    unjudged_candidates: 0,
    no_answer_false_positives: 0,
    fallback_rate: 0,
    latency_p50_ms: null,
    latency_p95_ms: null,
    rss_bytes_peak: null
  };
}

function observationToQuery(
  query: CrossModeQuery,
  observation: CrossModeObservation,
  mapping: ReadonlyMap<string, string> | undefined
): LocalEvaluationQuery {
  return {
    query_id: query.query_id,
    slice: query.slice,
    candidates: dedupeLogicalIds(observation.ranked.map((id) => mapLogicalId(id, mapping))),
    ...(observation.graph_ranked === undefined
      ? {}
      : { graph_candidates: dedupeLogicalIds(observation.graph_ranked.map((id) => mapLogicalId(id, mapping))) }),
    labels: query.labels,
    ...(query.direct_answer === undefined ? {} : { direct_answer: mapLogicalId(query.direct_answer, mapping) }),
    ...(query.no_answer === true ? { no_answer: true } : {}),
    ...(observation.fallback === true ? { fallback: true } : {}),
    ...(observation.latency_ms === undefined ? {} : { latency_ms: observation.latency_ms })
  };
}

function modeMetricsFor(
  observations: readonly { query: CrossModeQuery; observation: CrossModeObservation }[],
  rssBytes: number | undefined,
  mapping: ReadonlyMap<string, string> | undefined
): ModeMetrics {
  const evaluations = observations.map(({ query, observation }) =>
    observationToQuery(query, observation, mapping)
  );
  const summary = summariseLocalRetrieval(evaluations);
  const rssValues = observations
    .map(({ observation }) => observation.rss_bytes)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    ...summary,
    available: true,
    model_backed: observations.some(({ observation }) => observation.model_backed === true),
    rss_bytes_peak: rssValues.length === 0 ? (rssBytes ?? null) : Math.max(...rssValues)
  };
}

export function buildCrossModeReport(
  queries: readonly CrossModeQuery[],
  options: CrossModeOptions = {}
): CrossModeReport {
  const modes = {} as Record<EvaluationMode, ModeMetrics>;
  const fallbackOrder: Partial<Record<EvaluationMode, ModeMetrics>> = {};
  const bySlice = {} as Record<EvaluationMode, Record<string, LocalSliceMetrics>>;
  const documents = new Set<string>();
  const mapping = options.logical_ids;
  for (const query of queries) {
    for (const id of query.eligible) documents.add(mapLogicalId(id, mapping));
    for (const observation of query.modes) {
      for (const id of observation.ranked) documents.add(mapLogicalId(id, mapping));
      for (const id of observation.graph_ranked ?? []) documents.add(mapLogicalId(id, mapping));
    }
  }
  for (const mode of EVALUATION_MODES) {
    if (mode === 'legacy_baseline') {
      modes[mode] = { ...unavailableMode(), available: true };
      bySlice[mode] = {};
      continue;
    }
    const raw = queries.flatMap((query) => {
      const observation = query.modes.find((entry) => entry.mode === mode);
      return observation === undefined ? [] : [{ query, observation }];
    });
    const selected = raw.filter(({ observation }) => observation.available);
    const modelBacked = selected.filter(
      ({ observation }) => mode !== 'laya_reranked' || observation.model_backed === true
    );
    const fallback = raw.filter(({ observation }) => observation.fallback === true);
    if (modelBacked.length === 0) {
      modes[mode] = unavailableMode();
      bySlice[mode] = {};
    } else {
      modes[mode] = modeMetricsFor(modelBacked, options.rss_bytes, mapping);
      bySlice[mode] = summariseLocalRetrieval(
        modelBacked.map(({ query, observation }) => observationToQuery(query, observation, mapping))
      ).by_slice;
    }
    if (fallback.length > 0) {
      fallbackOrder[mode] = modeMetricsFor(fallback, options.rss_bytes, mapping);
    }
  }
  const notRun: EvaluationMode[] = [];
  if (modes.laya_reranked.available !== true) {
    notRun.push('laya_reranked');
    const notes = [
      'laya_reranked model-backed measurement is NOT RUN: no model-produced ranking was supplied; any fallback ordering is reported under fallback_order and is not a model result'
    ];
    return finalizeCrossModeReport(queries, options, modes, fallbackOrder, bySlice, documents, notRun, notes);
  }
  return finalizeCrossModeReport(queries, options, modes, fallbackOrder, bySlice, documents, notRun, []);
}

function finalizeCrossModeReport(
  queries: readonly CrossModeQuery[],
  _options: CrossModeOptions,
  modes: Record<EvaluationMode, ModeMetrics>,
  fallbackOrder: Partial<Record<EvaluationMode, ModeMetrics>>,
  bySlice: Record<EvaluationMode, Record<string, LocalSliceMetrics>>,
  documents: ReadonlySet<string>,
  notRun: EvaluationMode[],
  extraNotes: string[]
): CrossModeReport {
  const notes = [
    `legacy baseline is the frozen aggregate recorded in ${LEGACY_BASELINE_SOURCE}; V2 candidate Recall@50, nDCG@10, MRR, RSS, and fallback rate were not measured on that pre-V2 run`
  ];
  notes.push(...extraNotes);
  return {
    universe: { queries: queries.length, documents: documents.size },
    modes,
    fallback_order: fallbackOrder,
    by_slice: bySlice,
    legacy_baseline: FROZEN_LEGACY_BASELINE,
    not_run: notRun,
    notes
  };
}
