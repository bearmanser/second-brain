import { readFileSync } from 'node:fs';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { readRequestSchema } from '../contracts/protocol.js';
import {
  CURSOR_TTL_MS,
  READ_BUDGET_TOKENS_DEFAULT,
  READ_BUDGET_TOKENS_MAX,
  READ_BUDGET_TOKENS_MIN,
  RENDERED_NOTE_MAX_BYTES
} from '../core/limits.js';
import type { BrainDeps } from '../core/mutation.js';
import type {
  Head,
  ReadRequest,
  ReadResult,
  RequestContext,
  ScopeConfig,
  SourceRef
} from '../core/types.js';
import { resolveScopes } from '../security/authorise.js';
import { countReferenceTokens } from '../retrieval/budget.js';
import { modelVisibleRepresentation, toolResultByteLength } from '../mcp/tools.js';
import {
  finalizeStoredCursor,
  reserveStoredCursor,
  verifyCursor,
  verifyStoredCursor,
  type CursorPayload
} from '../retrieval/cursor.js';

export const READ_WARNING_HISTORICAL = 'historical';

const MIN_CURSOR_SECRET_BYTES = 32;

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function cancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the read' });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function limitExceeded(message: string): BrainError {
  return new BrainError({ code: 'LIMIT_EXCEEDED', message });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

export function clampReadBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return READ_BUDGET_TOKENS_DEFAULT;
  const rounded = Math.trunc(value);
  if (rounded < READ_BUDGET_TOKENS_MIN) return READ_BUDGET_TOKENS_MIN;
  if (rounded > READ_BUDGET_TOKENS_MAX) return READ_BUDGET_TOKENS_MAX;
  return rounded;
}

function parseRequest(input: ReadRequest): ReadRequest {
  const candidate: ReadRequest = { ...input, budget_tokens: clampReadBudget(input.budget_tokens) };
  const parsed = readRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`read request is invalid: ${detail}`);
  }
  return parsed.data as ReadRequest;
}

function loadCursorSecret(deps: BrainDeps): Uint8Array {
  const path = deps.config.cursor_secret_file;
  if (path === undefined || path.length === 0) {
    throw recoveryRequired(
      'the read-cursor signing secret is not configured; set cursor_secret_file from BRAIN_CURSOR_SECRET'
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw recoveryRequired('the read-cursor signing secret cannot be read', cause);
  }
  if (bytes.length === 0) {
    throw recoveryRequired('the read-cursor signing secret is empty');
  }
  if (bytes.length < MIN_CURSOR_SECRET_BYTES) {
    throw recoveryRequired(
      `the read-cursor signing secret must be at least ${MIN_CURSOR_SECRET_BYTES} bytes`
    );
  }
  return new Uint8Array(bytes);
}

async function requireSelectedSource(
  scope: ScopeConfig,
  request: ReadRequest,
  revisionId: string | undefined,
  deps: BrainDeps
): Promise<void> {
  const located = await deps.catalogue.locate(scope.id, request.id, revisionId);
  if (located === undefined) {
    throw notFound(`note ${request.id} is not catalogued in scope ${scope.id}`);
  }
  try {
    await deps.vault.read(scope.id, located.relative_path);
  } catch (error) {
    if (isBrainError(error) && error.code === 'NOT_FOUND') {
      throw notFound(`note ${request.id} has no remaining source file in scope ${scope.id}`);
    }
    throw error;
  }
  throw conflict(`note ${request.id} has a conflicting source in scope ${scope.id}`);
}

async function loadHead(
  scope: ScopeConfig,
  request: ReadRequest,
  cursor: CursorPayload | undefined,
  deps: BrainDeps
): Promise<Head> {
  const revisionId = cursor?.revision_id ?? request.revision_id;
  try {
    return revisionId === undefined
      ? await deps.catalogue.get(scope.id, request.id)
      : await deps.catalogue.getRevision(scope.id, request.id, revisionId);
  } catch (error) {
    if (isBrainError(error) && error.code === 'CONFLICT') {
      await requireSelectedSource(scope, request, revisionId, deps);
    }
    throw error;
  }
}

async function ensureHistoricalWarning(
  scope: ScopeConfig,
  head: Head,
  selectedRevisionId: string | undefined,
  warnings: string[],
  deps: BrainDeps
): Promise<void> {
  if (selectedRevisionId === undefined || warnings.includes(READ_WARNING_HISTORICAL)) return;
  let current: Head | undefined;
  try {
    current = await deps.catalogue.get(scope.id, head.revision.id);
  } catch {
    current = undefined;
  }
  if (current === undefined || current.revision.revision_id !== head.revision.revision_id) {
    warnings.push(READ_WARNING_HISTORICAL);
  }
}

async function readMaterialized(scope: ScopeConfig, head: Head, deps: BrainDeps): Promise<string> {
  const file = await deps.vault.read(scope.id, head.source.relative_path);
  if (file.raw_hash !== head.raw_hash) {
    throw conflict('the note changed while it was being read; retry the request');
  }
  return file.raw;
}

export function paginate(
  markdown: string,
  offset: number,
  budget: number
): { page: string; nextOffset?: number } {
  const points = [...markdown];
  const total = points.length;
  if (offset >= total) return { page: '' };
  const remaining = total - offset;
  let low = 1;
  let high = remaining;
  let best = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = points.slice(offset, offset + middle).join('');
    if (
      countReferenceTokens(candidate) <= budget &&
      Buffer.byteLength(candidate, 'utf8') <= RENDERED_NOTE_MAX_BYTES
    ) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === 0) best = 1;
  const end = offset + best;
  const page = points.slice(offset, end).join('');
  return end >= total ? { page } : { page, nextOffset: end };
}

