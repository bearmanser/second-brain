import { BrainError, isBrainError } from '../contracts/errors.js';
import { feedbackRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps } from '../core/mutation.js';
import type {
  AuthenticatedContext,
  FeedbackRequest,
  FeedbackResult,
  ProjectFilter,
  ProjectSelector,
  RecallResult,
  RetrievalEventInputV2,
  ScopeConfig
} from '../core/types.js';
import { requiredProject } from '../projects/registry.js';
import { assertNoCredentials } from '../security/redact.js';
import type {
  AuditEvent,
  RetrievalOutcome
} from '../storage/journal.js';
import { validateRelatedIds } from './related.js';

export { AUDIT_FIELDS, FEEDBACK_REASON_MAX_LENGTH } from '../storage/journal.js';

import type { LocalHandlerDeps } from '../core/types.js';
import {
  authorRetrievalLabel,
  type RetrievalLabelInput
} from '../retrieval/feedback-export.js';
import {
  currentByReferenceDeps,
  notFound as localNotFound,
  reconcileDeps,
  scopeForPathDeps
} from './local-support.js';

export const FEEDBACK_TOOL = 'brain_feedback';
export const FEEDBACK_WARNING_UNRESOLVED = 'unresolved_quality_concern';

const UNRESOLVED_VERDICTS: readonly FeedbackRequest['verdict'][] = [
  'stale',
  'incorrect',
  'contradiction'
];

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function cancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the feedback' });
}

function parseRequest(input: FeedbackRequest): FeedbackRequest {
  const parsed = feedbackRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`feedback request is invalid: ${detail}`);
  }
  return parsed.data as FeedbackRequest;
}

function resolveProject(request: ProjectSelector, deps: BrainDeps): ScopeConfig {
  return deps.scopeRegistry.require(requiredProject(request));
}

async function requireTargetRevision(
  scope: ScopeConfig,
  request: FeedbackRequest,
  deps: BrainDeps
): Promise<void> {
  try {
    await deps.catalogue.getRevision(scope.id, request.id, request.revision_id);
  } catch (error) {
    if (isBrainError(error) && error.code === 'NOT_FOUND') {
      throw notFound(
        `revision ${request.revision_id} of note ${request.id} is not catalogued in scope ${scope.id}`
      );
    }
    throw error;
  }
}

function assertRetrievalBinding(
  request: FeedbackRequest,
  scopeId: string,
  deps: BrainDeps
): void {
  const retrieval_id = request.retrieval_id;
  if (retrieval_id === undefined) return;
  const event = deps.journal.getRetrievalV2(retrieval_id);
  if (event === undefined) {
    throw invalidInput('the retrieval reference is not valid for this project and revision');
  }
  const returned = event.returned_ids.some(
    (entry) => entry.id === request.id && entry.revision_id === request.revision_id
  );
  const inProject = event.returned_ids.some(
    (entry) =>
      entry.id === request.id &&
      entry.revision_id === request.revision_id &&
      (entry.scope === null
        ? event.primary_project_id === scopeId || event.searched_project_ids.includes(scopeId)
        : entry.scope === scopeId)
  );
  if (!returned || !inProject) {
    throw invalidInput('the retrieval reference did not return this revision in this project');
  }
}

function recordAudit(
  deps: BrainDeps,
  ctx: AuthenticatedContext,
  outcome: string,
  started: number,
  noteCount = 0
): void {
  try {
    deps.journal.appendAudit(
      auditFields({
        request_id: ctx.request_id,
        tool: FEEDBACK_TOOL,
        outcome,
        duration_ms: Math.max(0, Date.now() - started),
        note_count: noteCount
      })
    );
  } catch {
    return;
  }
}

export interface AuditFieldsInput {
  request_id: string;
  tool: string;
  outcome: string;
  duration_ms: number;
  note_count?: number;
}

export function auditFields(input: AuditFieldsInput): AuditEvent {
  return {
    request_id: input.request_id,
    tool: input.tool,
    outcome: input.outcome,
    duration_ms: input.duration_ms,
    note_count: input.note_count ?? 0
  };
}

export type OperationalLogSink = (fields: AuditEvent) => void;

export function logOperational(sink: OperationalLogSink, input: AuditFieldsInput): AuditEvent {
  const fields = auditFields(input);
  sink(fields);
  return fields;
}

export interface RetrievalEventOptions {
  filter: ProjectFilter;
  searched_project_ids: string[];
  primary_project_id: string | null;
  duration_ms: number;
  outcome?: RetrievalOutcome;
}

export function retrievalEventFromRecall(
  ctx: AuthenticatedContext,
  result: RecallResult,
  options: RetrievalEventOptions
): RetrievalEventInputV2 {
  return {
    retrieval_id: result.retrieval_id,
    actor_id: ctx.actor.id,
    filter: options.filter,
    searched_project_ids: [...options.searched_project_ids],
    primary_project_id: options.primary_project_id,
    returned_ids: result.items.map((item) => ({
      scope: item.scope,
      id: item.id,
      revision_id: item.revision_id
    })),
    item_count: result.items.length,
    token_used: result.budget.used,
    token_limit: result.budget.limit,
    mode: result.mode,
    outcome: options.outcome ?? (result.partial ? 'partial' : 'ok'),
    partial: result.partial,
    duration_ms: options.duration_ms
  };
}

