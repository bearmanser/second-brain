import { Buffer } from 'node:buffer';
import type { RerankWorker } from '../retrieval/reranker.js';
import { BrainError } from '../contracts/errors.js';
import {
  LEGACY_SHARED_CATEGORY,
  normalizeRecallMode,
  normalizeRecallScope
} from '../contracts/compatibility.js';
import { clampRecallBudget, countReferenceTokens } from '../retrieval/budget.js';
import { rerankCandidates, selectFinalCandidates, type RerankedCandidate } from '../retrieval/reranker.js';
import { clampReadBudget, paginate } from './read.js';
import { captureLocal } from './capture.js';
import { reviewLocal } from './review.js';
import { feedbackLocal } from './feedback.js';
import { projectEnsureLocal } from './project-ensure.js';
import {
  buildLocalHandlerDeps,
  conflict,
  currentByReference,
  invalidInput,
  notFound,
  projectRecords,
  reconcile,
  resolveProjectId,
  scopeForPath,
  sourceRef,
  mutationReceipt
} from './local-support.js';
import type {
  AuthenticatedContext,
  CaptureRequest,
  FeedbackRequest,
  FeedbackResult,
  MutationReceipt,
  ProjectEnsureRequest,
  ProjectEnsureResult,
  ReadRequest,
  ReadResult,
  RecallRequest,
  RecallResult,
  ReviewListResult,
  ReviewRequest,
  SourceRef,
  StatusRequest,
  StatusResult
} from '../core/types.js';

export type { LocalBrain } from './local-support.js';

const DEFAULT_LIMIT = 10;
const CANDIDATE_LIMIT = 50;
const RERANK_LIMIT = 30;

function encodeCursor(value: { etag: string; offset: number }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, etag: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw invalidInput('the read cursor is not valid', cause);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { etag?: unknown }).etag !== 'string' ||
    typeof (parsed as { offset?: unknown }).offset !== 'number'
  ) {
    throw invalidInput('the read cursor is not valid');
  }
  if ((parsed as { etag: string }).etag !== etag) {
    throw conflict('the note changed since the page cursor was issued; restart the read');
  }
  return (parsed as { offset: number }).offset;
}