export async function read(
  ctx: RequestContext,
  input: ReadRequest,
  deps: BrainDeps
): Promise<ReadResult> {
  if (ctx.signal.aborted) throw cancelled();
  const [scope] = resolveScopes(ctx.principal, input.scope, false, 'read', deps.scopeRegistry);
  const request = parseRequest(input);
  const now = deps.clock.now();

  if (ctx.signal.aborted) throw cancelled();

  let cursor: CursorPayload | undefined;
  if (request.cursor !== undefined) {
    cursor = request.cursor.startsWith('r1.')
      ? verifyStoredCursor(request.cursor, loadCursorSecret(deps), ctx, now, deps.journal)
      : verifyCursor(request.cursor, loadCursorSecret(deps), ctx, now);
    if (cursor.scope !== scope.id || cursor.id !== request.id) {
      throw invalidInput('read cursor does not belong to the requested note');
    }
    if (request.revision_id !== undefined && request.revision_id !== cursor.revision_id) {
      throw invalidInput('read cursor does not match the requested revision');
    }
  }

  const head = await loadHead(scope, request, cursor, deps);
  const explicitRevision = (cursor?.revision_id ?? request.revision_id) !== undefined;
  const inspectableFork =
    explicitRevision &&
    head.state === 'conflict' &&
    head.source.warnings.includes('fork') &&
    !head.source.warnings.includes('duplicate_identity') &&
    !head.source.warnings.includes('duplicate_revision_id');
  if ((head.state === 'conflict' && !inspectableFork) || head.state === 'malformed') {
    throw conflict(`note ${request.id} has a ${head.state} head and cannot be read`);
  }

  const markdown = await readMaterialized(scope, head, deps);
  if (cursor !== undefined && cursor.raw_hash !== head.raw_hash) {
    throw conflict('the note changed since the page cursor was issued; restart the read');
  }
  if (Buffer.byteLength(markdown, 'utf8') > RENDERED_NOTE_MAX_BYTES) {
    throw limitExceeded(
      `note ${request.id} exceeds the ${RENDERED_NOTE_MAX_BYTES} byte rendered note limit`
    );
  }

  const warnings = [...head.source.warnings];
  if (
    deps.journal.hasUnresolvedQualityConcern(
      scope.id,
      head.revision.id,
      head.revision.revision_id
    ) &&
    !warnings.includes('unresolved_quality_concern')
  ) {
    warnings.push('unresolved_quality_concern');
  }
  if (head.state === 'manual_unreviewed' && !warnings.includes('manual_unreviewed')) {
    warnings.push('manual_unreviewed');
  }
  const selectedRevisionId = cursor?.revision_id ?? request.revision_id;
  await ensureHistoricalWarning(scope, head, selectedRevisionId, warnings, deps);
  const source: SourceRef = { ...head.source, warnings };

  const budget = clampReadBudget(request.budget_tokens);
  const offset = cursor?.offset ?? 0;
  const points = [...markdown];
  const remaining = Math.max(0, points.length - offset);
  const expires = new Date(now.getTime() + CURSOR_TTL_MS).toISOString();
  let secret: Uint8Array | undefined;
  const cursorSecret = (): Uint8Array => {
    secret ??= loadCursorSecret(deps);
    return secret;
  };
  const cursorPayload = (end: number): CursorPayload => ({
    principal_id: ctx.principal.id,
    scope: scope.id,
    id: head.revision.id,
    revision_id: head.revision.revision_id,
    raw_hash: head.raw_hash,
    offset: end,
    expires_at: expires
  });
  const candidate = (length: number, nextCursor?: string): ReadResult => {
    const end = offset + length;
    const page = points.slice(offset, end).join('');
    if (end >= points.length) return { source, markdown: page };
    if (nextCursor === undefined) {
      throw recoveryRequired('the paginated read cursor was not reserved');
    }
    return { source, markdown: page, next_cursor: nextCursor };
  };
  const fits = (result: ReadResult): boolean =>
    countReferenceTokens(
      modelVisibleRepresentation(
        'brain_read',
        result as unknown as Record<string, unknown>,
        deps.config.result_delivery
      )
    ) <= budget &&
    toolResultByteLength(
      'brain_read',
      result as unknown as Record<string, unknown>,
      deps.config.result_delivery
    ) <= deps.config.limits.tool_result_max_bytes &&
    Buffer.byteLength(result.markdown, 'utf8') <= RENDERED_NOTE_MAX_BYTES;
  const complete = candidate(remaining);
  if (fits(complete)) return complete;
  const reservation = reserveStoredCursor(cursorPayload(offset), cursorSecret(), deps.journal);
  let finalized = false;
  try {
    let low = 0;
    let high = remaining;
    let best = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const result = candidate(middle, reservation.token);
      if (fits(result)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best < 0 || (best === 0 && remaining > 0)) {
      throw limitExceeded('the read budget is too small for the source and pagination envelope');
    }
    const end = offset + best;
    const nextCursor = finalizeStoredCursor(reservation, cursorPayload(end), deps.journal);
    finalized = true;
    return candidate(best, nextCursor);
  } finally {
    if (!finalized) deps.journal.deleteReadCursor(reservation.cursor_id);
  }
}
