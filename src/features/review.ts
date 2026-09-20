import { BrainError, isBrainError } from '../contracts/errors.js';
import { reviewRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps, MutationIntent, RevisionBuilder } from '../core/mutation.js';
import type {
  Head,
  MutationReceipt,
  NoteInput,
  RequestContext,
  ReviewListResult,
  ReviewRequest,
  ScopeConfig,
  StoredRevision
} from '../core/types.js';
import { decodeRevision, makeEtag, normalizeLineEndings, payloadHash } from '../notes/codec.js';
import { resolveHead, type ParsedRevision } from '../notes/catalogue.js';
import { canReview, resolveScopes } from '../security/authorise.js';
import { assertNoCredentials } from '../security/redact.js';

const REVIEW_TOOL = 'brain_review';
const FACTUAL_KINDS: readonly string[] = ['lesson', 'fact', 'decision', 'playbook'];
const PROTECTED_SCOPES: readonly string[] = ['shared', 'profile'];
const STRUCTURAL_REASONS: readonly string[] = [
  'duplicate_revision_id',
  'multiple_logical_ids',
  'multiple_scopes',
  'missing_parent',
  'parent_hash_mismatch',
  'cycle'
];
const MAX_SUPERSESSION_DEPTH = 64;

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function parseRequest(input: ReviewRequest): ReviewRequest {
  const parsed = reviewRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`review request is invalid: ${detail}`);
  }
  return parsed.data as ReviewRequest;
}

function normalizeString(value: string): string {
  return normalizeLineEndings(value);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) normalized[key] = normalizeValue(source[key]);
    return normalized;
  }
  return value;
}

function normalizeNote(note: NoteInput): NoteInput {
  return {
    title: normalizeString(note.title),
    tags: note.tags.map((tag) => normalizeString(tag)),
    content: normalizeValue(note.content) as NoteInput['content'],
    evidence: note.evidence.map((entry) => ({
      kind: entry.kind,
      ref: normalizeString(entry.ref),
      description: normalizeString(entry.description),
      ...(entry.observed_at === undefined ? {} : { observed_at: entry.observed_at })
    })),
    related_ids: [...note.related_ids]
  };
}

