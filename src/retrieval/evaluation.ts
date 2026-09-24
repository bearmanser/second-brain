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
    graph_recall_at_50: meanMetric(graphRecall),
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
