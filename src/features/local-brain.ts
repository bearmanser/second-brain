import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { BrainError } from '../contracts/errors.js';
import type { BrainConfig } from '../config/schema.js';
import {
  LEGACY_SHARED_CATEGORY,
  normalizeRecallMode,
  normalizeRecallScope
} from '../contracts/compatibility.js';
import { clampRecallBudget, countReferenceTokens } from '../retrieval/budget.js';import { rerankCandidates, selectFinalCandidates, type RerankWorker } from '../retrieval/reranker.js';
import type { RerankedCandidate } from '../retrieval/reranker.js';
import type { CurrentCatalogue, CurrentVault, CurrentSource } from '../notes/current-catalogue.js';
import { reconcileCurrentVault } from '../notes/current-catalogue.js';
import { contentKindForType } from '../notes/document.js';
import { documentFromNote, parseDocument, renderDocument } from '../notes/document-codec.js';
import { allocateNotePath, allocateProjectRoot, safeBasename } from '../notes/paths.js';
import { collectRenameSnapshots, planRename } from '../notes/rename.js';
import { indexReconciledDocuments } from '../notes/reconcile.js';
import { normalizeRepositoryIdentity, scopeCandidateForRepository } from '../projects/identity.js';
import type { DocumentStore } from '../storage/document-store.js';
import type { Journal, LocalOperationJournal } from '../storage/journal.js';
import type { SearchIndex } from '../storage/search-index.js';
import type {
  AuthenticatedContext,
  CaptureRequest,
  Clock,
  FeedbackRequest,
  FeedbackResult,
  IdSource,
  MutationReceipt,
  NoteInput,
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
import { clampReadBudget, paginate } from './read.js';

const DEFAULT_LIMIT = 10;
const CANDIDATE_LIMIT = 50;
const RERANK_LIMIT = 30;

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function cancelled(message: string): BrainError {
  return new BrainError({ code: 'CANCELLED', message });
}

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

export interface LocalBrain {
  config: BrainConfig;
  clock: Clock;
  ids: IdSource;
  documents: DocumentStore;
  catalogue: CurrentCatalogue;
  index: SearchIndex;
  journal: Journal;
  operations?: LocalOperationJournal;
  vault: CurrentVault;
  vaultRoot: string;
  worker?: RerankWorker;
  close(): Promise<void>;
}

function projectRecords(brain: LocalBrain): { id: string; relative_root: string }[] {
  const seen = new Map<string, { id: string; relative_root: string }>();
  for (const project of brain.journal.listProjects()) {
    seen.set(project.project.id, {
      id: project.project.id,
      relative_root: project.project.relative_root
    });
  }
  for (const scope of brain.config.scopes) {
    if (!seen.has(scope.id)) seen.set(scope.id, { id: scope.id, relative_root: scope.relative_root });
  }
  return [...seen.values()];
}

function resolveProjectId(brain: LocalBrain, identifier: string | undefined): string | undefined {
  if (identifier === undefined) return undefined;
  const project =
    brain.journal.getProjectById(identifier) ?? brain.journal.getProjectByIdentity(identifier);
  if (project !== undefined) return project.project.id;
  const scope = brain.config.scopes.find(
    (candidate) => candidate.id === identifier || candidate.repository_aliases.includes(identifier)
  );
  if (scope !== undefined) return scope.id;
  throw notFound(`project ${identifier} is not configured`);
}

function scopeForPath(brain: LocalBrain, path: string): string {
  for (const project of projectRecords(brain)) {
    if (path === project.relative_root || path.startsWith(`${project.relative_root}/`)) {
      return project.id;
    }
  }
  return 'brain';
}

function sourceRef(brain: LocalBrain, source: CurrentSource, warnings: string[] = []): SourceRef {
  return {
    id: source.id ?? source.path,
    revision_id: source.revision_id ?? source.hash,
    scope: scopeForPath(brain, source.path),
    title: source.title,
    kind: contentKindForType(source.type),
    status: source.status,
    etag: source.etag,
    relative_path: source.path,
    warnings
  };
}

function receiptFrom(
  result: { id: string; etag: string; revision_id: string; indexed: boolean },
  warnings: string[] = []
): MutationReceipt {
  return {
    operation_id: result.revision_id,
    id: result.id,
    revision_id: result.revision_id,
    outcome: 'stored',
    materialized: true,
    indexed: result.indexed,
    etag: result.etag,
    possible_duplicates: [],
    warnings
  };
}

async function reconcile(brain: LocalBrain): Promise<void> {
  const report = await reconcileCurrentVault({ vault: brain.vault, catalogue: brain.catalogue });
  indexReconciledDocuments({ catalogue: brain.catalogue, index: brain.index, report });
}

function currentByReference(
  brain: LocalBrain,
  reference: { id?: string; path?: string; title?: string }
): CurrentSource {
  const all = brain.catalogue.all();
  if (reference.id !== undefined) {
    const source = all.find((entry) => entry.id === reference.id);
    if (source === undefined) throw notFound(`note ${reference.id} was not found`);
    return source;
  }
  if (reference.path !== undefined) {
    const source = all.find((entry) => entry.path === reference.path);
    if (source === undefined) throw notFound(`note ${reference.path} was not found`);
    return source;
  }
  if (reference.title !== undefined) {
    const matches = all.filter((entry) => entry.title === reference.title);
    if (matches.length === 0) throw notFound(`note titled ${reference.title} was not found`);
    if (matches.length > 1) {
      throw new BrainError({
        code: 'AMBIGUOUS_REFERENCE',
        message: `title ${reference.title} matches multiple notes: ${matches
          .map((entry) => entry.path)
          .sort()
          .join(', ')}`
      });
    }
    return matches[0];
  }
  throw invalidInput('a read reference must select exactly one note');
}

export async function localCapture(
  ctx: AuthenticatedContext,
  input: CaptureRequest,
  brain: LocalBrain
): Promise<MutationReceipt> {
  if (ctx.signal.aborted) throw cancelled('the capture was cancelled');
  const projectId = resolveProjectId(brain, input.project ?? input.scope);
  const note: NoteInput = input.note;
  const now = brain.clock.now().toISOString();
  const directory =
    projectId === undefined
      ? 'Inbox'
      : (projectRecords(brain).find((project) => project.id === projectId)?.relative_root ?? 'Inbox');
  const occupied = brain.catalogue.all().map((source) => source.path);
  const path = allocateNotePath({ directory, title: note.title, occupied });
  const document = documentFromNote(note, {
    path,
    status: 'candidate',
    ...(projectId === undefined ? {} : { project: `[[${directory}]]` }),
    tags: note.tags,
    created: now,
    updated: now
  });
  const result = await brain.documents.put({
    path,
    raw: renderDocument(document),
    expectedEtag: null,
    idempotencyKey: input.idempotency_key,
    source: 'brain_capture'
  });
  await reconcile(brain);
  return receiptFrom(result);
}

export async function localRead(
  ctx: AuthenticatedContext,
  input: ReadRequest,
  brain: LocalBrain
): Promise<ReadResult> {
  if (ctx.signal.aborted) throw cancelled('the read was cancelled');
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
  brain: LocalBrain
): Promise<RecallResult> {
  if (ctx.signal.aborted) throw cancelled('the recall was cancelled');
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
    let plan: { kind?: string; heads?: { id: string; path: string }[];
      effects?: { kind: string; path?: string; write?: { path: string }; from_path?: string; to_path?: string }[];
      reference_edits?: { path: string }[] };
    try { plan = JSON.parse(record.plan_json) as typeof plan; }
    catch (error) { throw new BrainError({ code: 'RECOVERY_REQUIRED', message: 'pending recall exclusion plan is unreadable', cause: error }); }
    if (plan.kind !== 'note') continue;
    for (const head of plan.heads ?? []) { excluded.ids.add(head.id); excluded.paths.add(head.path); }
    for (const effect of plan.effects ?? []) {
      for (const path of [effect.path, effect.write?.path, effect.from_path, effect.to_path]) {
        if (path !== undefined) excluded.paths.add(path);
      }
    }
    for (const edit of plan.reference_edits ?? []) excluded.paths.add(edit.path);
  }
  candidates = candidates.filter((candidate) => !excluded.paths.has(candidate.path) &&
    !excluded.ids.has(candidate.id ?? ''));
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

export async function localFeedback(
  ctx: AuthenticatedContext,
  input: FeedbackRequest,
  brain: LocalBrain
): Promise<FeedbackResult> {
  await reconcile(brain);
  const source = currentByReference(brain, { id: input.id });
  if (source.id === undefined || source.revision_id === undefined) {
    throw notFound(`note ${input.id} has no managed revision to record feedback against`);
  }
  const warning = ['stale', 'incorrect', 'contradiction'].includes(input.verdict)
    ? 'unresolved_quality_concern'
    : undefined;
  const stored = brain.journal.recordFeedback({
    principal_id: ctx.actor.id,
    idempotency_key: input.idempotency_key,
    scope: scopeForPath(brain, source.path),
    logical_id: source.id,
    revision_id: source.revision_id,
    ...(input.retrieval_id === undefined ? {} : { retrieval_id: input.retrieval_id }),
    ...(input.related_id === undefined ? {} : { related_id: input.related_id }),
    verdict: input.verdict,
    reason: input.reason,
    ...(warning === undefined ? {} : { warning })
  });
  return { feedback_id: stored.entry.feedback_id, recorded: true };
}

export async function localStatus(
  ctx: AuthenticatedContext,
  input: StatusRequest,
  brain: LocalBrain
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
    const record = brain.journal.get(input.operation_id);
    if (record === undefined) throw notFound('the requested operation is not available');
    if (record.receipt_json !== undefined) {
      result.operation = JSON.parse(record.receipt_json) as MutationReceipt;
    }
  }
  if (input.include_schemas === true) {
    result.schemas = {};
  }
  return result;
}