function collectStrings(
  value: unknown,
  field: string,
  found: { field: string; value: string }[]
): void {
  if (typeof value === 'string') {
    found.push({ field, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${field}[${index}]`, found));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, field.length === 0 ? key : `${field}.${key}`, found);
    }
  }
}

function rejectCredentialText(note: NoteInput): void {
  const strings: { field: string; value: string }[] = [];
  collectStrings(note, 'note', strings);
  for (const entry of strings) assertNoCredentials(entry.value, entry.field);
}

function readScope(ctx: RequestContext, requested: string, deps: BrainDeps): ScopeConfig {
  const [scope] = resolveScopes(ctx.principal, requested, false, 'read', deps.config.scopes);
  return scope;
}

function writeScope(ctx: RequestContext, requested: string, deps: BrainDeps): ScopeConfig {
  const [scope] = resolveScopes(ctx.principal, requested, false, 'write', deps.config.scopes);
  return scope;
}

function reviewScope(ctx: RequestContext, requested: string, deps: BrainDeps): ScopeConfig {
  const [scope] = resolveScopes(ctx.principal, requested, false, 'review', deps.config.scopes);
  return scope;
}

function hasValidApproval(revision: StoredRevision, deps: BrainDeps): boolean {
  return deps.catalogue.approvalIsValid(revision);
}

async function hasApprovedAncestor(
  scope: string,
  revision: StoredRevision,
  deps: BrainDeps
): Promise<boolean> {
  const visited = new Set<string>();
  const queue: StoredRevision[] = [revision];
  while (queue.length > 0) {
    const current = queue.shift() as StoredRevision;
    if (visited.has(current.revision_id)) continue;
    visited.add(current.revision_id);
    if (hasValidApproval(current, deps)) return true;
    for (const parent of current.parents) {
      if (visited.has(parent.revision_id)) return true;
      let head: Head;
      try {
        head = await deps.catalogue.getRevision(scope, revision.id, parent.revision_id);
      } catch {
        return true;
      }
      if (head.state !== 'ready' && head.state !== 'manual_unreviewed') return true;
      if (head.raw_hash !== parent.raw_hash) return true;
      queue.push(head.revision);
    }
  }
  return false;
}

async function isProtectedNote(
  scope: string,
  revision: StoredRevision,
  deps: BrainDeps
): Promise<boolean> {
  const kind = revision.note.content.kind;
  if (kind === 'preference') return true;
  if (PROTECTED_SCOPES.includes(scope)) return true;
  if (kind !== 'decision') return false;
  return hasApprovedAncestor(scope, revision, deps);
}

function requireSingleHead(heads: Head[], id: string): Head {
  if (heads.length !== 1 || heads[0].revision.id !== id) {
    throw invalidInput('a review transition may target only one logical note head');
  }
  return heads[0];
}

function parentOf(head: Head): { revision_id: string; raw_hash: string }[] {
  return [{ revision_id: head.revision.revision_id, raw_hash: head.raw_hash }];
}

function preservedApproval(
  revision: StoredRevision,
  deps: BrainDeps
): StoredRevision['approval'] {
  return hasValidApproval(revision, deps) ? revision.approval : undefined;
}

function assertApprovable(head: Head): void {
  if (head.state === 'conflict') {
    throw conflict(`note ${head.revision.id} has a conflict; resolve the fork before approval`);
  }
  if (head.state === 'malformed') {
    throw conflict(`note ${head.revision.id} is malformed and cannot be approved`);
  }
  if (head.state === 'manual_unreviewed') return;
  if (head.revision.status !== 'candidate') {
    throw conflict(
      `note ${head.revision.id} is ${head.revision.status}; only candidate or manually changed content can be approved`
    );
  }
}

function assertApprovalEvidence(note: NoteInput): void {
  const kind = note.content.kind;
  if (!FACTUAL_KINDS.includes(kind)) return;
  const supported = note.evidence.some((entry) => entry.kind !== 'hypothesis');
  if (!supported) {
    throw invalidInput(`approval of a ${kind} requires at least one non-hypothesis evidence item`);
  }
}

function decisionPayload(
  action: string,
  operation: { id: string; expected_etag: string; rationale: string }
): Record<string, unknown> {
  return {
    action,
    id: operation.id,
    expected_etag: operation.expected_etag,
    rationale: operation.rationale
  };
}

function declaredBrainId(raw: string): string | undefined {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) return undefined;
  const frontmatter = lines.slice(1, close).join('\n');
  const match = /^[ \t]*brain_id:[ \t]*(.*)$/m.exec(frontmatter);
  if (match === null) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, '');
  return value.length > 0 ? value : undefined;
}

function parsedRevisionToHead(scope: string, parsed: ParsedRevision): Head {
  const revision = parsed.revision;
  return {
    revision,
    source: {
      id: revision.id,
      revision_id: revision.revision_id,
      scope,
      title: revision.note.title,
      kind: revision.note.content.kind,
      status: revision.status,
      etag: makeEtag(revision.revision_id, parsed.raw_hash),
      relative_path: parsed.relative_path,
      warnings: []
    },
    raw_hash: parsed.raw_hash,
    state: 'conflict'
  };
}

async function analyseFork(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { id: string; expected_heads: { revision_id: string; etag: string }[] },
  deps: BrainDeps
): Promise<Head[]> {
  let paths: string[];
  try {
    paths = await deps.vault.list(scope.id);
  } catch (error) {
    throw recoveryRequired(`scope ${scope.id} cannot be enumerated`, error);
  }
  const parsed: ParsedRevision[] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    let read: { raw: string; raw_hash: string; relative_path: string };
    try {
      read = await deps.vault.read(scope.id, path);
    } catch (error) {
      throw recoveryRequired(`scope ${scope.id} cannot be read while resolving a fork`, error);
    }
    try {
      const revision = decodeRevision(read.raw);
      if (revision.id !== operation.id) continue;
      parsed.push({ revision, raw_hash: read.raw_hash, relative_path: read.relative_path });
    } catch (error) {
      if (declaredBrainId(read.raw) !== operation.id) continue;
      unreadable.push(
        isBrainError(error) && error.code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'malformed'
      );
    }
  }
  if (unreadable.length > 0) {
    throw recoveryRequired(
      `note ${operation.id} has unreadable revisions: ${[...new Set(unreadable)].join(', ')}`
    );
  }
  if (parsed.length === 0) {
    throw notFound(`note ${operation.id} is not present in scope ${scope.id}`);
  }
  const resolution = resolveHead(parsed);
  if (resolution.state === 'ready') {
    throw conflict(`note ${operation.id} has a unique head; there is no revision fork to resolve`);
  }
  const structural = [
    ...new Set(resolution.reasons.filter((reason) => STRUCTURAL_REASONS.includes(reason)))
  ];
  if (structural.length > 0) {
    throw recoveryRequired(`note ${operation.id} has corrupt ancestry: ${structural.join(', ')}`);
  }
  const heads = resolution.heads;
  for (const head of heads) {
    if ((await isProtectedNote(scope.id, head.revision, deps)) && !canReview(ctx.principal, scope.id, true)) {
      throw forbidden('a protected note can only be resolved by an owner');
    }
  }
  const expected = new Map(
    heads.map((head) => [head.revision.revision_id, makeEtag(head.revision.revision_id, head.raw_hash)])
  );
  if (operation.expected_heads.length !== expected.size) {
    throw conflict(`resolve requires exactly the complete set of ${expected.size} conflict heads`);
  }
  const seen = new Set<string>();
  for (const item of operation.expected_heads) {
    if (seen.has(item.revision_id)) {
      throw conflict('expected_heads contains a duplicate revision');
    }
    seen.add(item.revision_id);
    const etag = expected.get(item.revision_id);
    if (etag === undefined) {
      throw conflict(`expected head ${item.revision_id} is not a current conflict head`);
    }
    if (etag !== item.etag) {
      throw conflict(`expected head ${item.revision_id} has a stale etag`);
    }
  }
  return heads.map((head) => parsedRevisionToHead(scope.id, head));
}

async function requireChainHead(scope: string, id: string, deps: BrainDeps): Promise<Head> {
  let head: Head;
  try {
    head = await deps.catalogue.get(scope, id);
  } catch (error) {
    if (isBrainError(error)) {
      if (error.code === 'UNSUPPORTED_SCHEMA') {
        throw recoveryRequired(`replacement chain link ${id} uses an unsupported schema`, error);
      }
      if (error.code === 'NOT_FOUND') {
        throw conflict(`replacement chain link ${id} is missing`);
      }
      if (error.code === 'CONFLICT') {
        throw conflict(`replacement chain link ${id} is conflicted`);
      }
    }
    throw error;
  }
  if (head.state !== 'ready' && head.state !== 'manual_unreviewed') {
    throw conflict(`replacement chain link ${id} is conflicted`);
  }
  return head;
}

async function assertReplacement(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { id: string; replacement_id: string },
  deps: BrainDeps
): Promise<void> {
  if (operation.replacement_id === operation.id) {
    throw invalidInput('a note cannot supersede itself');
  }
  if (!ctx.principal.read_scopes.includes(scope.id)) {
    throw forbidden('the replacement note is not readable by this principal');
  }
  const replacement = await requireChainHead(scope.id, operation.replacement_id, deps);
  if (replacement.revision.status !== 'active') {
    throw conflict('supersession requires a readable active replacement in the same scope');
  }
  let cursor = replacement.revision.replacement_id;
  const visited = new Set<string>([operation.replacement_id]);
  for (let depth = 0; cursor !== undefined; depth += 1) {
    if (cursor === operation.id) {
      throw conflict('supersession would create a replacement cycle');
    }
    if (visited.has(cursor)) {
      throw conflict('the replacement chain already contains a cycle');
    }
    if (depth > MAX_SUPERSESSION_DEPTH) {
      throw conflict('the replacement chain is too deep');
    }
    visited.add(cursor);
    const link = await requireChainHead(scope.id, cursor, deps);
    cursor = link.revision.replacement_id;
  }
}

async function listAction(
  ctx: RequestContext,
  requested: string,
  operation: { filter: 'candidate' | 'conflict'; cursor?: string },
  deps: BrainDeps
): Promise<ReviewListResult> {
  const scope = readScope(ctx, requested, deps);
  await deps.catalogue.reconcile(scope.id);
  const page = await deps.catalogue.list(scope.id, operation.filter, operation.cursor);
  const readable = new Set(ctx.principal.read_scopes);
  const items = page.items.filter((item) => readable.has(item.scope));
  return page.next_cursor === undefined ? { items } : { items, next_cursor: page.next_cursor };
}

async function approveAction(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { idempotency_key: string; id: string; expected_etag: string; rationale: string },
  deps: BrainDeps
): Promise<MutationReceipt> {
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: decisionPayload('approve', operation),
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }],
    authorization: 'review'
  };
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    const protectedNote = await isProtectedNote(scope.id, head.revision, deps);
    if (!canReview(ctx.principal, scope.id, protectedNote)) {
      throw forbidden(`principal ${ctx.principal.id} may not approve note ${operation.id}`);
    }
    assertApprovable(head);
    assertApprovalEvidence(head.revision.note);
    const base: StoredRevision = {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: parentOf(head),
      scope: scope.id,
      status: 'active',
      note: head.revision.note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      extra_frontmatter: head.revision.extra_frontmatter,
      extra_markdown: head.revision.extra_markdown
    };
    return {
      ...base,
      approval: {
        principal_id: ctx.principal.id,
        rationale: operation.rationale,
        payload_hash: payloadHash(base)
      }
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

async function archiveAction(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { idempotency_key: string; id: string; expected_etag: string; rationale: string },
  deps: BrainDeps
): Promise<MutationReceipt> {
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: decisionPayload('archive', operation),
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }],
    authorization: 'review'
  };
  const build: RevisionBuilder = (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    if (!canReview(ctx.principal, scope.id, false)) {
      throw forbidden(`principal ${ctx.principal.id} may not archive note ${operation.id}`);
    }
    return {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: parentOf(head),
      scope: scope.id,
      status: 'archived',
      note: head.revision.note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      approval: preservedApproval(head.revision, deps),
      extra_frontmatter: head.revision.extra_frontmatter,
      extra_markdown: head.revision.extra_markdown
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

async function reviseAction(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: {
    idempotency_key: string;
    id: string;
    expected_etag: string;
    rationale: string;
    note: NoteInput;
  },
  deps: BrainDeps
): Promise<MutationReceipt> {
  const note = normalizeNote(operation.note);
  rejectCredentialText(note);
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: { ...decisionPayload('revise', operation), note },
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }],
    authorization: 'write'
  };
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    if ((await isProtectedNote(scope.id, head.revision, deps)) && !canReview(ctx.principal, scope.id, true)) {
      throw forbidden(`only an owner may revise the protected note ${operation.id}`);
    }
    return {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: parentOf(head),
      scope: scope.id,
      status: 'candidate',
      note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      extra_frontmatter: head.revision.extra_frontmatter,
      extra_markdown: head.revision.extra_markdown
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

async function supersedeAction(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: {
    idempotency_key: string;
    id: string;
    expected_etag: string;
    rationale: string;
    replacement_id: string;
  },
  deps: BrainDeps
): Promise<MutationReceipt> {
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: { ...decisionPayload('supersede', operation), replacement_id: operation.replacement_id },
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }],
    authorization: 'review'
  };
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    if (!canReview(ctx.principal, scope.id, false)) {
      throw forbidden(`principal ${ctx.principal.id} may not supersede note ${operation.id}`);
    }
    await assertReplacement(ctx, scope, operation, deps);
    return {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: parentOf(head),
      scope: scope.id,
      status: 'superseded',
      note: head.revision.note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      replacement_id: operation.replacement_id,
      approval: preservedApproval(head.revision, deps),
      extra_frontmatter: head.revision.extra_frontmatter,
      extra_markdown: head.revision.extra_markdown
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

async function resolveAction(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: {
    idempotency_key: string;
    id: string;
    expected_heads: { revision_id: string; etag: string }[];
    rationale: string;
    note: NoteInput;
  },
  deps: BrainDeps
): Promise<MutationReceipt> {
  const note = normalizeNote(operation.note);
  rejectCredentialText(note);
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: {
      action: 'resolve',
      id: operation.id,
      rationale: operation.rationale,
      expected_heads: operation.expected_heads,
      note
    },
    expected_heads: [],
    authorization: 'review',
    resolve_heads: (lockedScope) => analyseFork(ctx, lockedScope, operation, deps)
  };
  const build: RevisionBuilder = (identities, heads) => {
    if (heads.length !== operation.expected_heads.length || heads.length === 0) {
      throw conflict('resolve did not verify the complete set of conflict heads');
    }
    return {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: heads.map((head) => ({
        revision_id: head.revision.revision_id,
        raw_hash: head.raw_hash
      })),
      scope: scope.id,
      status: 'candidate',
      note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      extra_frontmatter: heads[0].revision.extra_frontmatter,
      extra_markdown: heads[0].revision.extra_markdown
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

export async function review(
  ctx: RequestContext,
  input: ReviewRequest,
  deps: BrainDeps
): Promise<MutationReceipt | ReviewListResult> {
  const request = parseRequest(input);
  const operation = request.operation;
  if (operation.action === 'list') {
    return listAction(ctx, request.scope, operation, deps);
  }
  if (operation.action === 'revise') {
    const scope = writeScope(ctx, request.scope, deps);
    return reviseAction(ctx, scope, operation, deps);
  }
  const scope = reviewScope(ctx, request.scope, deps);
  switch (operation.action) {
    case 'approve':
      return approveAction(ctx, scope, operation, deps);
    case 'archive':
      return archiveAction(ctx, scope, operation, deps);
    case 'supersede':
      return supersedeAction(ctx, scope, operation, deps);
    case 'resolve':
      return resolveAction(ctx, scope, operation, deps);
  }
}
