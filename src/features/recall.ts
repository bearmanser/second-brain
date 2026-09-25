import { BrainError, isBrainError } from '../contracts/errors.js';
import { recallRequestSchema } from '../contracts/protocol.js';
import {
  BACKEND_SEARCH_CALL_BUDGET,
  BACKEND_SEARCH_PAGES,
  BACKEND_SEARCH_PAGE_SIZE,
  BACKEND_TIMEOUT_MS,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  SESSION_FRESHNESS_DAYS,
  TEXTS_MAX_ITEMS
} from '../core/limits.js';
import type { BrainDeps } from '../core/mutation.js';
import { LIFECYCLES, NOTE_KINDS } from '../core/types.js';
import type {
  AuthenticatedContext,
  BackendHit,
  Head,
  LocalHandlerDeps,
  NoteInput,
  NoteKind,
  ProjectFilter,
  RecallRequest,
  RecallResult,
  ScopeConfig,
  SourceRef,
  StoredRevision
} from '../core/types.js';
import {
  LEGACY_SHARED_CATEGORY,
  normalizeRecallMode,
  normalizeRecallScope
} from '../contracts/compatibility.js';
import { decodeRevision } from '../notes/codec.js';
import { NOTE_REGISTRY } from '../notes/registry.js';
import { projectFilter } from '../projects/registry.js';
import { clampRecallBudget, packRecall } from '../retrieval/budget.js';
import { GRAPH_NEIGHBOR_LIMIT, GRAPH_SEED_LIMIT } from '../retrieval/graph.js';
import {
  rerankCandidates,
  RerankerUnavailableError,
  selectFinalCandidates,
  type RerankedCandidate
} from '../retrieval/reranker.js';
import { phaseKinds, rankEligible, type EligibleHit } from '../retrieval/rank.js';
import {
  LEXICAL_QUESTION_ID,
  LEXICAL_QUESTION_VERSION,
  RERANK_QUESTION_ID,
  retrievalQueryId
} from '../retrieval/evaluation.js';
import { reconcileRetrievalDeps, sourceRefManaged } from './local-support.js';

export const RECALL_WARNING_SEARCH_TRUNCATED = 'search_truncated';
export const RECALL_WARNING_HIT_UNRESOLVED = 'hit_unresolved';
export const RECALL_WARNING_STALE_HITS_EXCLUDED = 'stale_hits_excluded';
export const RECALL_WARNING_DEADLINE_EXCEEDED = 'retrieval_deadline_exceeded';
export const RECALL_WARNING_BACKEND_PARTIAL = 'backend_unavailable_partial';
export const RECALL_WARNING_EMBEDDINGS_FALLBACK = 'embeddings_unavailable_text_fallback';
export const RECALL_WARNING_CANDIDATE = 'candidate';
export const RECALL_WARNING_SHARED_PROJECT = 'shared_project';
export const RECALL_WARNING_INCLUDE_SHARED_DEPRECATED = 'include_shared_deprecated';
export const RECALL_WARNING_DUPLICATE_IDENTITY = 'duplicate_identity';

const SHARED_PROJECT_ID = 'shared';
const MAX_SEARCH_TERMS = 64;
const MATCHED_SECTION_MAX_CODE_POINTS = 600;
const CONTEXT_SECTION_MAX_CODE_POINTS = 200;
const SESSION_FRESHNESS_MS = SESSION_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;

type SessionContent = Extract<NoteInput['content'], { kind: 'session' }>;
type FactContent = Extract<NoteInput['content'], { kind: 'fact' }>;

interface ProjectHits {
  scope: ScopeConfig;
  hits: BackendHit[];
  exhausted: boolean;
  attempted: boolean;
}

interface SearchAccumulator {
  projectHits: ProjectHits[];
  attemptedCalls: number;
  completedCalls: number;
  hits: number;
  truncated: boolean;
  deadlineExceeded: boolean;
  budgetExhausted: boolean;
  failure?: unknown;
}

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function cancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the recall' });
}

function normalizeBackendFailure(error: unknown): unknown {
  if (isBrainError(error) && error.code === 'CANCELLED') {
    return new BrainError({
      code: 'BACKEND_UNAVAILABLE',
      message: 'the backend cancelled the search',
      cause: error
    });
  }
  return error;
}

function resolveLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return RECALL_LIMIT_DEFAULT;
  const rounded = Math.trunc(value);
  if (rounded < 1) return 1;
  if (rounded > RECALL_LIMIT_MAX) return RECALL_LIMIT_MAX;
  return rounded;
}

