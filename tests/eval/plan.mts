import type { RetrievalSummary } from './analyse.mjs';

export const MIN_POSITIVE_QUERIES = 12;
export const MIN_NEGATIVE_QUERIES = 8;
export const MIN_CORPUS_NOTES = 10;
export const MAX_PILOT_RUNS = 24;
export const RECALL_TARGET = 0.8;

export interface CorpusLike {
  notes: Array<{
    key: string;
    scope: string;
    status: string;
    replacement?: string;
    note: { title: string; content: { kind: string } };
  }>;
}

export interface RetrievalLike {
  k: number;
  forbidden_markers: string[];
  queries: Array<{
    id: string;
    label: string;
    scope: string;
    query: string;
    relevant: string[];
  }>;
}

export function planPilotRuns(taskCount: number, repeats: number, budget: number): number {
  return Math.max(0, Math.min(taskCount * repeats * 2, MAX_PILOT_RUNS, budget));
}

export function validateCorpus(corpus: CorpusLike): string[] {
  const errors: string[] = [];
  if (corpus.notes.length < MIN_CORPUS_NOTES) {
    errors.push(`corpus has ${corpus.notes.length} notes; at least ${MIN_CORPUS_NOTES} required`);
  }
  const keys = new Set<string>();
  for (const note of corpus.notes) {
    if (keys.has(note.key)) errors.push(`duplicate corpus key ${note.key}`);
    keys.add(note.key);
    if (!/^[a-z0-9-]+$/.test(note.key)) errors.push(`corpus key ${note.key} is not a slug`);
    if (note.note.title.trim().length === 0) errors.push(`corpus key ${note.key} has an empty title`);
  }
  for (const note of corpus.notes) {
    if (note.status === 'superseded' && (note.replacement === undefined || !keys.has(note.replacement))) {
      errors.push(`superseded note ${note.key} has no valid replacement`);
    }
  }
  return errors;
}

export function validateRetrieval(retrieval: RetrievalLike, corpusKeys: Set<string>): string[] {
  const errors: string[] = [];
  const positive = retrieval.queries.filter((query) => query.label === 'positive');
  const negative = retrieval.queries.filter((query) => query.label !== 'positive');
  if (positive.length < MIN_POSITIVE_QUERIES) {
    errors.push(`only ${positive.length} positive queries; at least ${MIN_POSITIVE_QUERIES} required`);
  }
  if (negative.length < MIN_NEGATIVE_QUERIES) {
    errors.push(`only ${negative.length} negative/scoping queries; at least ${MIN_NEGATIVE_QUERIES} required`);
  }
  if (retrieval.forbidden_markers.length === 0) {
    errors.push('no forbidden markers are declared');
  }
  const ids = new Set<string>();
  for (const query of retrieval.queries) {
    if (ids.has(query.id)) errors.push(`duplicate query id ${query.id}`);
    ids.add(query.id);
    if (query.query.trim().length === 0) errors.push(`query ${query.id} is empty`);
    for (const key of query.relevant) {
      if (!corpusKeys.has(key)) errors.push(`query ${query.id} references unknown key ${key}`);
    }
    if (query.label === 'positive' && query.relevant.length === 0) {
      errors.push(`positive query ${query.id} has no relevant labels`);
    }
    if (query.label !== 'positive' && query.relevant.length > 0) {
      errors.push(`negative query ${query.id} carries relevant labels`);
    }
  }
  return errors;
}

export const REQUIRED_CASE_FIELDS = [
  'case_id',
  'memory_condition',
  'model_identifier',
  'client',
  'retrieved_ids',
  'tool_timeline',
  'outcome',
  'elapsed_ms',
  'token_usage'
] as const;

export function validateCaseRecord(record: Record<string, unknown>): string[] {
  const missing: string[] = REQUIRED_CASE_FIELDS.filter((field) => !(field in record));
  if ('token_usage' in record && record.token_usage !== null) {
    const usage = record.token_usage;
    if (typeof usage !== 'object' || usage === null) {
      missing.push('token_usage is neither null nor an object');
    }
  }
  if ('retrieved_ids' in record && !Array.isArray(record.retrieved_ids)) {
    missing.push('retrieved_ids is not an array');
  }
  return missing;
}

