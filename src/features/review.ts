import { BrainError, isBrainError } from '../contracts/errors.js';
import { reviewRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps, MutationIntent, RevisionBuilder } from '../core/mutation.js';
import type {
  AuthenticatedContext,
  Head,
  MutationReceipt,
  NoteInput,
  ProjectSelector,
  ReviewListResult,
  ReviewRequest,
  ScopeConfig,
  StoredRevision
} from '../core/types.js';
import { decodeRevision, makeEtag, normalizeLineEndings, payloadHash } from '../notes/codec.js';
import { resolveHead, type ParsedRevision } from '../notes/catalogue.js';
import { requiredProject } from '../projects/registry.js';
import { assertNoCredentials } from '../security/redact.js';
import { validateRelatedIds } from './related.js';

import {
  documentFromNote,
  parseDocument,
  parseSources,
  renderDocument,
  reviseDocument
} from '../notes/document-codec.js';
import { contentKindForType, type CurrentDocument } from '../notes/document.js';
import { collectRenameSnapshots, planRename } from '../notes/rename.js';
import type {
  AuthenticatedContext as LocalContext,
  LocalExpectedHead,
  LocalHandlerDeps,
  LocalOperationIntent,
  LocalOperationPlan,
  LocalReferenceEdit,
  LocalReadCondition,
  MutationReceipt as LocalMutationReceipt,
  NoteInput as LocalNoteInput,
  ReviewListResult as LocalReviewListResult
} from '../core/types.js';
import {
  currentByReferenceDeps,
  invalidInput as localInvalidInput,
  mutationReceipt,
  reconcileDeps,
  sourceRefForDeps
} from './local-support.js';

const REVIEW_TOOL = 'brain_review';
const FACTUAL_KINDS: readonly string[] = ['lesson', 'fact', 'decision', 'playbook'];
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

function resolveProject(request: ProjectSelector, deps: BrainDeps): ScopeConfig {
  return deps.scopeRegistry.require(requiredProject(request));
}

function hasValidApproval(revision: StoredRevision, deps: BrainDeps): boolean {
  return deps.catalogue.approvalIsValid(revision);
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
  scope: ScopeConfig,
  operation: { id: string; replacement_id: string },
  deps: BrainDeps
): Promise<void> {
  if (operation.replacement_id === operation.id) {
    throw invalidInput('a note cannot supersede itself');
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
  request: ProjectSelector,
  operation: { filter: 'candidate' | 'conflict'; cursor?: string },
  deps: BrainDeps
): Promise<ReviewListResult> {
  const scope = resolveProject(request, deps);
  await deps.catalogue.reconcile(scope.id);
  return deps.catalogue.list(scope.id, operation.filter, operation.cursor);
}

async function approveAction(
  ctx: AuthenticatedContext,
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
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
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
        principal_id: ctx.actor.id,
        rationale: operation.rationale,
        payload_hash: payloadHash(base)
      }
    };
  };
  return deps.mutations.commit(ctx, intent, build);
}

async function archiveAction(
  ctx: AuthenticatedContext,
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
  ctx: AuthenticatedContext,
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
  await validateRelatedIds(note.related_ids, deps);
  rejectCredentialText(note);
  const intent: MutationIntent = {
    tool: REVIEW_TOOL,
    scope: scope.id,
    idempotency_key: operation.idempotency_key,
    payload: { ...decisionPayload('revise', operation), note },
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
  };
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
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
  ctx: AuthenticatedContext,
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
    expected_heads: [{ id: operation.id, etag: operation.expected_etag }]
  };
  const build: RevisionBuilder = async (identities, heads) => {
    const head = requireSingleHead(heads, operation.id);
    await assertReplacement(scope, operation, deps);
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
  ctx: AuthenticatedContext,
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
  await validateRelatedIds(note.related_ids, deps);
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
    resolve_heads: (lockedScope) => analyseFork(lockedScope, operation, deps)
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
  ctx: AuthenticatedContext,
  input: ReviewRequest,
  deps: BrainDeps
): Promise<MutationReceipt | ReviewListResult> {
  const request = parseRequest(input);
  const operation = request.operation;
  if (operation.action === 'list') {
    return listAction(request, operation, deps);
  }
  const scope = resolveProject(request, deps);
  switch (operation.action) {
    case 'revise':
      return reviseAction(ctx, scope, operation, deps);
    case 'approve':
      return approveAction(ctx, scope, operation, deps);
    case 'archive':
      return archiveAction(ctx, scope, operation, deps);
    case 'supersede':
      return supersedeAction(ctx, scope, operation, deps);
    case 'resolve':
      return resolveAction(ctx, scope, operation, deps);
    case 'move':
    case 'adopt':
      throw invalidInput('the legacy review path does not support move or adopt');
  }
}