function parseRequest(input: RecallRequest): RecallRequest {
  const candidate: RecallRequest = {
    ...input,
    budget_tokens: clampRecallBudget(input.budget_tokens),
    limit: resolveLimit(input.limit)
  };
  const parsed = recallRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`recall request is invalid: ${detail}`);
  }
  return parsed.data as RecallRequest;
}

function selectProjects(
  request: RecallRequest,
  filter: ProjectFilter,
  deps: BrainDeps,
  warnings: string[]
): ScopeConfig[] {
  if (request.include_shared !== undefined) {
    if (!warnings.includes(RECALL_WARNING_INCLUDE_SHARED_DEPRECATED)) {
      warnings.push(RECALL_WARNING_INCLUDE_SHARED_DEPRECATED);
    }
  }
  if (filter.mode === 'all') {
    return deps.scopeRegistry
      .all()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  const primary = deps.scopeRegistry.require(filter.identifier);
  const selected: ScopeConfig[] = [primary];
  if (request.include_shared === true && primary.id !== SHARED_PROJECT_ID) {
    const shared = deps.scopeRegistry.get(SHARED_PROJECT_ID);
    if (shared !== undefined && deps.scopeRegistry.isUsable(shared.id)) {
      selected.push(shared);
    }
  }
  return selected;
}

function buildSearchText(query: string, topics: string[] | undefined): string {
  const parts = [query, ...(topics ?? [])]
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter((part) => part.length > 0);
  return parts.slice(0, 1 + TEXTS_MAX_ITEMS).join(' ');
}

function searchTerms(searchText: string): string[] {
  const terms: string[] = [];
  for (const raw of searchText.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (!terms.includes(raw)) terms.push(raw);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

function requestedKinds(request: RecallRequest): NoteKind[] {
  if (request.kinds !== undefined && request.kinds.length > 0) return [...request.kinds];
  return [...NOTE_KINDS];
}

function vaultRelativePath(scope: ScopeConfig, relativePath: string): string {
  const prefix = `${scope.relative_root}/`;
  return relativePath.startsWith(prefix) ? relativePath : `${prefix}${relativePath}`;
}

async function collectProjects(
  ctx: AuthenticatedContext,
  scopes: ScopeConfig[],
  searchText: string,
  kinds: NoteKind[],
  mode: 'hybrid' | 'text',
  deps: BrainDeps,
  deadline: number,
  attemptedBefore: number,
  priorAttempted: readonly string[] = []
): Promise<SearchAccumulator> {
  const accumulator: SearchAccumulator = {
    projectHits: scopes.map((scope) => ({
      scope,
      hits: [],
      exhausted: false,
      attempted: priorAttempted.includes(scope.id)
    })),
    attemptedCalls: attemptedBefore,
    completedCalls: 0,
    hits: 0,
    truncated: false,
    deadlineExceeded: false,
    budgetExhausted: false
  };

  for (let page = 1; page <= BACKEND_SEARCH_PAGES; page += 1) {
    for (const project of accumulator.projectHits) {
      if (project.exhausted) continue;
      if (ctx.signal.aborted) throw cancelled();
      if (accumulator.attemptedCalls >= BACKEND_SEARCH_CALL_BUDGET) {
        accumulator.budgetExhausted = true;
        return accumulator;
      }
      if (Date.now() >= deadline) {
        accumulator.deadlineExceeded = true;
        return accumulator;
      }
      accumulator.attemptedCalls += 1;
      project.attempted = true;
      let pageResult: { hits: BackendHit[]; has_more: boolean };
      try {
        pageResult = await deps.backend.search({
          project: project.scope.backend_project,
          query: searchText,
          mode,
          kinds,
          statuses: [...LIFECYCLES],
          page,
          page_size: BACKEND_SEARCH_PAGE_SIZE
        });
      } catch (error) {
        if (ctx.signal.aborted) throw cancelled();
        accumulator.failure = error;
        return accumulator;
      }
      if (ctx.signal.aborted) throw cancelled();
      accumulator.completedCalls += 1;
      project.hits.push(...pageResult.hits);
      accumulator.hits += pageResult.hits.length;
      if (!pageResult.has_more) project.exhausted = true;
      if (Date.now() >= deadline) {
        accumulator.deadlineExceeded = true;
        return accumulator;
      }
    }
    if (accumulator.attemptedCalls >= BACKEND_SEARCH_CALL_BUDGET) {
      accumulator.budgetExhausted = accumulator.projectHits.some((project) => !project.exhausted);
      return accumulator;
    }
  }
  if (accumulator.projectHits.some((project) => !project.exhausted)) {
    accumulator.truncated = true;
  }
  return accumulator;
}

type HeadLookup =
  | { kind: 'head'; head: Head }
  | { kind: 'stale' }
  | { kind: 'unresolved' };

type HitResolution =
  | { kind: 'head'; head: Head }
  | { kind: 'stale' }
  | { kind: 'unresolved' };

async function lookupHead(
  scope: ScopeConfig,
  logicalId: string,
  deps: BrainDeps,
  cache: Map<string, HeadLookup>
): Promise<HeadLookup> {
  const key = `${scope.id}:${logicalId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let outcome: HeadLookup;
  try {
    outcome = { kind: 'head', head: await deps.catalogue.get(scope.id, logicalId) };
  } catch (error) {
    if (
      isBrainError(error) &&
      (error.code === 'CONFLICT' || error.code === 'UNSUPPORTED_SCHEMA')
    ) {
      outcome = { kind: 'stale' };
    } else {
      outcome = { kind: 'unresolved' };
    }
  }
  cache.set(key, outcome);
  return outcome;
}

async function resolveHit(
  scope: ScopeConfig,
  hit: BackendHit,
  deps: BrainDeps,
  cache: Map<string, HeadLookup>
): Promise<HitResolution> {
  if (hit.relative_path.length === 0 && hit.logical_id.length === 0) {
    return { kind: 'unresolved' };
  }

  let read: { raw: string; raw_hash: string; relative_path: string } | undefined;
  let revision: StoredRevision | undefined;
  if (hit.relative_path.length > 0) {
    try {
      read = await deps.vault.read(scope.id, vaultRelativePath(scope, hit.relative_path));
    } catch {
      return { kind: 'unresolved' };
    }
    try {
      revision = decodeRevision(read.raw);
    } catch {
      return { kind: 'unresolved' };
    }
    if (revision.scope !== scope.id) return { kind: 'stale' };
    if (hit.logical_id !== '' && revision.id !== hit.logical_id) return { kind: 'stale' };
    if (hit.revision_id !== '' && revision.revision_id !== hit.revision_id) {
      return { kind: 'stale' };
    }
  }

  const logicalId = revision?.id ?? hit.logical_id;
  if (logicalId === '') return { kind: 'unresolved' };
  const lookup = await lookupHead(scope, logicalId, deps, cache);
  if (lookup.kind !== 'head') return lookup;
  const head = lookup.head;
  if (hit.logical_id !== '' && head.revision.id !== hit.logical_id) return { kind: 'stale' };
  if (head.state !== 'ready' && head.state !== 'manual_unreviewed') return { kind: 'stale' };
  if (hit.revision_id !== '' && head.revision.revision_id !== hit.revision_id) {
    return { kind: 'stale' };
  }

  if (read === undefined || revision === undefined) {
    try {
      read = await deps.vault.read(scope.id, head.source.relative_path);
    } catch {
      return { kind: 'unresolved' };
    }
    try {
      revision = decodeRevision(read.raw);
    } catch {
      return { kind: 'unresolved' };
    }
    if (
      revision.id !== head.revision.id ||
      revision.revision_id !== head.revision.revision_id
    ) {
      return { kind: 'stale' };
    }
  }

  if (head.revision.revision_id !== revision.revision_id) return { kind: 'stale' };
  if (head.raw_hash !== read.raw_hash) return { kind: 'stale' };
  if (head.source.relative_path !== read.relative_path) return { kind: 'stale' };
  return { kind: 'head', head };
}

function isFresh(modifiedAt: string, now: Date): boolean {
  const modified = Date.parse(modifiedAt);
  if (!Number.isFinite(modified)) return false;
  return now.getTime() - modified <= SESSION_FRESHNESS_MS;
}

function evaluateHit(
  scope: ScopeConfig,
  head: Head,
  request: RecallRequest,
  kinds: NoteKind[],
  now: Date
): { included: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const kind = head.source.kind;
  const status = head.source.status;
  if (!kinds.includes(kind)) return { included: false, reasons };
  if (status === 'archived' || status === 'superseded') return { included: false, reasons };
  if (status === 'candidate' && request.include_candidates !== true) {
    return { included: false, reasons };
  }
  if (kind === 'session') {
    const content = head.revision.note.content as SessionContent;
    if (request.session_id === undefined || request.session_id !== content.session_id) {
      return { included: false, reasons };
    }
    if (!isFresh(head.revision.modified_at, now)) return { included: false, reasons };
    reasons.push('session_match');
  }
  if (kind === 'fact') {
    const content = head.revision.note.content as FactContent;
    if (typeof content.valid_until === 'string') {
      const expiry = Date.parse(content.valid_until);
      if (Number.isFinite(expiry) && expiry <= now.getTime()) return { included: false, reasons };
    }
  }
  if (status === 'candidate') reasons.push('candidate');
  if (scope.id === SHARED_PROJECT_ID) reasons.push(RECALL_WARNING_SHARED_PROJECT);
  if (request.phase !== undefined && phaseKinds(request.phase).includes(kind)) {
    reasons.push(`phase_relevant:${request.phase}`);
  }
  return { included: true, reasons };
}

interface Section {
  title: string;
  text: string;
}

function sectionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => `- ${String(entry)}`).join('\n');
  return '';
}

function truncateCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join('');
}

function contentSections(kind: NoteKind, content: NoteInput['content']): Section[] {
  const record = content as unknown as Record<string, unknown>;
  const sections: Section[] = [];
  for (const spec of NOTE_REGISTRY[kind].sections) {
    const text = sectionText(record[spec.field]);
    if (text.trim().length === 0) continue;
    sections.push({ title: spec.title, text });
  }
  return sections;
}

function evidenceSection(note: NoteInput): Section | undefined {
  if (note.evidence.length === 0) return undefined;
  const lines = note.evidence.map((entry) => {
    const ref = entry.ref.length > 0 ? ` (${entry.ref})` : '';
    return `- [${entry.kind}] ${entry.description}${ref}`;
  });
  return { title: 'Evidence', text: lines.join('\n') };
}

function buildExcerpt(revision: StoredRevision, terms: string[]): { excerpt: string; section: string } {
  const note = revision.note;
  const sections = contentSections(note.content.kind, note.content);
  const matched =
    sections.find((section) => terms.some((term) => section.text.toLowerCase().includes(term))) ??
    sections[0];
  const parts: string[] = [];
  if (matched !== undefined) {
    parts.push(`## ${matched.title}\n\n${truncateCodePoints(matched.text, MATCHED_SECTION_MAX_CODE_POINTS)}`);
  }
  const applicability = sections.find((section) => section.title === 'Applicability');
  if (applicability !== undefined && applicability !== matched) {
    parts.push(
      `## ${applicability.title}\n\n${truncateCodePoints(applicability.text, CONTEXT_SECTION_MAX_CODE_POINTS)}`
    );
  }
  const evidence = evidenceSection(note);
  if (evidence !== undefined) {
    parts.push(
      `## ${evidence.title}\n\n${truncateCodePoints(evidence.text, CONTEXT_SECTION_MAX_CODE_POINTS)}`
    );
  }
  return { excerpt: parts.join('\n\n'), section: matched?.title ?? '' };
}

function toItem(
  hit: EligibleHit,
  mode: 'hybrid' | 'text',
  deps: BrainDeps
): RecallResult['items'][number] {
  const warnings = [...hit.head.source.warnings];
  if (
    deps.journal.hasUnresolvedQualityConcern(
      hit.head.source.scope,
      hit.head.source.id,
      hit.head.source.revision_id
    ) &&
    !warnings.includes('unresolved_quality_concern')
  ) {
    warnings.push('unresolved_quality_concern');
  }
  if (hit.head.source.status === 'candidate' && !warnings.includes(RECALL_WARNING_CANDIDATE)) {
    warnings.push(RECALL_WARNING_CANDIDATE);
  }
  if (
    hit.head.source.scope === SHARED_PROJECT_ID &&
    !warnings.includes(RECALL_WARNING_SHARED_PROJECT)
  ) {
    warnings.push(RECALL_WARNING_SHARED_PROJECT);
  }
  const source: SourceRef = { ...hit.head.source, warnings };
  return {
    ...source,
    excerpt: hit.matched_section,
    reasons: [...hit.reasons, mode === 'text' ? 'text_mode' : 'hybrid_mode']
  };
}

export function hasDivergentIdentities(
  identities: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  for (const identity of identities.values()) {
    if (identity.size > 1) return true;
  }
  return false;
}

async function runRecall(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  deps: BrainDeps
): Promise<RecallTrace> {
  if (ctx.signal.aborted) throw cancelled();
  const request = parseRequest(input);
  const filter = projectFilter(request);
  const warnings: string[] = [];
  const scopes = selectProjects(request, filter, deps, warnings);
  const primaryProjectId = filter.mode === 'project' ? scopes[0]?.id ?? null : null;
  const kinds = requestedKinds(request);
  const searchText = buildSearchText(request.query, request.topics);
  const terms = searchTerms(searchText);

  let partial = false;
  let mode: 'hybrid' | 'text' =
    request.mode === 'reranked' ? 'hybrid' : request.mode ?? 'hybrid';
  const deadline = Date.now() + (deps.config.limits.backend_timeout_ms ?? BACKEND_TIMEOUT_MS);

  let accumulator = await collectProjects(ctx, scopes, searchText, kinds, mode, deps, deadline, 0);
  const attemptedProjects = new Set(
    accumulator.projectHits.filter((project) => project.attempted).map((project) => project.scope.id)
  );

  if (
    accumulator.failure !== undefined &&
    isBrainError(accumulator.failure) &&
    accumulator.failure.code === 'EMBEDDINGS_UNAVAILABLE' &&
    mode === 'hybrid' &&
    request.allow_text_fallback === true
  ) {
    const hybridHasState = accumulator.attemptedCalls > 0 || accumulator.hits > 0;
    const fallback = await collectProjects(
      ctx,
      scopes,
      searchText,
      kinds,
      'text',
      deps,
      deadline,
      accumulator.attemptedCalls,
      accumulator.projectHits.filter((project) => project.attempted).map((project) => project.scope.id)
    );
    for (const project of fallback.projectHits) {
      if (project.attempted) attemptedProjects.add(project.scope.id);
    }
    const fallbackUsable = fallback.failure === undefined && fallback.hits > 0;
    if (fallbackUsable || (!hybridHasState && fallback.failure === undefined)) {
      accumulator = fallback;
      mode = 'text';
      partial = true;
      if (!warnings.includes(RECALL_WARNING_EMBEDDINGS_FALLBACK)) {
        warnings.push(RECALL_WARNING_EMBEDDINGS_FALLBACK);
      }
    } else if (!hybridHasState) {
      throw normalizeBackendFailure(fallback.failure);
    }
  }

  if (accumulator.failure !== undefined) {
    if (accumulator.completedCalls === 0 && accumulator.hits === 0) {
      throw normalizeBackendFailure(accumulator.failure);
    }
    partial = true;
    if (!warnings.includes(RECALL_WARNING_BACKEND_PARTIAL)) {
      warnings.push(RECALL_WARNING_BACKEND_PARTIAL);
    }
  }
  if (accumulator.deadlineExceeded) {
    partial = true;
    if (!warnings.includes(RECALL_WARNING_DEADLINE_EXCEEDED)) {
      warnings.push(RECALL_WARNING_DEADLINE_EXCEEDED);
    }
  }
  if (accumulator.truncated || accumulator.budgetExhausted) {
    partial = true;
    if (!warnings.includes(RECALL_WARNING_SEARCH_TRUNCATED)) {
      warnings.push(RECALL_WARNING_SEARCH_TRUNCATED);
    }
  }

  const now = deps.clock.now();
  const best = new Map<string, EligibleHit>();
  const identities = new Map<string, Set<string>>();
  const headCache = new Map<string, HeadLookup>();
  let unresolved = false;
  let staleExcluded = false;

  for (const project of accumulator.projectHits) {
    for (const hit of project.hits) {
      const resolution = await resolveHit(project.scope, hit, deps, headCache);
      if (resolution.kind === 'unresolved') {
        unresolved = true;
        continue;
      }
      if (resolution.kind === 'stale') {
        staleExcluded = true;
        continue;
      }
      const head = resolution.head;
      const decision = evaluateHit(project.scope, head, request, kinds, now);
      if (!decision.included) continue;
      const identity = identities.get(head.revision.id) ?? new Set<string>();
      identity.add(`${head.revision.revision_id}|${head.raw_hash}`);
      identities.set(head.revision.id, identity);
      const key = `${project.scope.id}:${head.revision.id}`;
      const existing = best.get(key);
      if (
        existing !== undefined &&
        (existing.rank > hit.rank ||
          (existing.rank === hit.rank &&
            existing.head.revision.revision_id <= head.revision.revision_id))
      ) {
        continue;
      }
      const extracted = buildExcerpt(head.revision, terms);
      const reasons = [
        ...decision.reasons,
        `project:${project.scope.id}`,
        `backend_rank:${hit.rank}`
      ];
      if (extracted.section.length > 0) reasons.push(`section:${extracted.section}`);
      best.set(key, {
        head,
        rank: hit.rank,
        matched_section: extracted.excerpt,
        reasons
      });
    }
  }

  let divergentIdentity = false;
  if (hasDivergentIdentities(identities)) divergentIdentity = true;
  if (divergentIdentity && !warnings.includes(RECALL_WARNING_DUPLICATE_IDENTITY)) {
    warnings.push(RECALL_WARNING_DUPLICATE_IDENTITY);
  }

  if (unresolved) {
    partial = true;
    if (!warnings.includes(RECALL_WARNING_HIT_UNRESOLVED)) {
      warnings.push(RECALL_WARNING_HIT_UNRESOLVED);
    }
  }
  if (staleExcluded && !warnings.includes(RECALL_WARNING_STALE_HITS_EXCLUDED)) {
    warnings.push(RECALL_WARNING_STALE_HITS_EXCLUDED);
  }

  const ranked = rankEligible([...best.values()], request.phase ?? 'general');
  const limit = resolveLimit(request.limit);
  const finalized: EligibleHit[] = [];
  for (const hit of ranked) {
    if (finalized.length >= limit) break;
    let current: Head;
    try {
      current = await deps.catalogue.get(hit.head.source.scope, hit.head.revision.id);
    } catch {
      staleExcluded = true;
      continue;
    }
    const scope = deps.scopeRegistry.get(hit.head.source.scope);
    if (scope === undefined) {
      staleExcluded = true;
      continue;
    }
    if (current.state !== 'ready' && current.state !== 'manual_unreviewed') {
      staleExcluded = true;
      continue;
    }
    const decision = evaluateHit(scope, current, request, kinds, now);
    if (!decision.included) {
      staleExcluded = true;
      continue;
    }
    if (
      current.raw_hash !== hit.head.raw_hash ||
      current.revision.revision_id !== hit.head.revision.revision_id ||
      current.revision.id !== hit.head.revision.id ||
      current.source.relative_path !== hit.head.source.relative_path
    ) {
      staleExcluded = true;
      continue;
    }
    finalized.push(hit);
  }
  if (staleExcluded && !warnings.includes(RECALL_WARNING_STALE_HITS_EXCLUDED)) {
    warnings.push(RECALL_WARNING_STALE_HITS_EXCLUDED);
  }
  const items = finalized.map((hit) => toItem(hit, mode, deps));
  const budget = clampRecallBudget(request.budget_tokens);

  const result = packRecall(
    items,
    {
      retrieval_id: deps.ids.next(),
      mode,
      partial: partial || divergentIdentity,
      warnings
    },
    budget,
    deps.config.result_delivery
  );
  return {
    result,
    filter,
    searched_project_ids: scopes.filter((scope) => attemptedProjects.has(scope.id)).map((scope) => scope.id),
    primary_project_id: primaryProjectId
  };
}

export interface RecallTrace {
  result: RecallResult;
  filter: ProjectFilter;
  searched_project_ids: string[];
  primary_project_id: string | null;
}

export async function recall(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  deps: BrainDeps
): Promise<RecallResult> {
  return (await runRecall(ctx, input, deps)).result;
}

export async function recallTraced(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  deps: BrainDeps
): Promise<RecallTrace> {
  return runRecall(ctx, input, deps);
}

export const RECALL_WARNING_INDEX_LAG = 'index_lag';

const LOCAL_CANDIDATE_LIMIT = 50;
const LOCAL_RERANK_LIMIT = 30;

function localRecallCancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the recall was cancelled' });
}

function localRecallInvalid(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function parseLocalRecall(input: RecallRequest): RecallRequest {
  const parsed = recallRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw localRecallInvalid(`recall request is invalid: ${detail}`);
  }
  return parsed.data as RecallRequest;
}

function localStatuses(request: RecallRequest): string[] {
  const statuses = ['active'];
  if (request.include_candidates === true) statuses.push('candidate');
  if (request.include_superseded === true) statuses.push('superseded');
  if (request.include_archived === true) statuses.push('archived');
  return statuses;
}

interface LocalGraphEdge {
  source: string;
  target: string;
  relationship: string;
}

function graphEdgeReason(
  edges: readonly LocalGraphEdge[],
  neighbor: { document_key: string; relationship: string; direction: 'outgoing' | 'incoming' },
  seeds: readonly string[]
): string | undefined {
  for (const seed of seeds) {
    const match = edges.find((edge) => {
      if (edge.relationship !== neighbor.relationship) return false;
      return neighbor.direction === 'outgoing'
        ? edge.source === seed && edge.target === neighbor.document_key
        : edge.target === seed && edge.source === neighbor.document_key;
    });
    if (match !== undefined) return `graph_edge:${neighbor.direction}:${seed}`;
  }
  return undefined;
}

export interface LocalRecallTrace {
  query_id: string;
  question_id: string;
  question_version: string;
  model_fingerprint?: string;
  candidate_positions: number[];
  fallback_reason?: string;
}

export async function recallLocalTraced(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  deps: LocalHandlerDeps
): Promise<{ result: RecallResult; trace: LocalRecallTrace }> {
  if (ctx.signal.aborted) throw localRecallCancelled();
  const request = parseLocalRecall(input);
  const traceQueryId = retrievalQueryId({
    query: request.query,
    ...(request.topics === undefined ? {} : { topics: request.topics }),
    ...(request.phase === undefined ? {} : { phase: request.phase }),
    ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
    include_candidates: request.include_candidates === true,
    include_superseded: request.include_superseded === true,
    include_archived: request.include_archived === true
  });
  let rerankModelFingerprint: string | undefined;
  let rerankQuestionVersion: string | undefined;
  const scope = normalizeRecallScope(request, {
    canonicalId: (identifier) => deps.projects.canonicalId(identifier)
  });
  const modeInfo = normalizeRecallMode(request.mode ?? deps.config.search_mode);
  const warnings = [...scope.warnings, ...modeInfo.warnings];
  const projectId = scope.filter.mode === 'project' ? scope.filter.identifier : undefined;
  const projectRoots: string[] = [];
  if (projectId !== undefined) {
    const resolved = deps.projects.resolve(projectId);
    if (resolved !== undefined) projectRoots.push(resolved.relative_root);
    if (scope.selected_shared) {
      const shared = deps.projects.resolve(LEGACY_SHARED_CATEGORY);
      if (shared !== undefined && shared.id !== projectId) projectRoots.push(shared.relative_root);
    }
  }
  const limit = request.limit ?? RECALL_LIMIT_DEFAULT;
  const types = request.kinds ?? [];
  const statuses = localStatuses(request);

  const reconciled = await reconcileRetrievalDeps(deps);
  if (reconciled.index_failed || reconciled.pending_index > 0) {
    if (!warnings.includes(RECALL_WARNING_INDEX_LAG)) warnings.push(RECALL_WARNING_INDEX_LAG);
  }
  if (ctx.signal.aborted) throw localRecallCancelled();

  const filters = {
    ...(types.length === 0 ? {} : { types }),
    statuses,
    ...(projectId === undefined ? {} : { project: projectId }),
    ...(projectRoots.length === 0 ? {} : { project_roots: projectRoots })
  };
  const candidates = deps.index.candidates({
    query: request.query,
    limit: LOCAL_CANDIDATE_LIMIT,
    ...filters
  });

  if (request.expand_graph === true) {
    const seeds = [...new Set(candidates.slice(0, GRAPH_SEED_LIMIT).map((candidate) => candidate.document_key))];
    const expansion = deps.index.expandGraph(seeds, { ...filters, query: request.query }, GRAPH_NEIGHBOR_LIMIT);
    const knownChunks = new Set(candidates.map((candidate) => candidate.chunk_key));
    const knownDocuments = new Set(candidates.map((candidate) => candidate.document_key));
    for (const neighbor of expansion.neighbors) {
      if (knownChunks.has(neighbor.chunk.chunk_key) || knownDocuments.has(neighbor.document_key)) continue;
      const edgeReason = graphEdgeReason(expansion.edges, neighbor, seeds);
      candidates.push({
        ...neighbor.chunk,
        lexical_rank: null,
        candidate_position: 0,
        reasons: [neighbor.reason, ...(edgeReason === undefined ? [] : [edgeReason])]
      });
      knownChunks.add(neighbor.chunk.chunk_key);
      knownDocuments.add(neighbor.document_key);
    }
  }

  let ordered: RerankedCandidate[] = candidates;
  let executed = modeInfo.executed;
  if (executed === 'reranked') {
    if (deps.worker === undefined) {
      if (request.allow_text_fallback === false) {
        throw new BrainError({
          code: 'EMBEDDINGS_UNAVAILABLE',
          message: 'reranking is unavailable and lexical fallback is disabled'
        });
      }
      executed = 'text';
      warnings.push('reranker_unavailable:disabled');
    } else if (candidates.length > 0) {
      try {
        const result = await rerankCandidates({
          query: request.query,
          candidates: candidates.slice(0, LOCAL_RERANK_LIMIT),
          worker: deps.worker,
          allowFallback: request.allow_text_fallback !== false,
          signal: ctx.signal
        });
        ordered = result.items;
        executed = result.mode;
        rerankModelFingerprint = result.model_fingerprint;
        rerankQuestionVersion = result.question_version;
        warnings.push(...result.warnings);
      } catch (error) {
        if (error instanceof RerankerUnavailableError) {
          throw new BrainError({
            code: 'EMBEDDINGS_UNAVAILABLE',
            message: 'reranking is unavailable and lexical fallback is disabled',
            cause: error
          });
        }
        throw error;
      }
    }
  }
  if (ctx.signal.aborted) throw localRecallCancelled();

  const excluded = deps.documents.recallExclusions();
  const affected = deps.mutations.pendingAffected();
  for (const id of affected.ids) excluded.ids.add(id);
  for (const path of affected.paths) excluded.paths.add(path);

  const selected = selectFinalCandidates(ordered, {
    maxItems: limit,
    isEligible: (candidate) => {
      if (excluded.paths.has(candidate.path) || excluded.ids.has(candidate.id ?? '')) return false;
      const source = deps.catalogue.getByPath(candidate.path);
      if (source === undefined) return false;
      return statuses.includes(source.status);
    },
    currentHash: (candidate) => deps.catalogue.getByPath(candidate.path)?.hash
  });

  const items: (SourceRef & { excerpt: string; reasons: string[] })[] = [];
  const candidatePositions: number[] = [];
  const positionOf = new Map<string, number>();
  ordered.forEach((candidate, index) => {
    if (!positionOf.has(candidate.chunk_key)) positionOf.set(candidate.chunk_key, index);
  });
  let staleExcluded = false;
  for (const candidate of selected) {
    if (excluded.paths.has(candidate.path) || excluded.ids.has(candidate.id ?? '')) continue;
    const source = deps.catalogue.getByPath(candidate.path);
    if (source === undefined || source.hash !== candidate.source_hash) {
      staleExcluded = true;
      continue;
    }
    let file: { raw: string; etag: string };
    try {
      file = await deps.documents.readPath(candidate.path);
    } catch {
      staleExcluded = true;
      continue;
    }
    if (file.etag !== source.hash) {
      staleExcluded = true;
      continue;
    }
    const itemWarnings: string[] = [];
    if (source.status === 'superseded' && request.include_superseded === true) itemWarnings.push('superseded');
    if (source.status === 'archived' && request.include_archived === true) itemWarnings.push('archived');
    candidatePositions.push(positionOf.get(candidate.chunk_key) ?? candidate.candidate_position);
    items.push({
      ...sourceRefManaged(deps, source, itemWarnings),
      excerpt: candidate.text,
      heading: candidate.heading,
      start_line: candidate.line_from,
      end_line: candidate.line_to,
      reasons: [...candidate.reasons]
    });
  }
  if (staleExcluded && !warnings.includes(RECALL_WARNING_STALE_HITS_EXCLUDED)) {
    warnings.push(RECALL_WARNING_STALE_HITS_EXCLUDED);
  }

  const budgetLimit = clampRecallBudget(request.budget_tokens);
  const result = packRecall(
    items,
    {
      retrieval_id: deps.ids.next(),
      mode: executed,
      partial: staleExcluded,
      warnings
    },
    budgetLimit,
    deps.config.result_delivery
  );
  const fallbackWarning = warnings.find((warning) => warning.startsWith('reranker_unavailable:'));
  const usedRerankerVersion =
    executed === 'reranked' ? rerankQuestionVersion : undefined;
  const trace: LocalRecallTrace = {
    query_id: traceQueryId,
    question_id: usedRerankerVersion === undefined ? LEXICAL_QUESTION_ID : RERANK_QUESTION_ID,
    question_version: usedRerankerVersion ?? LEXICAL_QUESTION_VERSION,
    candidate_positions: candidatePositions,
    ...(usedRerankerVersion !== undefined && rerankModelFingerprint !== undefined
      ? { model_fingerprint: rerankModelFingerprint }
      : {}),
    ...(fallbackWarning === undefined
      ? {}
      : { fallback_reason: fallbackWarning.slice('reranker_unavailable:'.length) })
  };
  return { result, trace };
}

export async function recallLocal(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  deps: LocalHandlerDeps
): Promise<RecallResult> {
  return (await recallLocalTraced(ctx, input, deps)).result;
}