export async function localProjectEnsure(
  ctx: AuthenticatedContext,
  input: ProjectEnsureRequest,
  brain: LocalBrain
): Promise<ProjectEnsureResult> {
  const identity = normalizeRepositoryIdentity(input.remote_url);
  const existing = brain.journal.getProjectByIdentity(identity);
  if (existing !== undefined) {
    if (existing.state !== 'ready') brain.journal.markProjectReady(existing.project.id);
    const ready = brain.journal.getProjectById(existing.project.id) ?? existing;
    return {
      operation_id: brain.ids.next(),
      repository_identity: identity,
      scope: ready.project.id,
      project_id: ready.project.id,
      relative_root: ready.project.relative_root,
      created: false,
      backend_ready: false,
      materialized: true,
      warnings: []
    };
  }
  const projectId = scopeCandidateForRepository(identity);
  if (brain.journal.getProjectById(projectId) !== undefined) {
    throw conflict(`project ${projectId} is already bound to another repository`);
  }
  const occupied = projectRecords(brain).map((project) => project.relative_root);
  const displayName = input.display_name ?? safeBasename(identity.split('/').at(-1) ?? identity);
  const relativeRoot = allocateProjectRoot(displayName, occupied);
  const operationId = brain.ids.next();
  brain.journal.reserveProject({
    repository_identity: identity,
    project_id: projectId,
    display_name: displayName,
    relative_root: relativeRoot,
    backend_project: projectId,
    backend_relative_root: relativeRoot,
    created_by_actor_id: ctx.actor.id,
    creation_operation_id: operationId
  });
  brain.journal.markProjectReady(projectId);
  return {
    operation_id: operationId,
    repository_identity: identity,
    scope: projectId,
    project_id: projectId,
    relative_root: relativeRoot,
    created: true,
    backend_ready: false,
    materialized: true,
    warnings: []
  };
}