function previousInputForRevision(base: CurrentDocument): LocalNoteInput {
  return {
    title: base.title,
    tags: [...base.tags],
    content: {
      kind: 'note',
      summary: base.title,
      body_markdown: contentKindForType(base.type) === 'note' ? '' : base.body
    },
    evidence: [],
    related_ids: []
  };
}

function preservedDocument(
  base: CurrentDocument,
  note: LocalNoteInput,
  status: CurrentDocument['status']
): CurrentDocument {
  const now = new Date().toISOString();
  if (contentKindForType(base.type) === 'note') {
    return reviseDocument(base, note, {
      previous: previousInputForRevision(base),
      meta: { status, updated: now }
    });
  }
  return documentFromNote(note, {
    path: base.path,
    ...(base.id === undefined ? {} : { id: base.id }),
    status,
    ...(base.project === undefined ? {} : { project: base.project }),
    aliases: base.aliases,
    tags: base.tags,
    created: base.created,
    updated: now,
    properties: base.properties
  });
}

async function readDocument(deps: LocalHandlerDeps, path: string): Promise<CurrentDocument> {
  const file = await deps.documents.readPath(path);
  return parseDocument(file.raw, path);
}

function approveEvidenceOk(base: CurrentDocument): boolean {
  const kind = contentKindForType(base.type);
  if (!FACTUAL_KINDS.includes(kind)) return true;
  const parsed = parseSources(base.body);
  return parsed.evidence.some((entry) => entry.kind !== 'hypothesis');
}

function noteReadCondition(source: {
  id: string;
  path: string;
  revision_id: string;
  etag: string;
}): LocalReadCondition {
  return {
    kind: 'note',
    id: source.id,
    expected: {
      kind: 'present',
      path: source.path,
      revision_id: source.revision_id,
      etag: source.etag
    }
  };
}

async function deriveReferenceEdits(
  deps: LocalHandlerDeps,
  logicalId: string,
  absorbed: readonly string[],
  survivor: string
): Promise<LocalReferenceEdit[]> {
  const files = await collectRenameSnapshots(deps.vaultRoot);
  const removed = new Set(absorbed);
  const merged = new Map<string, LocalReferenceEdit>();
  for (const from of absorbed) {
    const plan = planRename({
      from,
      to: survivor,
      files,
      idempotency_key: `resolve:${logicalId}:${from}`
    });
    const blocking = plan.conflicts.filter(
      (entry) => !(entry.reason === 'target_occupied' && entry.path === survivor)
    );
    if (blocking.length > 0) {
      throw conflict(`the resolution cannot rewrite references from ${from}`);
    }
    for (const unresolved of plan.unresolved) {
      if (unresolved.path === survivor || unresolved.path === from) continue;
      if (unresolved.reason === 'ambiguous') {
        throw conflict(
          `an ambiguous reference to ${from} in ${unresolved.path} blocks the resolution`
        );
      }
    }
    for (const edit of plan.edits) {
      if (removed.has(edit.path) || edit.path === survivor) continue;
      const existing = merged.get(edit.path);
      if (existing !== undefined) {
        if (existing.raw !== edit.raw) {
          throw conflict(`references in ${edit.path} cannot be composed safely`);
        }
        continue;
      }
      const source = deps.catalogue.getByPath(edit.path);
      merged.set(edit.path, {
        path: edit.path,
        expected_etag: edit.expected_hash,
        raw: edit.raw,
        ...(source?.id === undefined
          ? {}
          : {
              managed: {
                id: source.id,
                revision_id: deps.ids.next(),
                parents: []
              }
            })
      });
    }
  }
  return [...merged.values()];
}

