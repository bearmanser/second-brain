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

function isProtected(scope: string, revision: StoredRevision): boolean {
  const kind = revision.note.content.kind;
  if (kind === 'preference') return true;
  if (PROTECTED_SCOPES.includes(scope)) return true;
  return kind === 'decision' && revision.status === 'active';
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

function preservedApproval(revision: StoredRevision): StoredRevision['approval'] {
  if (revision.approval === undefined) return undefined;
  return revision.approval.payload_hash === payloadHash(revision) ? revision.approval : undefined;
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

async function optionalHead(deps: BrainDeps, scope: string, id: string): Promise<Head | undefined> {
  try {
    return await deps.catalogue.get(scope, id);
  } catch (error) {
    if (isBrainError(error) && (error.code === 'NOT_FOUND' || error.code === 'CONFLICT')) {
      return undefined;
    }
    throw error;
  }
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

interface ForkAnalysis {
  heads: ParsedRevision[];
  error?: BrainError;
}

async function analyseFork(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { id: string; expected_heads: { revision_id: string; etag: string }[] },
  deps: BrainDeps
): Promise<ForkAnalysis> {
  const parsed: ParsedRevision[] = [];
  const unreadable: string[] = [];
  let paths: string[];
  try {
    paths = await deps.vault.list(scope.id);
  } catch (error) {
    return { heads: [], error: recoveryRequired(`scope ${scope.id} cannot be enumerated`) };
  }
  for (const path of paths) {
    let read: { raw: string; raw_hash: string; relative_path: string };
    try {
      read = await deps.vault.read(scope.id, path);
    } catch {
      continue;
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
    return {
      heads: [],
      error: recoveryRequired(
        `note ${operation.id} has unreadable revisions: ${[...new Set(unreadable)].join(', ')}`
      )
    };
  }
  if (parsed.length === 0) {
    return { heads: [], error: notFound(`note ${operation.id} is not present in scope ${scope.id}`) };
  }
  const resolution = resolveHead(parsed);
  if (resolution.state === 'ready') {
    return {
      heads: [],
      error: conflict(`note ${operation.id} has a unique head; there is no revision fork to resolve`)
    };
  }
  const structural = [
    ...new Set(resolution.reasons.filter((reason) => STRUCTURAL_REASONS.includes(reason)))
  ];
  if (structural.length > 0) {
    return {
      heads: resolution.heads,
      error: recoveryRequired(`note ${operation.id} has corrupt ancestry: ${structural.join(', ')}`)
    };
  }
  const heads = resolution.heads;
  const protectedNote = heads.some((head) => isProtected(scope.id, head.revision));
  if (protectedNote && !canReview(ctx.principal, scope.id, true)) {
    return { heads, error: forbidden('a protected note can only be resolved by an owner') };
  }
  const expected = new Map(
    heads.map((head) => [head.revision.revision_id, makeEtag(head.revision.revision_id, head.raw_hash)])
  );
  if (operation.expected_heads.length !== expected.size) {
    return {
      heads,
      error: conflict(
        `resolve requires exactly the complete set of ${expected.size} conflict heads`
      )
    };
  }
  const seen = new Set<string>();
  for (const item of operation.expected_heads) {
    if (seen.has(item.revision_id)) {
      return { heads, error: conflict('expected_heads contains a duplicate revision') };
    }
    seen.add(item.revision_id);
    const etag = expected.get(item.revision_id);
    if (etag === undefined) {
      return {
        heads,
        error: conflict(`expected head ${item.revision_id} is not a current conflict head`)
      };
    }
    if (etag !== item.etag) {
      return { heads, error: conflict(`expected head ${item.revision_id} has a stale etag`) };
    }
  }
  return { heads };
}

interface ReplacementAnalysis {
  error?: BrainError;
}

async function analyseReplacement(
  ctx: RequestContext,
  scope: ScopeConfig,
  operation: { id: string; replacement_id: string },
  deps: BrainDeps
): Promise<ReplacementAnalysis> {
  if (operation.replacement_id === operation.id) {
    return { error: invalidInput('a note cannot supersede itself') };
  }
  if (!ctx.principal.read_scopes.includes(scope.id)) {
    return { error: forbidden('the replacement note is not readable by this principal') };
  }
  let replacement: Head;
  try {
    replacement = await deps.catalogue.get(scope.id, operation.replacement_id);
  } catch (error) {
    if (isBrainError(error) && error.code === 'NOT_FOUND') {
      return {
        error: conflict('the replacement note is not an active note in the same readable scope')
      };
    }
    if (isBrainError(error) && error.code === 'CONFLICT') {
      return { error: conflict('the replacement note is conflicted and cannot be superseded-to') };
    }
    throw error;
  }
  if (replacement.state !== 'ready' || replacement.revision.status !== 'active') {
    return {
      error: conflict('supersession requires a readable active replacement in the same scope')
    };
  }
  let cursor = replacement.revision.replacement_id;
  const visited = new Set<string>([operation.replacement_id]);
  for (let depth = 0; cursor !== undefined; depth += 1) {
    if (cursor === operation.id) {
      return { error: conflict('supersession would create a replacement cycle') };
    }
    if (visited.has(cursor)) {
      return { error: conflict('the replacement chain already contains a cycle') };
    }
    if (depth > MAX_SUPERSESSION_DEPTH) {
      return { error: conflict('the replacement chain is too deep') };
    }
    visited.add(cursor);
    const next = await optionalHead(deps, scope.id, cursor);
    cursor = next?.revision.replacement_id;
  }
  return {};
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
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
  };
  const build: RevisionBuilder = (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    if (!canReview(ctx.principal, scope.id, isProtected(scope.id, head.revision))) {
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
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
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
      approval: preservedApproval(head.revision),
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
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
  };
  const build: RevisionBuilder = (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    if (isProtected(scope.id, head.revision) && !canReview(ctx.principal, scope.id, true)) {
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
  const replacement = await analyseReplacement(ctx, scope, operation, deps);
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: { ...decisionPayload('supersede', operation), replacement_id: operation.replacement_id },
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
  };
  const build: RevisionBuilder = (identities, heads) => {
    if (replacement.error !== undefined) throw replacement.error;
    const head = requireSingleHead(heads, operation.id);
    if (!canReview(ctx.principal, scope.id, false)) {
      throw forbidden(`principal ${ctx.principal.id} may not supersede note ${operation.id}`);
    }
    const base: StoredRevision = {
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
      approval: preservedApproval(head.revision),
      extra_frontmatter: head.revision.extra_frontmatter,
      extra_markdown: head.revision.extra_markdown
    };
    return base;
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
  const fork = await analyseFork(ctx, scope, operation, deps);
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
    expected_heads: operation.expected_heads.map((item) => ({
      id: operation.id,
      revision_id: item.revision_id,
      etag: item.etag
    }))
  };
  const build: RevisionBuilder = (identities, heads) => {
    if (fork.error !== undefined) throw fork.error;
    if (heads.length !== operation.expected_heads.length || heads.length === 0) {
      throw conflict('resolve did not verify the complete set of conflict heads');
    }
    const parents = heads.map((head) => ({
      revision_id: head.revision.revision_id,
      raw_hash: head.raw_hash
    }));
    return {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents,
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