async function writeDocument(
  brain: LocalBrain,
  source: CurrentSource,
  document: Parameters<typeof renderDocument>[0],
  idempotencyKey: string,
  sourceLabel: string,
  expectedEtag: string
): Promise<MutationReceipt> {
  const result = await brain.documents.put({
    path: source.path,
    raw: renderDocument(document),
    expectedEtag,
    idempotencyKey,
    source: sourceLabel
  });
  await reconcile(brain);
  return receiptFrom(result);
}

export async function localReview(
  ctx: AuthenticatedContext,
  input: ReviewRequest,
  brain: LocalBrain
): Promise<MutationReceipt | ReviewListResult> {
  await reconcile(brain);
  const operation = input.operation;
  if (operation.action === 'list') {
    const items = brain.catalogue
      .all()
      .filter((source) => (operation.filter === 'candidate' ? source.status === 'candidate' : false))
      .map((source) => sourceRef(brain, source));
    return { items };
  }
  if (operation.action === 'adopt') {
    const file = await brain.documents.readPath(operation.path);
    if (file.etag !== operation.expected_etag) {
      throw conflict(`path ${operation.path} changed since the expected etag`);
    }
    const parsed = parseDocument(file.raw, operation.path);
    if (parsed.id !== undefined) {
      return receiptFrom({
        id: parsed.id,
        etag: file.etag,
        revision_id: file.revision_id ?? parsed.id,
        indexed: true
      });
    }
    const adopted = { ...parsed, id: brain.ids.next() };
    const result = await brain.documents.put({
      path: operation.path,
      raw: renderDocument(adopted),
      expectedEtag: operation.expected_etag,
      idempotencyKey: operation.idempotency_key,
      source: 'brain_review_adopt'
    });
    await reconcile(brain);
    return receiptFrom(result);
  }
  if (operation.action === 'move') {
    if (operation.id === operation.target_path) throw invalidInput('a move must change the path');
    const source = currentByReference(brain, { id: operation.id });
    if (source.etag !== operation.expected_etag) {
      throw conflict(`note ${operation.id} changed since the expected etag`);
    }
    const files = await collectRenameSnapshots(brain.vaultRoot);
    const plan = planRename({
      from: source.path,
      to: operation.target_path,
      files,
      idempotency_key: operation.idempotency_key
    });
    if (plan.conflicts.length > 0) {
      throw conflict(`move target ${operation.target_path} is unavailable`);
    }
    const moved = await brain.documents.applyRename(plan);
    await reconcile(brain);
    const after = await brain.documents.readPath(operation.target_path);
    return receiptFrom({
      id: source.id ?? operation.id,
      etag: after.etag,
      revision_id: after.revision_id ?? moved.operation_id,
      indexed: moved.indexed.length > 0
    });
  }
  if (operation.action === 'resolve') {
    const source = currentByReference(brain, { id: operation.id });
    const file = await brain.documents.readPath(source.path);
    const base = parseDocument(file.raw, source.path);
    const document = documentFromNote(operation.note, {
      path: source.path,
      ...(source.id === undefined ? {} : { id: source.id }),
      status: 'candidate',
      ...(base.project === undefined ? {} : { project: base.project }),
      aliases: base.aliases,
      tags: base.tags,
      properties: base.properties
    });
    return writeDocument(
      brain,
      source,
      document,
      operation.idempotency_key,
      'brain_review_resolve',
      operation.expected_heads[0]?.etag ?? source.etag
    );
  }
  const source = currentByReference(brain, { id: operation.id });
  if (source.etag !== operation.expected_etag) {
    throw conflict(`note ${operation.id} changed since the expected etag`);
  }
  const file = await brain.documents.readPath(source.path);
  const base = parseDocument(file.raw, source.path);
  const now = brain.clock.now().toISOString();
  let document = base;
  const label = `brain_review_${operation.action}`;
  if (operation.action === 'approve') document = { ...base, status: 'active', updated: now };
  if (operation.action === 'archive') document = { ...base, status: 'archived', updated: now };
  if (operation.action === 'supersede') {
    document = {
      ...base,
      status: 'superseded',
      updated: now,
      properties: { ...base.properties, replacement_id: operation.replacement_id }
    };
  }
  if (operation.action === 'revise') {
    document = documentFromNote(operation.note, {
      path: source.path,
      ...(source.id === undefined ? {} : { id: source.id }),
      status: 'candidate',
      ...(base.project === undefined ? {} : { project: base.project }),
      aliases: base.aliases,
      tags: base.tags,
      created: base.created,
      updated: now,
      properties: base.properties
    });
  }
  return writeDocument(brain, source, document, operation.idempotency_key, label, operation.expected_etag);
}
