import { readFileSync } from 'node:fs';
import { BrainError } from '../contracts/errors.js';
import type { BrainConfig } from '../config/schema.js';
import {
  reconcileCurrentVault,
  type CurrentCatalogue,
  type CurrentSource,
  type CurrentVault,
  type ReconcileCurrentVaultReport
} from '../notes/current-catalogue.js';
import { contentKindForType } from '../notes/document.js';
import { indexReconciledDocuments } from '../notes/reconcile.js';
import { LocalMutationCoordinator } from '../core/mutation.js';
import {
  finalizeStoredCursorV2,
  reserveStoredCursorV2,
  verifyStoredCursorV2,
  type CursorPayloadV2
} from '../retrieval/cursor.js';
import type { DocumentStore } from '../storage/document-store.js';
import { openRevisionStore, type RevisionStore } from '../storage/revision-store.js';
import type { Journal, LocalOperationJournal } from '../storage/journal.js';
import type { SearchIndex } from '../storage/search-index.js';
import type { RerankWorker } from '../retrieval/reranker.js';
import type {
  Clock,
  IdSource,
  LocalHandlerDeps,
  LocalMutationCoordinatorPort,
  LocalOperationReceipt,
  LocalPendingAffected,
  LocalPendingOperation,
  MutationReceipt,
  ProjectResolutionPort,
  ResolvedProject,
  SourceBoundCursorPort,
  SourceCursorScope,
  SourceRef
} from '../core/types.js';

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

export function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

export function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

export function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

export function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

