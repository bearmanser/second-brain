import { BrainError, isBrainError } from '../contracts/errors.js';
import { feedbackRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps } from '../core/mutation.js';
import type {
  FeedbackRequest,
  FeedbackResult,
  RecallResult,
  RequestContext,
  ScopeConfig
} from '../core/types.js';
import { resolveScopes } from '../security/authorise.js';
import { assertNoCredentials } from '../security/redact.js';
import type {
  AuditEvent,
  RetrievalEventInput,
  RetrievalOutcome
} from '../storage/journal.js';

export { AUDIT_FIELDS, FEEDBACK_REASON_MAX_LENGTH } from '../storage/journal.js';

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

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
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

function authorizeTarget(ctx: RequestContext, requested: string, deps: BrainDeps): ScopeConfig {
  const [scope] = resolveScopes(ctx.principal, requested, false, 'read', deps.config.scopes);
  return scope;
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

async function authorizeRelated(ctx: RequestContext, relatedId: string, deps: BrainDeps): Promise<void> {
  const scopes = deps.config.scopes.filter((scope) => ctx.principal.read_scopes.includes(scope.id));
  for (const scope of scopes) {
    try {
      await deps.catalogue.get(scope.id, relatedId);
      return;
    } catch (error) {
      if (!isBrainError(error)) throw error;
      if (error.code === 'NOT_FOUND') continue;
      if (error.code === 'CONFLICT') return;
      throw error;
    }
  }
  throw forbidden(`related note ${relatedId} is not an authorized reference`);
}

function assertRetrievalBinding(
  ctx: RequestContext,
  request: FeedbackRequest,
  scopeId: string,
  deps: BrainDeps
): void {
  const retrieval_id = request.retrieval_id;
  if (retrieval_id === undefined) return;
  const event = deps.journal.getRetrieval(retrieval_id);
  const valid =
    event !== undefined &&
    event.principal_id === ctx.principal.id &&
    event.scope_ids.includes(scopeId) &&
    event.returned_ids.some(
      (entry) => entry.id === request.id && entry.revision_id === request.revision_id
    );
  if (!valid) {
    throw invalidInput('the retrieval reference is not valid for this caller, scope, and revision');
  }
}

function recordAudit(
  deps: BrainDeps,
  ctx: RequestContext,
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
  scope: string;
  duration_ms: number;
  outcome?: RetrievalOutcome;
}

export function retrievalEventFromRecall(
  ctx: RequestContext,
  result: RecallResult,
  options: RetrievalEventOptions
): RetrievalEventInput {
  const scopeIds = [options.scope, ...result.items.map((item) => item.scope)];
  return {
    retrieval_id: result.retrieval_id,
    principal_id: ctx.principal.id,
    scope: options.scope,
    scope_ids: [...new Set(scopeIds)],
    returned_ids: result.items.map((item) => ({
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
  ctx: RequestContext,
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
    const scope = authorizeTarget(ctx, request.scope, deps);
    if (request.related_id !== undefined) {
      await authorizeRelated(ctx, request.related_id, deps);
    }
    assertNoCredentials(request.reason, 'reason');
    const warning = UNRESOLVED_VERDICTS.includes(request.verdict)
      ? FEEDBACK_WARNING_UNRESOLVED
      : undefined;
    const write = {
      principal_id: ctx.principal.id,
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
    assertRetrievalBinding(ctx, request, scope.id, deps);
    const stored = deps.journal.recordFeedback(write);
    recordAudit(deps, ctx, 'recorded', started, 1);
    return { feedback_id: stored.entry.feedback_id, recorded: true };
  } catch (error) {
    recordAudit(deps, ctx, 'rejected', started);
    throw error;
  }
}