async function resolvePlan(
  deps: LocalHandlerDeps,
  operation: Extract<ReviewRequest['operation'], { action: 'resolve' }>
): Promise<LocalOperationPlan> {
  const heads = await deps.mutations.enumerateConflictHeads(operation.id);
  if (heads.length < 2) {
    throw conflict(`note ${operation.id} does not have a resolvable fork`);
  }
  const expected = operation.expected_heads;
  if (expected.length !== heads.length) {
    throw conflict('resolve requires exactly the complete set of current conflict heads');
  }
  for (const head of expected) {
    if (!heads.some((candidate) => candidate.revision_id === head.revision_id && candidate.etag === head.etag)) {
      throw conflict('resolve requires exactly the complete set of current conflict heads');
    }
  }
  await deps.mutations.verifyConflictHeads(operation.id, expected);
  const ordered = [...heads].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const survivor = ordered[0];
  const absorbed = ordered.slice(1);
  const survivors = new Set([survivor.path]);
  const removals = absorbed.map((head) => ({
    kind: 'remove' as const,
    path: head.path,
    expected_id: operation.id,
    expected_revision_id: head.revision_id,
    expected_etag: head.etag
  }));
  const referenceEdits = await deriveReferenceEdits(
    deps,
    operation.id,
    absorbed.map((head) => head.path),
    survivor.path
  );
  const base = await readDocument(deps, survivor.path);
  const parents = heads.map((head) => ({ revision_id: head.revision_id, raw_hash: head.etag }));
  return (identity) => {
    if (identity.kind !== 'note') throw localInvalidInput('resolve requires a note identity');
    const document = preservedDocument(base, operation.note, 'candidate');
    const resolved: CurrentDocument = { ...document, path: survivor.path };
    const readSet: LocalReadCondition[] = [
      {
        kind: 'heads',
        id: operation.id,
        expected_heads: heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag }))
      },
      ...heads.map((head) =>
        noteReadCondition({ id: operation.id, path: head.path, revision_id: head.revision_id, etag: head.etag })
      ),
      ...referenceEdits.map((edit): LocalReadCondition => {
        if (edit.managed !== undefined) {
          const source = deps.catalogue.getByPath(edit.path);
          return noteReadCondition({
            id: edit.managed.id,
            path: edit.path,
            revision_id: source?.revision_id ?? source?.hash ?? edit.expected_etag,
            etag: edit.expected_etag
          });
        }
        return { kind: 'path', path: edit.path, expected: { kind: 'present', etag: edit.expected_etag } };
      })
    ];
    return {
      kind: 'note',
      heads,
      parents,
      read_set: readSet as unknown as import('../core/types.js').LocalReadSet,
      effects: [
        {
          kind: 'write',
          write: {
            path: survivor.path,
            raw: renderDocument(resolved),
            id: operation.id,
            revision_id: identity.revision_id,
            parents
          }
        },
        ...removals
      ],
      reference_edits: referenceEdits
    };
  };
}