export function projectRecords(brain: LocalBrain): { id: string; relative_root: string }[] {
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

export function resolveProjectId(brain: LocalBrain, identifier: string | undefined): string | undefined {
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

export function scopeForPath(brain: LocalBrain, path: string): string {
  for (const project of projectRecords(brain)) {
    if (path === project.relative_root || path.startsWith(`${project.relative_root}/`)) {
      return project.id;
    }
  }
  return 'brain';
}

export function sourceRef(
  brain: LocalBrain,
  source: CurrentSource,
  warnings: string[] = []
): SourceRef {
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

export async function reconcileDeps(deps: LocalHandlerDeps): Promise<void> {
  const report = await reconcileCurrentVault({ vault: deps.vault, catalogue: deps.catalogue });
  indexReconciledDocuments({ catalogue: deps.catalogue, index: deps.index, report });
}

export async function reconcileCatalogueDeps(deps: LocalHandlerDeps): Promise<ReconcileCurrentVaultReport> {
  return reconcileCurrentVault({ vault: deps.vault, catalogue: deps.catalogue });
}

export interface RetrievalReconcileReport {
  index_failed: boolean;
  pending_index: number;
}

export async function reconcileRetrievalDeps(deps: LocalHandlerDeps): Promise<RetrievalReconcileReport> {
  const report = await reconcileCurrentVault({ vault: deps.vault, catalogue: deps.catalogue });
  let indexFailed = false;
  try {
    indexReconciledDocuments({ catalogue: deps.catalogue, index: deps.index, report });
  } catch {
    indexFailed = true;
  }
  let pending = 0;
  try {
    pending = deps.documents.pendingIndexCount();
  } catch {
    pending = 0;
  }
  return { index_failed: indexFailed, pending_index: pending };
}

export function scopeForPathDeps(deps: LocalHandlerDeps, path: string): string {
  for (const project of deps.projects.list()) {
    if (path === project.relative_root || path.startsWith(`${project.relative_root}/`)) {
      return project.id;
    }
  }
  return 'brain';
}

export function sourceRefForDeps(
  deps: LocalHandlerDeps,
  source: CurrentSource,
  warnings: string[] = []
): SourceRef {
  return {
    id: source.id ?? source.path,
    revision_id: source.revision_id ?? source.hash,
    scope: scopeForPathDeps(deps, source.path),
    title: source.title,
    kind: contentKindForType(source.type),
    status: source.status,
    etag: source.etag,
    relative_path: source.path,
    warnings
  };
}

export function sourceRefManaged(
  deps: LocalHandlerDeps,
  source: CurrentSource,
  warnings: string[] = []
): SourceRef {
  return sourceRefForDeps(deps, source, warnings);
}

export function validateRelatedIdsLocal(
  relatedIds: readonly string[],
  deps: LocalHandlerDeps
): void {
  const targets = [...new Set(relatedIds)];
  if (targets.length === 0) return;
  const known = new Set(
    deps.catalogue
      .all()
      .map((source) => source.id)
      .filter((id): id is string => id !== undefined)
  );
  for (const target of targets) {
    if (!known.has(target)) throw invalidInput(`related note ${target} does not exist`);
  }
}

export function mutationReceipt(
  result: LocalOperationReceipt,
  warnings: string[] = []
): MutationReceipt {
  if (result.kind !== 'note') {
    throw invalidInput('a note mutation produced a non-note receipt');
  }
  return {
    operation_id: result.operation_id,
    id: result.id,
    revision_id: result.revision_id,
    outcome: 'stored',
    materialized: true,
    indexed: result.indexed,
    etag: result.etag,
    possible_duplicates: result.possible_duplicates ?? [],
    warnings: [...result.warnings, ...warnings]
  };
}

export async function reconcile(brain: LocalBrain): Promise<void> {
  const report = await reconcileCurrentVault({ vault: brain.vault, catalogue: brain.catalogue });
  indexReconciledDocuments({ catalogue: brain.catalogue, index: brain.index, report });
}

export function currentByReferenceDeps(
  deps: LocalHandlerDeps,
  reference: { id?: string; path?: string; title?: string }
): CurrentSource {
  const all = deps.catalogue.all();
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

export function currentByReference(
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

function resolvedProject(brain: LocalBrain, id: string): ResolvedProject | undefined {
  const persisted = brain.journal.getProjectById(id);
  if (persisted !== undefined) {
    return {
      id: persisted.project.id,
      display_name: persisted.project.display_name,
      relative_root: persisted.project.relative_root,
      state: persisted.state,
      ...(persisted.project.repository_identity === undefined
        ? {}
        : { repository_identity: persisted.project.repository_identity })
    };
  }
  const scope = brain.config.scopes.find((candidate) => candidate.id === id);
  if (scope === undefined) return undefined;
  return {
    id: scope.id,
    display_name: scope.id,
    relative_root: scope.relative_root,
    state: 'ready'
  };
}

function projectPort(brain: LocalBrain): ProjectResolutionPort {
  return {
    resolve: (identifier) => {
      const id = resolveProjectId(brain, identifier);
      return id === undefined ? undefined : resolvedProject(brain, id);
    },
    canonicalId: (identifier) => {
      try {
        return resolveProjectId(brain, identifier);
      } catch {
        return undefined;
      }
    },
    list: () => projectRecords(brain).flatMap((project) => {
      const resolved = resolvedProject(brain, project.id);
      return resolved === undefined ? [] : [resolved];
    })
  };
}

const MIN_CURSOR_SECRET_BYTES = 32;

function cursorPort(brain: LocalBrain): SourceBoundCursorPort {
  let secret: Uint8Array | undefined;
  const secretOf = (): Uint8Array => {
    if (secret !== undefined) return secret;
    const path = brain.config.cursor_secret_file;
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
    if (bytes.length < MIN_CURSOR_SECRET_BYTES) {
      throw recoveryRequired(
        `the read-cursor signing secret must be at least ${MIN_CURSOR_SECRET_BYTES} bytes`
      );
    }
    secret = new Uint8Array(bytes);
    return secret;
  };
  const payloadFor = (
    scope: SourceCursorScope,
    offset: number,
    expires_at: string
  ): CursorPayloadV2 => ({
    version: 2,
    scope: scopeForPath(brain, scope.path),
    id: scope.id,
    revision_id: scope.revision_id,
    raw_hash: scope.etag,
    offset,
    expires_at
  });
  return {
    issue: (input) => {
      const payload = payloadFor(input, input.offset, input.expires_at);
      const reservation = reserveStoredCursorV2(payload, secretOf(), brain.journal);
      return finalizeStoredCursorV2(reservation, payload, brain.journal);
    },
    verify: (cursor, scope) => {
      const payload = verifyStoredCursorV2(cursor, secretOf(), brain.clock.now(), brain.journal);
      if (payload.id !== scope.id) {
        throw invalidInput('the read cursor does not belong to the requested note');
      }
      return {
        offset: payload.offset,
        id: payload.id,
        revision_id: payload.revision_id,
        raw_hash: payload.raw_hash
      };
    }
  };
}

export interface LocalHandlerOverrides {
  operations?: LocalOperationJournal;
  revisions?: RevisionStore;
  mutations?: LocalHandlerDeps['mutations'];
}

function unavailableLocalMutations(): LocalMutationCoordinatorPort {
  const unavailable = (): never => {
    throw recoveryRequired('the local operation journal is not configured');
  };
  return {
    pending: (): LocalPendingOperation[] => [],
    pendingAffected: (): LocalPendingAffected => ({ ids: [], paths: [] }),
    run: () => Promise.resolve().then(unavailable),
    runLazy: () => Promise.resolve().then(unavailable),
    status: () => undefined,
    recover: () => Promise.resolve().then(unavailable),
    enumerateConflictHeads: () => Promise.resolve().then(unavailable),
    verifyConflictHeads: () => Promise.resolve().then(unavailable),
    selectSurvivorPath: () => Promise.resolve().then(unavailable),
    latestGeneratedNote: () => undefined,
    runWithSharedKey: () => Promise.resolve().then(unavailable)
  };
}

const sharedLocalDeps = new WeakMap<LocalBrain, Promise<LocalHandlerDeps>>();

export async function buildLocalHandlerDeps(
  brain: LocalBrain,
  overrides: LocalHandlerOverrides = {}
): Promise<LocalHandlerDeps> {
  if (Object.keys(overrides).length === 0) {
    const cached = sharedLocalDeps.get(brain);
    if (cached !== undefined) return cached;
    const pending = buildLocalHandlerDeps(brain, { operations: brain.operations });
    sharedLocalDeps.set(brain, pending);
    try { return await pending; }
    catch (error) { sharedLocalDeps.delete(brain); throw error; }
  }
  const operations = overrides.operations ?? brain.operations;
  const revisions =
    overrides.revisions ??
    (operations === undefined ? undefined : await openRevisionStore(brain.config.mounts.state));
  const mutations =
    overrides.mutations ??
    (operations === undefined
      ? unavailableLocalMutations()
      : new LocalMutationCoordinator({
      operations,
      documents: brain.documents,
      catalogue: brain.catalogue,
      vaultRoot: brain.vaultRoot,
      clock: brain.clock,
      ids: brain.ids,
      revisions,
      foreignKeys: { has: (key) => brain.journal.idempotencyKeyProject(key) !== undefined },
      projects: {
        getProjectByIdentity: (identity) => brain.journal.getProjectByIdentity(identity),
        reserveProject: (input) => brain.journal.reserveProject(input),
        markProjectReady: (id) => brain.journal.markProjectReady(id)
      }
      }));
  return {
    config: brain.config,
    documents: brain.documents,
    catalogue: brain.catalogue,
    index: brain.index,
    journal: brain.journal,
    vault: brain.vault,
    vaultRoot: brain.vaultRoot,
    clock: brain.clock,
    ids: brain.ids,
    mutations,
    projects: projectPort(brain),
    cursors: cursorPort(brain),
    ...(brain.worker === undefined ? {} : { worker: brain.worker })
  };
}
