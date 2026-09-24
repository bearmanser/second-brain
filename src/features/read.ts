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
  AuthenticatedContext,
  Head,
  LocalHandlerDeps,
  ReadRequest,
  ReadResult,
  ScopeConfig,
  SourceCursorPosition,
  SourceRef
} from '../core/types.js';
import type { CurrentSource } from '../notes/current-catalogue.js';
import { projectParts } from '../retrieval/query.js';
import {
  conflict as localConflict,
  invalidInput as localInvalidInput,
  notFound as localNotFound,
  reconcileCatalogueDeps,
  sourceRefManaged
} from './local-support.js';
import { requiredProject } from '../projects/registry.js';
import { countReferenceTokens } from '../retrieval/budget.js';
import { modelVisibleRepresentation, toolResultByteLength } from '../mcp/tools.js';
import {
  finalizeStoredCursorV2,
  reserveStoredCursorV2,
  verifyCursorV2,
  verifyLegacyCursor,
  verifyStoredCursorV1,
  verifyStoredCursorV2,
  type CursorPayloadV1,
  type CursorPayloadV2
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

function toCursorV2(payload: CursorPayloadV1): CursorPayloadV2 {
  return {
    version: 2,
    scope: payload.scope,
    id: payload.id,
    revision_id: payload.revision_id,
    raw_hash: payload.raw_hash,
    offset: payload.offset,
    expires_at: payload.expires_at
  };
}

function decodeCursor(
  cursor: string,
  secret: Uint8Array,
  now: Date,
  deps: BrainDeps
): CursorPayloadV2 {
  if (cursor.startsWith('r2.')) return verifyStoredCursorV2(cursor, secret, now, deps.journal);
  if (cursor.startsWith('v2.')) return verifyCursorV2(cursor, secret, now);
  if (cursor.startsWith('r1.')) return toCursorV2(verifyStoredCursorV1(cursor, secret, now, deps.journal));
  return toCursorV2(verifyLegacyCursor(cursor, secret, now));
}

async function requireSelectedSource(
  scope: ScopeConfig,
  id: string,
  revisionId: string | undefined,
  deps: BrainDeps
): Promise<void> {
  const located = await deps.catalogue.locate(scope.id, id, revisionId);
  if (located === undefined) {
    throw notFound(`note ${id} is not catalogued in scope ${scope.id}`);
  }
  try {
    await deps.vault.read(scope.id, located.relative_path);
  } catch (error) {
    if (isBrainError(error) && error.code === 'NOT_FOUND') {
      throw notFound(`note ${id} has no remaining source file in scope ${scope.id}`);
    }
    throw error;
  }
  throw conflict(`note ${id} has a conflicting source in scope ${scope.id}`);
}

async function loadHead(
  scope: ScopeConfig,
  id: string,
  revisionId: string | undefined,
  cursor: CursorPayloadV2 | undefined,
  deps: BrainDeps
): Promise<Head> {
  const selectedRevision = cursor?.revision_id ?? revisionId;
  try {
    return selectedRevision === undefined
      ? await deps.catalogue.get(scope.id, id)
      : await deps.catalogue.getRevision(scope.id, id, selectedRevision);
  } catch (error) {
    if (isBrainError(error) && error.code === 'CONFLICT') {
      await requireSelectedSource(scope, id, selectedRevision, deps);
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
  ctx: AuthenticatedContext,
  input: ReadRequest,
  deps: BrainDeps
): Promise<ReadResult> {
  if (ctx.signal.aborted) throw cancelled();
  const scope = deps.scopeRegistry.require(requiredProject(input));
  const request = parseRequest(input);
  const id = request.id;
  if (id === undefined) {
    throw invalidInput('the legacy read path requires a managed note id');
  }
  const now = deps.clock.now();

  if (ctx.signal.aborted) throw cancelled();

  let cursor: CursorPayloadV2 | undefined;
  if (request.cursor !== undefined) {
    const secret = loadCursorSecret(deps);
    cursor = decodeCursor(request.cursor, secret, now, deps);
    if (cursor.scope !== scope.id || cursor.id !== id) {
      throw invalidInput('read cursor does not belong to the requested note');
    }
    if (request.revision_id !== undefined && request.revision_id !== cursor.revision_id) {
      throw invalidInput('read cursor does not match the requested revision');
    }
  }

  const head = await loadHead(scope, id, request.revision_id, cursor, deps);
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
  const cursorPayload = (end: number): CursorPayloadV2 => ({
    version: 2,
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
  const reservation = reserveStoredCursorV2(cursorPayload(offset), cursorSecret(), deps.journal);
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
    const nextCursor = finalizeStoredCursorV2(reservation, cursorPayload(end), deps.journal);
    finalized = true;
    return candidate(best, nextCursor);
  } finally {
    if (!finalized) deps.journal.deleteReadCursor(reservation.cursor_id);
  }
}

function localCancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the read was cancelled' });
}

function matchesProject(deps: LocalHandlerDeps, source: CurrentSource, relativeRoot: string | undefined, projectId: string | undefined): boolean {
  if (projectId === undefined) return true;
  if (source.id !== undefined && projectId !== undefined) {
    const declared = source.project;
    if (declared !== undefined) {
      const parts = projectParts(declared);
      if (parts.leaf === projectId || parts.norm === relativeRoot?.toLowerCase()) return true;
    }
  }
  if (relativeRoot === undefined) return false;
  const normalized = source.path.replace(/\\/g, '/');
  const root = relativeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === root || normalized.startsWith(`${root}/`);
}

function conflictSourcesForPath(deps: LocalHandlerDeps, path: string): CurrentSource[] {
  for (const id of deps.catalogue.conflictIds()) {
    const sources = deps.catalogue.conflictsFor(id);
    if (sources.some((source) => source.path === path)) return sources;
  }
  return [];
}

function conflictPaths(sources: readonly CurrentSource[]): string {
  return sources
    .map((source) => source.path)
    .sort()
    .join(', ');
}

function resolveCurrentSource(
  deps: LocalHandlerDeps,
  request: ReadRequest,
  relativeRoot: string | undefined,
  projectId: string | undefined
): CurrentSource {
  const all = deps.catalogue.all().filter((source) => matchesProject(deps, source, relativeRoot, projectId));
  if (request.id !== undefined) {
    const conflicts = deps.catalogue.conflictsFor(request.id);
    if (conflicts.length > 0) {
      throw localConflict(`note ${request.id} has conflicting sources: ${conflictPaths(conflicts)}`);
    }
    const found = all.find((source) => source.id === request.id);
    if (found === undefined) throw localNotFound(`note ${request.id} was not found`);
    return found;
  }
  if (request.path !== undefined) {
    const conflicts = conflictSourcesForPath(deps, request.path);
    if (conflicts.length > 0) {
      throw localConflict(`note ${request.path} has conflicting sources: ${conflictPaths(conflicts)}`);
    }
    const found = all.find((source) => source.path === request.path);
    if (found === undefined) throw localNotFound(`note ${request.path} was not found`);
    return found;
  }
  const title = request.title as string;
  const matches = all.filter((source) => source.title === title);
  if (matches.length === 0) throw localNotFound(`note titled ${title} was not found`);
  if (matches.length > 1) {
    throw new BrainError({
      code: 'AMBIGUOUS_REFERENCE',
      message: `title ${title} matches multiple notes: ${matches
        .map((source) => source.path)
        .sort()
        .join(', ')}`
    });
  }
  const found = matches[0];
  if (found.id !== undefined) {
    const conflicts = deps.catalogue.conflictsFor(found.id);
    if (conflicts.length > 0) {
      throw localConflict(`note ${found.id} has conflicting sources: ${conflictPaths(conflicts)}`);
    }
  }
  const pathConflicts = conflictSourcesForPath(deps, found.path);
  if (pathConflicts.length > 0) {
    throw localConflict(`note ${found.path} has conflicting sources: ${conflictPaths(pathConflicts)}`);
  }
  return found;
}

function historicalSource(
  deps: LocalHandlerDeps,
  request: ReadRequest,
  relativeRoot: string | undefined,
  projectId: string | undefined
): CurrentSource | undefined {
  const all = deps.catalogue.all().filter((source) => matchesProject(deps, source, relativeRoot, projectId));
  const conflicts = request.id === undefined ? [] : deps.catalogue.conflictsFor(request.id);
  return (
    all.find((source) => source.id === request.id) ??
    conflicts.find((source) => source.revision_id === request.revision_id) ??
    all.find((source) => source.id === request.id && source.revision_id === request.revision_id) ??
    conflicts[0]
  );
}

export async function readLocal(
  ctx: AuthenticatedContext,
  input: ReadRequest,
  deps: LocalHandlerDeps
): Promise<ReadResult> {
  if (ctx.signal.aborted) throw localCancelled();
  const request = parseRequest(input);
  const identifier = request.project ?? request.scope;
  const resolved = identifier === undefined ? undefined : deps.projects.resolve(identifier);
  await reconcileCatalogueDeps(deps);
  if (ctx.signal.aborted) throw localCancelled();
  const relativeRoot = resolved?.relative_root;
  const projectId = resolved?.id;
  const budget = clampReadBudget(request.budget_tokens);
  const offsetFor = (
    cursor: string | undefined,
    scope: { id: string; path: string; revision_id: string; etag: string }
  ): number => {
    if (cursor === undefined) return 0;
    const position = deps.cursors.verify(cursor, scope);
    if (request.revision_id !== undefined && position.revision_id !== request.revision_id) {
      throw localInvalidInput('the read cursor does not match the requested revision');
    }
    if (position.raw_hash !== scope.etag) {
      throw localConflict('the note changed since the page cursor was issued; restart the read');
    }
    return position.offset;
  };

  if (request.revision_id !== undefined) {
    const id = request.id as string;
    const metadata = historicalSource(deps, request, relativeRoot, projectId);
    let cursorOffset = 0;
    let cursorPayload: SourceCursorPosition | undefined;
    if (request.cursor !== undefined) {
      cursorPayload = deps.cursors.verify(request.cursor, {
        id,
        path: metadata?.path ?? '',
        revision_id: request.revision_id,
        etag: ''
      });
      if (cursorPayload.revision_id !== request.revision_id) {
        throw localInvalidInput('the read cursor does not match the requested revision');
      }
    }
    const revision = await deps.documents.readRevision(id, request.revision_id);
    if (cursorPayload !== undefined && cursorPayload.raw_hash !== revision.hash) {
      throw localConflict('the note changed since the page cursor was issued; restart the read');
    }
    cursorOffset = cursorPayload?.offset ?? 0;
    const scope = {
      id,
      path: metadata?.path ?? '',
      revision_id: request.revision_id,
      etag: revision.hash
    };
    const offset = cursorOffset;
    const page = paginate(revision.raw, offset, budget);
    const source: SourceRef =
      metadata === undefined
        ? {
            id,
            revision_id: request.revision_id,
            scope: 'brain',
            title: id,
            kind: 'note',
            status: 'candidate',
            etag: revision.hash,
            relative_path: '',
            warnings: ['historical']
          }
        : {
            ...sourceRefManaged(deps, metadata, ['historical']),
            revision_id: request.revision_id,
            etag: revision.hash
          };
    const result: ReadResult = { source, markdown: page.page };
    if (page.nextOffset !== undefined) {
      result.next_cursor = deps.cursors.issue({
        ...scope,
        offset: page.nextOffset,
        expires_at: new Date(deps.clock.now().getTime() + CURSOR_TTL_MS).toISOString()
      });
    }
    return result;
  }

  const source = resolveCurrentSource(deps, request, relativeRoot, projectId);
  const file = await deps.documents.readPath(source.path);
  const scope = {
    id: source.id ?? source.path,
    path: source.path,
    revision_id: source.revision_id ?? file.etag,
    etag: file.etag
  };
  const offset = offsetFor(request.cursor, scope);
  const page = paginate(file.raw, offset, budget);
  const result: ReadResult = { source: sourceRefManaged(deps, source), markdown: page.page };
  if (page.nextOffset !== undefined) {
    result.next_cursor = deps.cursors.issue({
      ...scope,
      offset: page.nextOffset,
      expires_at: new Date(deps.clock.now().getTime() + CURSOR_TTL_MS).toISOString()
    });
  }
  return result;
}