export async function feedback(
  ctx: AuthenticatedContext,
  input: FeedbackRequest,
  deps: BrainDeps
): Promise<FeedbackResult> {
  const started = Date.now();
  if (ctx.signal.aborted) {
    recordAudit(deps, ctx, 'cancelled', started);
    throw cancelled();
  }
  let request: FeedbackRequest;
  try {
    request = parseRequest(input);
  } catch (error) {
    recordAudit(deps, ctx, 'rejected', started);
    throw error;
  }
  try {
    const scope = resolveProject(request, deps);
    if (request.related_id !== undefined) {
      await validateRelatedIds([request.related_id], deps);
    }
    assertNoCredentials(request.reason, 'reason');
    const warning = UNRESOLVED_VERDICTS.includes(request.verdict)
      ? FEEDBACK_WARNING_UNRESOLVED
      : undefined;
    const write = {
      principal_id: ctx.actor.id,
      idempotency_key: request.idempotency_key,
      scope: scope.id,
      logical_id: request.id,
      revision_id: request.revision_id,
      ...(request.retrieval_id === undefined ? {} : { retrieval_id: request.retrieval_id }),
      ...(request.related_id === undefined ? {} : { related_id: request.related_id }),
      verdict: request.verdict,
      reason: request.reason,
      ...(warning === undefined ? {} : { warning })
    };
    const replay = deps.journal.replayFeedback(write);
    if (replay !== undefined) {
      recordAudit(deps, ctx, 'recorded', started, 1);
      return { feedback_id: replay.entry.feedback_id, recorded: true };
    }
    await requireTargetRevision(scope, request, deps);
    assertRetrievalBinding(request, scope.id, deps);
    const stored = deps.journal.recordFeedback(write);
    recordAudit(deps, ctx, 'recorded', started, 1);
    return { feedback_id: stored.entry.feedback_id, recorded: true };
  } catch (error) {
    recordAudit(deps, ctx, 'rejected', started);
    throw error;
  }
}


export async function feedbackLocal(
  ctx: AuthenticatedContext,
  input: FeedbackRequest,
  deps: LocalHandlerDeps
): Promise<FeedbackResult> {
  if (ctx.signal.aborted) throw new BrainError({ code: 'CANCELLED', message: 'the feedback was cancelled' });
  const request = parseRequest(input);
  assertNoCredentials(request.reason, 'reason');
  const warning = UNRESOLVED_VERDICTS.includes(request.verdict)
    ? FEEDBACK_WARNING_UNRESOLVED
    : undefined;
  const writeFor = (scope: string): Parameters<typeof deps.journal.recordFeedback>[0] => ({
    principal_id: ctx.actor.id,
    idempotency_key: request.idempotency_key,
    scope,
    logical_id: request.id,
    revision_id: request.revision_id,
    ...(request.retrieval_id === undefined ? {} : { retrieval_id: request.retrieval_id }),
    ...(request.related_id === undefined ? {} : { related_id: request.related_id }),
    verdict: request.verdict,
    reason: request.reason,
    ...(warning === undefined ? {} : { warning })
  });
  return deps.mutations.runWithSharedKey(request.idempotency_key, async () => {
    const known = deps.journal.idempotencyKeyProject(request.idempotency_key);
    if (known !== undefined) {
      const replay = deps.journal.replayFeedback(writeFor(known.project_id ?? 'brain'));
      if (replay !== undefined) return { feedback_id: replay.entry.feedback_id, recorded: true };
    }
    const identifier = request.project ?? request.scope;
    const selected = identifier === undefined ? undefined : deps.projects.resolve(identifier)?.id;
    await reconcileDeps(deps);
    const source = currentByReferenceDeps(deps, { id: request.id });
    if (source.id === undefined) {
      throw localNotFound(`note ${request.id} has no managed revision to record feedback against`);
    }
    if (selected !== undefined && scopeForPathDeps(deps, source.path) !== selected) {
      throw new BrainError({ code: 'CONFLICT', message: `note ${request.id} is outside the selected project` });
    }
    try {
      await deps.documents.readRevision(source.id, request.revision_id);
    } catch (error) {
      if (isBrainError(error) && error.code === 'NOT_FOUND') {
        throw localNotFound(`revision ${request.revision_id} of note ${request.id} does not exist`);
      }
      throw error;
    }
    const stored = deps.journal.recordFeedback(writeFor(scopeForPathDeps(deps, source.path)));
    return { feedback_id: stored.entry.feedback_id, recorded: true };
  });
}

export interface RetrievalLabelResult {
  label_id: string;
  recorded: boolean;
  created: boolean;
}

export async function labelRetrieval(
  ctx: AuthenticatedContext,
  input: RetrievalLabelInput,
  deps: LocalHandlerDeps
): Promise<RetrievalLabelResult> {
  if (ctx.signal.aborted) throw cancelled();
  await reconcileDeps(deps);
  if (input.logical_id === undefined && input.path === undefined) {
    throw invalidInput('a retrieval label requires a logical id or a path');
  }
  const source =
    input.logical_id !== undefined
      ? currentByReferenceDeps(deps, { id: input.logical_id })
      : currentByReferenceDeps(deps, { path: input.path as string });
  return authorRetrievalLabel(deps.journal, {
    ...input,
    ...(source.id === undefined ? {} : { logical_id: source.id }),
    path: source.path,
    current: {
      source_hash: source.hash,
      ...(source.revision_id === undefined ? {} : { revision_id: source.revision_id })
    }
  });
}
