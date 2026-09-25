import { randomUUID } from 'node:crypto';
import {
  LAYA_DEADLINE_MS,
  LAYA_MAX_CANDIDATES,
  type LayaCandidate,
  type LayaProbabilities,
  type LayaScoreResult
} from './laya-protocol.js';
import type { Candidate } from './query.js';
import {
  DEFAULT_MAX_CANDIDATES_PER_NOTE,
  rankCandidateChunks,
  selectDistinctCandidateChunks
} from './rank.js';

export const RERANKER_UNAVAILABLE = 'RERANKER_UNAVAILABLE' as const;
export const RERANKER_WARNING_UNAVAILABLE = 'reranker_unavailable';

export type RerankerFallbackReason =
  | 'disabled'
  | 'starting'
  | 'unavailable'
  | 'overloaded'
  | 'timeout'
  | 'cancelled'
  | 'deadline'
  | 'malformed'
  | 'invalid_scores';

export class RerankerUnavailableError extends Error {
  readonly code = RERANKER_UNAVAILABLE;
  readonly reason: RerankerFallbackReason;

  constructor(reason: RerankerFallbackReason) {
    super(`reranker unavailable: ${reason}`);
    this.name = 'RerankerUnavailableError';
    this.reason = reason;
  }
}

export interface RerankWorkerHealth {
  state: 'disabled' | 'starting' | 'ready' | 'unavailable';
  reason?: string;
  model_fingerprint?: string;
  question_version?: string;
}

export interface RerankWorker {
  health(): RerankWorkerHealth;
  score(input: {
    request_id: string;
    query: string;
    candidates: readonly LayaCandidate[];
    signal?: AbortSignal;
  }): Promise<LayaScoreResult>;
  close?(): Promise<void>;
}

export interface RerankedCandidate extends Candidate {
  relevance_score?: number;
}

export interface RerankInput {
  query: string;
  candidates: readonly Candidate[];
  worker: RerankWorker;
  signal?: AbortSignal;
  allowFallback?: boolean;
  maxCandidates?: number;
  deadlineMs?: number;
}

export interface RerankResult {
  items: RerankedCandidate[];
  mode: 'text' | 'reranked';
  warnings: string[];
  model_fingerprint?: string;
  question_version?: string;
}

export interface FinalCandidatePolicy {
  maxItems?: number;
  maxPerNote?: number;
  isEligible?: (candidate: RerankedCandidate) => boolean;
  currentHash?: (candidate: RerankedCandidate) => string | undefined;
}

export function relevanceScore(p: { A: number; B: number; C: number }): number {
  const values = [p.A, p.B, p.C];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(total - 1) > 0.002) {
    throw new Error('invalid relevance distribution');
  }
  return (p.A + 0.5 * p.B) / total;
}

function copyCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    reasons: [...candidate.reasons],
    reference_tokens: [...candidate.reference_tokens]
  };
}

function toLayaCandidate(candidate: Candidate): LayaCandidate {
  return {
    chunk_key: candidate.chunk_key,
    title: candidate.title,
    heading: candidate.heading,
    excerpt: candidate.text
  };
}

function workerFailureReason(error: unknown): RerankerFallbackReason {
  const reason =
    typeof error === 'object' && error !== null && 'reason' in error
      ? (error as { reason?: unknown }).reason
      : undefined;
  switch (reason) {
    case 'disabled':
      return 'disabled';
    case 'starting':
    case 'not_started':
    case 'restarting':
      return 'starting';
    case 'overloaded':
      return 'overloaded';
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'input_too_long':
    case 'invalid_request':
    case 'inference_failed':
      return 'malformed';
    default:
      return 'unavailable';
  }
}

function validateScores(
  evaluated: readonly Candidate[],
  result: LayaScoreResult
): Map<string, number> | RerankerFallbackReason {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.scores)) return 'malformed';
  const expected = new Set(evaluated.map((candidate) => candidate.chunk_key));
  if (result.scores.length !== evaluated.length) return 'malformed';
  const values = new Map<string, number>();
  for (const score of result.scores) {
    if (typeof score !== 'object' || score === null) return 'malformed';
    const key = (score as { chunk_key?: unknown }).chunk_key;
    if (typeof key !== 'string' || !expected.has(key) || values.has(key)) return 'malformed';
    const probabilities = (score as { probabilities?: LayaProbabilities }).probabilities;
    if (probabilities === undefined) return 'malformed';
    try {
      values.set(key, relevanceScore(probabilities));
    } catch {
      return 'invalid_scores';
    }
  }
  for (const candidate of evaluated) {
    if (!values.has(candidate.chunk_key)) return 'malformed';
  }
  return values;
}