export async function localCapture(
  ctx: AuthenticatedContext,
  input: CaptureRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<MutationReceipt> {
  return captureLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localReview(
  ctx: AuthenticatedContext,
  input: ReviewRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<MutationReceipt | ReviewListResult> {
  return reviewLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localFeedback(
  ctx: AuthenticatedContext,
  input: FeedbackRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<FeedbackResult> {
  return feedbackLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localProjectEnsure(
  ctx: AuthenticatedContext,
  input: ProjectEnsureRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<ProjectEnsureResult> {
  return projectEnsureLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localRead(
  ctx: AuthenticatedContext,
  input: ReadRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<ReadResult> {
  if (ctx.signal.aborted) throw new BrainError({ code: 'CANCELLED', message: 'the read was cancelled' });
  await reconcile(brain);
  const source = currentByReference(brain, input);
  const id = source.id;
  if (input.revision_id !== undefined) {
    if (id === undefined) {
      throw invalidInput('a historical read requires a managed note id');
    }
    const revision = await brain.documents.readRevision(id, input.revision_id);
    return {
      source: {
        ...sourceRef(brain, source, ['historical']),
        etag: revision.hash,
        revision_id: revision.revision_id ?? input.revision_id
      },
      markdown: revision.raw
    };
  }
  const file = await brain.documents.readPath(source.path);
  const budget = clampReadBudget(input.budget_tokens);
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, file.etag);
  const page = paginate(file.raw, offset, budget);
  const result: ReadResult = { source: sourceRef(brain, source), markdown: page.page };
  if (page.nextOffset !== undefined) {
    result.next_cursor = encodeCursor({ etag: file.etag, offset: page.nextOffset });
  }
  return result;
}

export async function localRecall(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<RecallResult> {
  if (ctx.signal.aborted) throw new BrainError({ code: 'CANCELLED', message: 'the recall was cancelled' });
  await reconcile(brain);
  const scope = normalizeRecallScope(input, {
    canonicalId: (identifier) => {
      try {
        return resolveProjectId(brain, identifier);
      } catch {
        return undefined;
      }
    }
  });
  const modeInfo = normalizeRecallMode(input.mode);
  const warnings = [...scope.warnings, ...modeInfo.warnings];
  const project = scope.filter.mode === 'project' ? scope.filter.identifier : undefined;
  const statuses = input.include_candidates === true ? ['active', 'candidate'] : ['active'];
  let candidates = brain.index.candidates({
    query: input.query,
    limit: CANDIDATE_LIMIT,
    ...(input.kinds === undefined || input.kinds.length === 0 ? {} : { types: input.kinds }),
    statuses
  });
  const excluded = brain.documents.recallExclusions();
  for (const record of brain.operations?.listIncomplete() ?? []) {
    if (record.plan_json === null) continue;
    let plan: {
      kind?: string;
      heads?: { id: string; path: string }[];
      effects?: { kind: string; path?: string; write?: { path: string }; from_path?: string; to_path?: string }[];
      reference_edits?: { path: string }[];
    };
    try {
      plan = JSON.parse(record.plan_json) as typeof plan;
    } catch (error) {
      throw new BrainError({ code: 'RECOVERY_REQUIRED', message: 'pending recall exclusion plan is unreadable', cause: error });
    }
    if (plan.kind !== 'note') continue;
    for (const head of plan.heads ?? []) {
      excluded.ids.add(head.id);
      excluded.paths.add(head.path);
    }
    for (const effect of plan.effects ?? []) {
      for (const path of [effect.path, effect.write?.path, effect.from_path, effect.to_path]) {
        if (path !== undefined) excluded.paths.add(path);
      }
    }
    for (const edit of plan.reference_edits ?? []) excluded.paths.add(edit.path);
  }
  candidates = candidates.filter(
    (candidate) => !excluded.paths.has(candidate.path) && !excluded.ids.has(candidate.id ?? '')
  );
  if (project !== undefined) {
    const allowed = new Set([project]);
    if (scope.selected_shared) allowed.add(LEGACY_SHARED_CATEGORY);
    candidates = candidates.filter((candidate) => allowed.has(scopeForPath(brain, candidate.path)));
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  let ordered: RerankedCandidate[] = candidates;
  let executed = modeInfo.executed;
  if (modeInfo.executed === 'reranked') {
    if (brain.worker === undefined || candidates.length === 0) {
      executed = 'text';
      if (brain.worker === undefined) warnings.push('reranker_unavailable:disabled');
    } else {
      const result = await rerankCandidates({
        query: input.query,
        candidates: candidates.slice(0, RERANK_LIMIT),
        worker: brain.worker,
        allowFallback: input.allow_text_fallback !== false,
        signal: ctx.signal
      });
      ordered = result.items;
      executed = result.mode;
      warnings.push(...result.warnings);
    }
  }
  const selected = selectFinalCandidates(ordered, {
    maxItems: limit,
    currentHash: (candidate) => brain.catalogue.getByPath(candidate.path)?.hash
  });
  const items: (SourceRef & { excerpt: string; reasons: string[] })[] = [];
  let staleExcluded = false;
  for (const candidate of selected) {
    if (excluded.paths.has(candidate.path) || excluded.ids.has(candidate.id ?? '')) continue;
    const source = brain.catalogue.getByPath(candidate.path);
    if (source === undefined || source.hash !== candidate.source_hash) {
      staleExcluded = true;
      continue;
    }
    let file: { raw: string; etag: string };
    try {
      file = await brain.documents.readPath(candidate.path);
    } catch {
      staleExcluded = true;
      continue;
    }
    if (file.etag !== source.hash) {
      staleExcluded = true;
      continue;
    }
    items.push({
      ...sourceRef(brain, source),
      excerpt: candidate.text,
      heading: candidate.heading,
      start_line: candidate.line_from,
      end_line: candidate.line_to,
      reasons: [...candidate.reasons]
    });
  }
  if (staleExcluded) warnings.push('stale_hits_excluded');
  const budgetLimit = clampRecallBudget(input.budget_tokens);
  const packed: typeof items = [];
  let used = 0;
  let partial = staleExcluded;
  for (const item of items) {
    const tokens = countReferenceTokens(JSON.stringify(item));
    if (used + tokens > budgetLimit) {
      partial = true;
      break;
    }
    packed.push(item);
    used += tokens;
  }
  if (packed.length < items.length) partial = true;
  return {
    retrieval_id: brain.ids.next(),
    mode: executed,
    partial,
    warnings: [...new Set(warnings)],
    budget: { tokenizer: 'cl100k_base', used, limit: budgetLimit },
    items: packed
  };
}

export async function localStatus(
  ctx: AuthenticatedContext,
  input: StatusRequest,
  brain: import('./local-support.js').LocalBrain
): Promise<StatusResult> {
  await reconcile(brain);
  const filterIdentifier = input.project ?? input.scope;
  const selectedId =
    filterIdentifier === undefined ? undefined : resolveProjectId(brain, filterIdentifier);
  const projects = brain.journal
    .listProjects()
    .filter((project) => selectedId === undefined || project.project.id === selectedId);
  const pending = brain.journal
    .pending()
    .filter((record) => selectedId === undefined || record.scope === selectedId);
  const workerHealth = brain.worker?.health();
  const result: StatusResult = {
    version: '0.1.0',
    protocol_version: '2',
    schema_version: 1,
    protocol: 2,
    scopes:
      selectedId === undefined
        ? projectRecords(brain).map((project) => ({ id: project.id }))
        : [{ id: selectedId }],
    health: {
      gateway: pending.length > 0 ? 'recovering' : 'ready',
      backend: 'unavailable',
      embeddings: 'unknown'
    },
    local: {
      index: { state: 'ready', documents: brain.index.paths().length },
      worker:
        workerHealth === undefined
          ? { state: 'disabled' }
          : {
              state: workerHealth.state,
              ...(workerHealth.model_fingerprint === undefined
                ? {}
                : { model_fingerprint: workerHealth.model_fingerprint })
            }
    },
    features: {
      reranking: workerHealth?.state === 'ready',
      text_search: true,
      fallback: true
    },
    pending_operations: pending.length
  };
  if (projects.length > 0) {
    result.projects = projects.map((project) => ({
      scope: project.project.id,
      state: project.state,
      display_name: project.project.display_name,
      relative_root: project.project.relative_root
    }));
  }
  if (input.operation_id !== undefined) {
    const status = (await buildLocalHandlerDeps(brain)).mutations.status(input.operation_id);
    if (status === undefined) throw notFound('the requested operation is not available');
    if (selectedId !== undefined && status.project_id !== selectedId) {
      throw notFound('the requested operation is not available in this project');
    }
    if (status.receipt?.kind === 'note') result.operation = mutationReceipt(status.receipt);
    else if (status.receipt?.kind === 'project_ensure') {
      result.operation = {
        operation_id: status.receipt.operation_id,
        repository_identity: status.receipt.repository_identity,
        scope: status.receipt.project_id,
        project_id: status.receipt.project_id,
        relative_root: status.receipt.relative_root,
        created: status.receipt.created,
        materialized: status.receipt.materialized,
        warnings: status.receipt.warnings
      } as StatusResult['operation'];
    } else if (status.receipt !== undefined) result.operation = status.receipt as unknown as StatusResult['operation'];
  }
  if (input.include_schemas === true) {
    result.schemas = {};
  }
  return result;
}