export async function reviewLocal(
  ctx: LocalContext,
  input: ReviewRequest,
  deps: LocalHandlerDeps
): Promise<LocalMutationReceipt | LocalReviewListResult> {
  if (ctx.signal.aborted) throw new BrainError({ code: 'CANCELLED', message: 'the review was cancelled' });
  const request = parseRequest(input);
  await reconcileDeps(deps);
  const operation = request.operation;
  if (operation.action === 'list') {
    const items = deps.catalogue
      .all()
      .filter((source) => (operation.filter === 'candidate' ? source.status === 'candidate' : false))
      .map((source) => sourceRefForDeps(deps, source));
    return { items };
  }
  if (operation.action === 'resolve') {
    const plan = await resolvePlan(deps, operation);
    const intent: LocalOperationIntent = {
      tool: 'brain_review',
      action: 'resolve',
      project_id: null,
      idempotency_key: operation.idempotency_key,
      payload: operation,
      preconditions: { id: operation.id, expected_heads: [...operation.expected_heads] }
    };
    const result = await deps.mutations.run(intent, plan);
    await reconcileDeps(deps);
    return mutationReceipt(result);
  }
  if (operation.action === 'move') {
    const source = currentByReferenceDeps(deps, { id: operation.id });
    if (source.id === undefined) throw conflict(`note ${operation.id} is unmanaged and cannot be moved`);
    if (source.etag !== operation.expected_etag) {
      throw conflict(`note ${operation.id} changed since the expected etag`);
    }
    const intent: LocalOperationIntent = {
      tool: 'brain_review',
      action: 'move',
      project_id: null,
      idempotency_key: operation.idempotency_key,
      payload: operation,
      preconditions: { id: operation.id, etag: operation.expected_etag, target_path: operation.target_path }
    };
    const plan: LocalOperationPlan = (identity) => {
      if (identity.kind !== 'note') throw localInvalidInput('move requires a note identity');
      return {
        kind: 'note',
        heads: [],
        parents: [],
        read_set: [
          noteReadCondition({
            id: source.id as string,
            path: source.path,
            revision_id: source.revision_id ?? source.hash,
            etag: source.etag
          }),
          { kind: 'path', path: operation.target_path, expected: { kind: 'absent' } }
        ],
        effects: [{ kind: 'move', from_path: source.path, to_path: operation.target_path }]
      };
    };
    const result = await deps.mutations.run(intent, plan);
    await reconcileDeps(deps);
    return mutationReceipt(result);
  }
  if (operation.action === 'adopt') {
    const file = await deps.documents.readPath(operation.path);
    if (file.etag !== operation.expected_etag) {
      throw conflict(`path ${operation.path} changed since the expected etag`);
    }
    const parsed = parseDocument(file.raw, operation.path);
    const intent: LocalOperationIntent = {
      tool: 'brain_review',
      action: 'adopt',
      project_id: null,
      idempotency_key: operation.idempotency_key,
      payload: operation,
      preconditions: { path: operation.path, etag: operation.expected_etag }
    };
    const plan: LocalOperationPlan = (identity) => {
      if (identity.kind !== 'note') throw localInvalidInput('adopt requires a note identity');
      const adopted = parsed.id === undefined ? { ...parsed, id: identity.note_id } : parsed;
      return {
        kind: 'note',
        heads: [],
        parents: [],
        read_set: [
          { kind: 'path', path: operation.path, expected: { kind: 'present', etag: operation.expected_etag } }
        ],
        effects: [
          {
            kind: 'write',
            write: {
              path: operation.path,
              raw: renderDocument(adopted),
              id: adopted.id as string,
              revision_id: identity.revision_id,
              parents: []
            }
          }
        ]
      };
    };
    const result = await deps.mutations.run(intent, plan);
    await reconcileDeps(deps);
    return mutationReceipt(result);
  }
  const source = currentByReferenceDeps(deps, { id: operation.id });
  if (source.id === undefined) throw conflict(`note ${operation.id} is unmanaged`);
  if (source.etag !== operation.expected_etag) {
    throw conflict(`note ${operation.id} changed since the expected etag`);
  }
  const base = await readDocument(deps, source.path);
  const intent: LocalOperationIntent = {
    tool: 'brain_review',
    action: operation.action,
    project_id: null,
    idempotency_key: operation.idempotency_key,
    payload: operation,
    preconditions: { id: operation.id, etag: operation.expected_etag }
  } as LocalOperationIntent;
  const plan: LocalOperationPlan = async (identity) => {
    if (identity.kind !== 'note') throw localInvalidInput('review requires a note identity');
    let document: CurrentDocument;
    const readSet: LocalReadCondition[] = [
      noteReadCondition({
        id: source.id as string,
        path: source.path,
        revision_id: source.revision_id ?? source.hash,
        etag: source.etag
      })
    ];
    if (operation.action === 'approve') {
      if (!approveEvidenceOk(base)) {
        throw localInvalidInput('approval requires at least one non-hypothesis evidence item');
      }
      document = { ...base, status: 'active', updated: new Date().toISOString() };
    } else if (operation.action === 'archive') {
      document = { ...base, status: 'archived', updated: new Date().toISOString() };
    } else if (operation.action === 'supersede') {
      const replacement = deps.catalogue.getById(operation.replacement_id);
      if (replacement === undefined) throw conflict('supersession requires an existing replacement');
      if (replacement.status !== 'active') throw conflict('supersession requires an active replacement');
      let cursor: string | undefined = operation.replacement_id;
      const visited = new Set<string>([operation.id]);
      while (cursor !== undefined) {
        if (visited.has(cursor)) throw conflict('supersession would create a replacement cycle');
        visited.add(cursor);
        const heads = await deps.mutations.enumerateConflictHeads(cursor);
        if (heads.length !== 1) {
          throw conflict(`replacement ${cursor} has no unique durable current revision`);
        }
        const head = heads[0];
        readSet.push(
          noteReadCondition({
            id: cursor,
            path: head.path,
            revision_id: head.revision_id,
            etag: head.etag
          })
        );
        const linkDocument = await readDocument(deps, head.path);
        const next = linkDocument.properties.replacement_id;
        cursor = typeof next === 'string' ? next : undefined;
      }
      document = {
        ...base,
        status: 'superseded',
        updated: new Date().toISOString(),
        properties: { ...base.properties, replacement_id: operation.replacement_id }
      };
    } else {
      if (operation.action !== 'revise') throw localInvalidInput('unsupported review action');
      document = preservedDocument(base, operation.note, 'candidate');
    }
    return {
      kind: 'note',
      heads: [],
      parents: [],
      read_set: readSet as unknown as import('../core/types.js').LocalReadSet,
      effects: [
        {
          kind: 'write',
          write: {
            path: source.path,
            raw: renderDocument(document),
            id: source.id as string,
            revision_id: identity.revision_id,
            parents: []
          }
        }
      ]
    };
  };
  const result = await deps.mutations.run(intent, plan);
  await reconcileDeps(deps);
  return mutationReceipt(result);
}