export async function rerankCandidates(input: RerankInput): Promise<RerankResult> {
  const { query, candidates, worker, signal, allowFallback = true } = input;
  const maxCandidates = input.maxCandidates ?? LAYA_MAX_CANDIDATES;
  const original = candidates.map(copyCandidate);
  const fallback = (
    reason: RerankerFallbackReason,
    model_fingerprint?: string
  ): RerankResult => {
    if (!allowFallback) throw new RerankerUnavailableError(reason);
    return {
      items: original.map(copyCandidate),
      mode: 'text',
      warnings: [`${RERANKER_WARNING_UNAVAILABLE}:${reason}`],
      ...(model_fingerprint === undefined ? {} : { model_fingerprint })
    };
  };
  if (original.length === 0) return { items: [], mode: 'text', warnings: [] };
  const callerAborted = (): boolean => signal?.aborted === true;
  if (callerAborted()) return fallback('cancelled');
  let health: RerankWorkerHealth;
  try {
    health = worker.health();
  } catch {
    return fallback('unavailable');
  }
  if (health.state !== 'ready') {
    const reason: RerankerFallbackReason =
      health.state === 'disabled' ? 'disabled' : health.state === 'starting' ? 'starting' : 'unavailable';
    return fallback(reason, health.model_fingerprint);
  }
  const evaluated = original.slice(0, maxCandidates);
  const unscored = original.slice(maxCandidates);
  const deadlineMs = input.deadlineMs ?? LAYA_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const deadlineError = new Error('rerank deadline exceeded');
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(deadlineError);
    }, Math.max(0, deadlineMs));
  });
  let result: LayaScoreResult;
  try {
    if (Date.now() >= deadlineAt) return fallback('deadline');
    result = await Promise.race([
      worker.score({
        request_id: randomUUID(),
        query,
        candidates: evaluated.map(toLayaCandidate),
        signal: controller.signal
      }),
      expired
    ]);
    if (callerAborted()) return fallback('cancelled');
    if (controller.signal.aborted || Date.now() >= deadlineAt) return fallback('timeout');
  } catch (error) {
    if (callerAborted()) return fallback('cancelled');
    if (controller.signal.aborted || error === deadlineError) return fallback('timeout');
    return fallback(workerFailureReason(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
  const scores = validateScores(evaluated, result);
  if (!(scores instanceof Map)) return fallback(scores);
  const scored = evaluated.map((candidate) => {
    const item: RerankedCandidate = { ...copyCandidate(candidate), relevance_score: scores.get(candidate.chunk_key) };
    return item;
  });
  const ordered = rankCandidateChunks(scored);
  const items: RerankedCandidate[] = [...ordered, ...unscored.map(copyCandidate)];
  return {
    items,
    mode: 'reranked',
    warnings: [],
    ...(typeof result.model_fingerprint === 'string' ? { model_fingerprint: result.model_fingerprint } : {}),
    ...(typeof result.question_version === 'string' ? { question_version: result.question_version } : {})
  };
}

export function selectFinalCandidates(
  candidates: readonly RerankedCandidate[],
  policy: FinalCandidatePolicy = {}
): RerankedCandidate[] {
  const eligible = candidates.filter((candidate) => {
    if (policy.isEligible !== undefined && !policy.isEligible(candidate)) return false;
    if (policy.currentHash !== undefined && policy.currentHash(candidate) !== candidate.source_hash) return false;
    return true;
  });
  const grouped = selectDistinctCandidateChunks(
    eligible,
    policy.maxPerNote ?? DEFAULT_MAX_CANDIDATES_PER_NOTE
  );
  const maxItems = policy.maxItems;
  if (maxItems === undefined || !Number.isFinite(maxItems)) return grouped;
  return grouped.slice(0, Math.max(0, Math.trunc(maxItems)));
}