export interface CaseOutcome {
  outcome: string;
  leaked: boolean;
}

export interface RetrievalGate {
  ok: boolean;
  reasons: string[];
}

export function retrievalGate(
  metrics: RetrievalSummary,
  cases: CaseOutcome[],
  target = RECALL_TARGET
): RetrievalGate {
  const reasons: string[] = [];
  if (metrics.leakage_events > 0) reasons.push(`leakage events: ${metrics.leakage_events}`);
  if (metrics.negative_cases_failed > 0) {
    reasons.push(`negative cases failed: ${metrics.negative_cases_failed}`);
  }
  const failedCases = cases.filter((entry) => entry.outcome !== 'pass');
  if (failedCases.length > 0) {
    reasons.push(`failed cases: ${failedCases.length}`);
  }
  if (metrics.positive_cases > 0 && metrics.recall_at_5 < target) {
    reasons.push(`recall@5 ${metrics.recall_at_5} is below target ${target}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export interface McpServerView {
  name: string;
  disabled: boolean;
}

export function effectiveMcpServers(documents: unknown[]): McpServerView[] {
  const merged = new Map<string, McpServerView>();
  for (const document of documents) {
    if (typeof document !== 'object' || document === null) continue;
    const info = (document as { info?: unknown }).info;
    if (typeof info !== 'object' || info === null) continue;
    const mcp = (info as { mcp?: unknown }).mcp;
    if (typeof mcp !== 'object' || mcp === null) continue;
    const servers = (mcp as { servers?: unknown }).servers;
    if (typeof servers !== 'object' || servers === null) continue;
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      const disabled =
        typeof value === 'object' && value !== null &&
        (value as Record<string, unknown>).disabled === true;
      merged.set(name, { name, disabled });
    }
  }
  return [...merged.values()];
}

export function enabledMcpServers(servers: McpServerView[]): McpServerView[] {
  return servers.filter((server) => server.disabled !== true);
}

export interface DisabledIsolation {
  ok: boolean;
  enabled: string[];
}

export function disabledIsolationOk(servers: McpServerView[]): DisabledIsolation {
  const enabled = enabledMcpServers(servers).map((server) => server.name);
  return { ok: enabled.length === 0, enabled };
}

export interface PilotRunOutcome {
  outcome: string;
}

export interface PilotOutcome {
  status: 'RUN' | 'INVALID';
  failed: boolean;
  reasons: string[];
}

export function pilotOutcome(runs: PilotRunOutcome[]): PilotOutcome {
  const invalid = runs.filter((entry) => entry.outcome === 'invalid_isolation').length;
  const reasons: string[] = [];
  if (invalid > 0) reasons.push(`invalid isolation runs: ${invalid}`);
  return { status: invalid > 0 ? 'INVALID' : 'RUN', failed: invalid > 0, reasons };
}

export interface InstructionEvidence {
  preflight_visible: boolean;
  exit_code: number | null;
  timed_out: boolean;
  marker_seen: boolean;
  fact_seen: boolean;
}

export interface InstructionDecision {
  status: 'RUN' | 'NOT RUN';
  reasons: string[];
  observed: { marker: boolean; fact: boolean; tool_payload: boolean };
}

export function instructionStatus(evidence: InstructionEvidence): InstructionDecision {
  const reasons: string[] = [];
  if (!evidence.preflight_visible) {
    reasons.push('preflight did not list the disposable MCP server');
  }
  if (evidence.timed_out) reasons.push('the model process timed out');
  if (evidence.exit_code !== 0) {
    reasons.push(`the model process exited with code ${String(evidence.exit_code)}`);
  }
  if (!evidence.marker_seen) reasons.push('the instruction marker was not observed');
  return {
    status: reasons.length === 0 ? 'RUN' : 'NOT RUN',
    reasons,
    observed: {
      marker: evidence.marker_seen,
      fact: evidence.fact_seen,
      tool_payload: evidence.fact_seen
    }
  };
}
