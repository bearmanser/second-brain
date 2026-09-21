export interface RetrievalScore {
  recall_at_k: number;
  precision_at_k: number;
}

export function scoreRetrieval(actual: string[], relevant: string[]): RetrievalScore {
  const relevantSet = new Set(relevant);
  const retrieved = [...new Set(actual)];
  const hits = retrieved.filter((id) => relevantSet.has(id)).length;
  const recall_at_k =
    relevant.length === 0 ? (retrieved.length === 0 ? 1 : 0) : hits / relevant.length;
  const precision_at_k = retrieved.length === 0 ? 0 : hits / retrieved.length;
  return { recall_at_k, precision_at_k };
}

export interface ScoredRetrievalCase {
  id: string;
  label: 'positive' | 'negative' | 'scoping';
  relevant: string[];
  retrieved: string[];
  score: RetrievalScore;
  leaked: boolean;
  elapsed_ms: number;
}

export interface RetrievalSummary {
  cases: number;
  positive_cases: number;
  negative_cases: number;
  recall_at_5: number;
  precision_at_5: number;
  recall_target_met: boolean;
  negative_cases_passed: number;
  negative_cases_failed: number;
  leakage_events: number;
  mean_elapsed_ms: number;
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summariseRetrieval(
  cases: ScoredRetrievalCase[],
  target = 0.8
): RetrievalSummary {
  const positive = cases.filter((entry) => entry.label === 'positive');
  const negative = cases.filter((entry) => entry.label !== 'positive');
  const recall = mean(positive.map((entry) => entry.score.recall_at_k));
  const precision = mean(positive.map((entry) => entry.score.precision_at_k));
  const negativePassed = negative.filter((entry) => !entry.leaked && entry.retrieved.length === 0);
  const negativeFailed = negative.filter((entry) => entry.leaked || entry.retrieved.length > 0);
  return {
    cases: cases.length,
    positive_cases: positive.length,
    negative_cases: negative.length,
    recall_at_5: round(recall),
    precision_at_5: round(precision),
    recall_target_met: positive.length > 0 && recall >= target,
    negative_cases_passed: negativePassed.length,
    negative_cases_failed: negativeFailed.length,
    leakage_events: cases.filter((entry) => entry.leaked).length,
    mean_elapsed_ms: round(mean(cases.map((entry) => entry.elapsed_ms)), 1)
  };
}
