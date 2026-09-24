import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { MATERIALIZATION_TIMEOUT_MS } from './limits.js';
import type {
  BackendPort,
  CataloguePort,
  Clock,
  Head,
  IdSource,
  LegacyProjectBackendBinding,
  MutationReceipt,
  PersistedProject,
  ProjectEnsureResult,
  ProjectProvisioningPlan,
  PlannedWrite,
  AuthenticatedContext,
  ScopeConfig,
  SourceRef,
  StoredRevision,
  VaultPort
} from './types.js';
import type { BrainConfig } from '../config/schema.js';
import { decodeRevision, encodeRevision, makeEtag, payloadHash } from '../notes/codec.js';
import { slugify } from '../notes/identity.js';
import type { ScopeRegistry } from '../projects/scope-registry.js';
import type {
  Journal,
  OperationRecord,
  OperationReservation,
  OperationState,
  ProjectReservation,
  ProjectReservationResult,
  ReceiptAvailability,
  ReservationResult
} from '../storage/journal.js';
import { recoverProjectOperation } from '../features/project-ensure.js';
import type {
  DocumentStorePutInput,
  DocumentStorePutResult,
  DocumentStoreReadResult,
  DocumentStoreRevisionRead,
  DocumentStoreConsolidateInput,
  DocumentStoreConsolidationHead,
  DocumentStoreReferenceEdit,
  DocumentStoreRemoval
} from '../storage/document-store.js';
import type { LocalOperationJournal, LocalOperationRecord } from '../storage/journal.js';
import type { RevisionStore } from '../storage/revision-store.js';
import { scanVaultFilePaths } from '../storage/vault.js';
import { parseDocument } from '../notes/document-codec.js';
import { collectRenameSnapshots, planRename, type RenamePlan, type RenameReceipt } from '../notes/rename.js';
import { allocateNotePath, safeBasename } from '../notes/paths.js';
import type {
  CaptureRequest,
  LocalAllocatedIdentity,
  LocalConflictHead,
  LocalDocumentEffect,
  LocalExpectedHead,
  LocalMutationCoordinatorPort,
  LocalObservedSource,
  LocalObservedState,
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt,
  LocalOperationStatus,
  LocalPendingWrite,
  LocalPlannedOperation,
  LocalReadCondition,
  LocalReadSet,
  LocalRecoveryReport,
  NoteInput
} from './types.js';

const POLL_INTERVAL_MS = 20;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
const UNCERTAIN_WRITE_CODES = ['BACKEND_UNAVAILABLE', 'EMBEDDINGS_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR'] as const;
const REVISION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExpectedHead {
  id: string;
  revision_id?: string;
  etag: string;
}

export interface MutationAdvisory {
  warnings?: string[];
  possible_duplicates?: SourceRef[];
}

export interface MutationIntent {
  tool: string;
  scope: string;
  idempotency_key: string;
  payload: unknown;
  expected_heads: ExpectedHead[];
  advisory?: MutationAdvisory;
  resolve_heads?: (scope: ScopeConfig) => Promise<Head[]>;
}

export interface AllocatedIdentity {
  operation_id: string;
  note_id: string;
  revision_id: string;
  timestamp: string;
}

export type RevisionBuilder = (
  identities: AllocatedIdentity,
  heads: Head[]
) => StoredRevision | Promise<StoredRevision>;

export interface MutationJournal {
  reserve(input: OperationReservation): ReservationResult;
  savePlan(id: string, plan: PlannedWrite): void;
  saveProjectPlan(id: string, plan: ProjectProvisioningPlan): void;
  mark(id: string, state: OperationState, receipt?: MutationReceipt | ProjectEnsureResult): void;
  get(id: string): OperationRecord | undefined;
  pending(): OperationRecord[];
  abort(id: string): void;
  refreshReceiptAvailability(id: string, availability: ReceiptAvailability): OperationRecord;
  reserveProject(input: ProjectReservation): ProjectReservationResult;
  getProjectById(id: string): PersistedProject | undefined;
  getProjectByIdentity(repositoryIdentity: string): PersistedProject | undefined;
  getProjectByLegacyScope(legacyScope: string): PersistedProject | undefined;
  getProjectBinding(projectId: string): LegacyProjectBackendBinding | undefined;
  listProjectBindings(): { project_id: string; binding: LegacyProjectBackendBinding }[];
  countProjects(): number;
  markProjectReady(identifier: string): PersistedProject;
  markProjectRecoveryRequired(identifier: string, stage: string, code: string): PersistedProject;
  resolveLegacyKeys(): void;
  isKeyBlocked(idempotency_key: string): boolean;
}

export interface BrainDeps {
  config: BrainConfig;
  scopeRegistry: ScopeRegistry;
  backend: BackendPort;
  vault: VaultPort;
  catalogue: CataloguePort;
  journal: Journal;
  clock: Clock;
  ids: IdSource;
  mutations: MutationCoordinator;
}

export type RecoveryOutcome = 'finalized' | 'conflicted' | 'failed' | 'released' | 'pending';

export interface RecoveryOperationReport {
  operation_id: string;
  scope: string;
  tool: string;
  previous_state: OperationState;
  state: OperationState;
  outcome: RecoveryOutcome;
  blocking: boolean;
  warnings: string[];
  reason?: string;
  receipt?: MutationReceipt;
}

export interface RecoveryReport {
  inspected: number;
  finalized: number;
  conflicted: number;
  failed: number;
  released: number;
  pending: number;
  blocking_operations: string[];
  operations: RecoveryOperationReport[];
  scopes: string[];
}

export interface MutationDeps {
  config: BrainConfig;
  scopeRegistry: ScopeRegistry;
  backend: BackendPort;
  vault: VaultPort;
  catalogue: CataloguePort;
  journal: MutationJournal;
  clock: Clock;
  ids: IdSource;
  localStore?: LocalStoreAdapter;
}

export interface LocalStoreAdapter {
  put(input: DocumentStorePutInput): Promise<DocumentStorePutResult>;
  readPath(path: string): Promise<DocumentStoreReadResult>;
  readRevision(id: string, revisionId: string): Promise<DocumentStoreRevisionRead>;
}

export function localStoreAdapter(store: LocalStoreAdapter): LocalStoreAdapter {
  return store;
}

interface LocatedMaterialization {
  raw: string;
  raw_hash: string;
  relative_path: string;
  revision: StoredRevision;
}

type Inspection =
  | { kind: 'match'; match: LocatedMaterialization }
  | { kind: 'absent' }
  | { kind: 'undecodable' }
  | { kind: 'error'; reason: string };

type ScanOutcome =
  | { kind: 'conclusive'; matches: LocatedMaterialization[] }
  | { kind: 'inconclusive'; reason: string };

type MaterializationWait =
  | { kind: 'matched'; matches: LocatedMaterialization[] }
  | { kind: 'absent' }
  | { kind: 'inconclusive' };

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function cancelled(operation_id?: string): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the mutation', operation_id });
}

function conflict(message: string, operation_id: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message, operation_id });
}

function recoveryRequired(message: string, operation_id?: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, operation_id, cause });
}

function hasErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalize(source[key]);
    return ordered;
  }
  return value;
}

function deriveUuid(namespace: string): string {
  const digest = createHash('sha256').update(namespace, 'utf8').digest('hex');
  const chars = digest.slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function payloadDigest(payload: unknown): { payload_hash: string; payload_json: string } {
  let json: string;
  try {
    json = JSON.stringify(canonicalize(payload));
  } catch (cause) {
    throw invalidInput('mutation payload is not serializable', cause);
  }
  if (json === undefined) throw invalidInput('mutation payload is not serializable');
  return {
    payload_hash: createHash('sha256').update(json, 'utf8').digest('hex'),
    payload_json: json
  };
}

function normalizeAdvisory(advisory: MutationAdvisory | undefined): MutationAdvisory | undefined {
  if (advisory === undefined || advisory === null) return undefined;
  const warnings =
    advisory.warnings === undefined
      ? undefined
      : advisory.warnings.filter((warning): warning is string => typeof warning === 'string');
  const duplicates =
    advisory.possible_duplicates === undefined
      ? undefined
      : advisory.possible_duplicates.filter(
          (entry): entry is SourceRef => entry !== null && typeof entry === 'object'
        );
  if (warnings === undefined && duplicates === undefined) return undefined;
  return {
    ...(warnings === undefined ? {} : { warnings }),
    ...(duplicates === undefined ? {} : { possible_duplicates: duplicates })
  };
}

function parseAdvisory(value: unknown): MutationAdvisory | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return normalizeAdvisory(value as MutationAdvisory);
}

function storedPayloadJson(coreJson: string, advisory: MutationAdvisory | undefined): string {
  let payload: unknown;
  try {
    payload = JSON.parse(coreJson);
  } catch (cause) {
    throw invalidInput('mutation payload is not serializable', cause);
  }
  return JSON.stringify({ payload, advisory: advisory ?? null });
}

function advisoryFromRecord(record: OperationRecord): MutationAdvisory | undefined {
  if (record.payload_json === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.payload_json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parseAdvisory((parsed as { advisory?: unknown }).advisory);
}

function applyAdvisory(
  receipt: MutationReceipt,
  advisory: MutationAdvisory | undefined
): MutationReceipt {
  if (advisory === undefined) return receipt;
  const warnings = [...receipt.warnings];
  for (const warning of advisory.warnings ?? []) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return {
    ...receipt,
    warnings,
    possible_duplicates: advisory.possible_duplicates ?? receipt.possible_duplicates
  };
}

function isUncertainWrite(error: unknown): boolean {
  if (!isBrainError(error)) return false;
  return (UNCERTAIN_WRITE_CODES as readonly string[]).includes(error.code);
}

function sameParents(left: StoredRevision['parents'], right: StoredRevision['parents']): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (parent, index) =>
      parent.revision_id === right[index].revision_id && parent.raw_hash === right[index].raw_hash
  );
}

function sameApproval(
  left: StoredRevision['approval'],
  right: StoredRevision['approval']
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.principal_id === right.principal_id &&
    left.rationale === right.rationale &&
    left.payload_hash === right.payload_hash
  );
}

function matchesPlan(actual: StoredRevision, expected: StoredRevision): boolean {
  return (
    actual.id === expected.id &&
    actual.revision_id === expected.revision_id &&
    actual.operation_id === expected.operation_id &&
    actual.scope === expected.scope &&
    actual.status === expected.status &&
    actual.replacement_id === expected.replacement_id &&
    sameParents(actual.parents, expected.parents) &&
    sameApproval(actual.approval, expected.approval) &&
    payloadHash(actual) === payloadHash(expected)
  );
}

function parseReceipt(json: string, operation_id: string): MutationReceipt {
  try {
    return JSON.parse(json) as MutationReceipt;
  } catch (cause) {
    throw recoveryRequired(`operation ${operation_id} has an unreadable receipt`, operation_id, cause);
  }
}

function pendingReceipt(
  operation_id: string,
  plan: PlannedWrite,
  advisory: MutationAdvisory | undefined
): MutationReceipt {
  return applyAdvisory(
    {
      operation_id,
      id: plan.revision.id,
      revision_id: plan.revision.revision_id,
      outcome: 'pending',
      materialized: false,
      indexed: false,
      possible_duplicates: [],
      warnings: ['materialization_unconfirmed']
    },
    advisory
  );
}

function expectedRelativePath(scope: ScopeConfig, plan: PlannedWrite): string {
  const segments = [
    ...scope.relative_root.split('/'),
    ...plan.directory.split('/'),
    `${slugify(plan.storage_title)}.md`
  ];
  return segments.filter((segment) => segment.length > 0).join('/');
}

export class InstanceLock {
  private readonly lockPath: string;
  private readonly owner: string;
  private released = false;

  private constructor(lockPath: string, owner: string) {
    this.lockPath = lockPath;
    this.owner = owner;
  }

  static acquire(stateDir: string, name = 'gateway.lock'): InstanceLock {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        const owner = `${JSON.stringify({ pid: process.pid, start_time: InstanceLock.processStartTime(process.pid) })}\n`;
        try {
          writeSync(fd, owner);
        } finally {
          closeSync(fd);
        }
        return new InstanceLock(lockPath, owner);
      } catch (error) {
        if (!hasErrno(error, 'EEXIST')) {
          throw recoveryRequired(`instance lock ${lockPath} cannot be created`, undefined, error);
        }
        if (attempt === 0 && InstanceLock.clearIfStale(lockPath)) continue;
        throw new BrainError({
          code: 'CONFLICT',
          message: `another gateway instance already holds ${lockPath}`
        });
      }
    }
    throw new BrainError({
      code: 'CONFLICT',
      message: `another gateway instance already holds ${lockPath}`
    });
  }

  private static clearIfStale(lockPath: string): boolean {
    const claimPath = `${lockPath}.recovery`;
    try {
      mkdirSync(claimPath, { mode: 0o700 });
    } catch {
      return false;
    }
    try {
      return InstanceLock.clearClaimedStale(lockPath);
    } finally {
      rmdirSync(claimPath);
    }
  }

  private static clearClaimedStale(lockPath: string): boolean {
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch {
      return false;
    }
    let pid: number;
    let recordedStart: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; start_time?: unknown };
      pid = typeof parsed.pid === 'number' ? parsed.pid : Number.NaN;
      recordedStart = typeof parsed.start_time === 'string' ? parsed.start_time : undefined;
    } catch {
      pid = Number.parseInt(raw.trim(), 10);
    }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const currentStart = InstanceLock.processStartTime(pid);
    const stale =
      currentStart === undefined ||
      (recordedStart !== undefined && recordedStart !== currentStart) ||
      (recordedStart === undefined && pid === process.pid);
    if (stale) {
      try {
        if (readFileSync(lockPath, 'utf8') !== raw) return false;
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (!hasErrno(error, 'ESRCH')) return false;
      try {
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  private static processStartTime(pid: number): string | undefined {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return undefined;
    }
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    const startTime = fields[19];
    return typeof startTime === 'string' && /^\d+$/u.test(startTime) ? startTime : undefined;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (readFileSync(this.lockPath, 'utf8') !== this.owner) return;
      unlinkSync(this.lockPath);
    } catch {
      return;
    }
  }
}

export class MutationCoordinator {
  private readonly deps: MutationDeps;
  private tail: Promise<unknown> = Promise.resolve();
  private recoveryBlockers = new Set<string>();

  constructor(deps: MutationDeps) {
    this.deps = deps;
  }

  async commit(
    ctx: AuthenticatedContext,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    return this.withLock(() => this.commitSerialized(ctx, intent, build));
  }

  async recover(): Promise<void> {
    await this.recoverDetailed();
  }

  setRecoveryBlockers(ids: readonly string[]): void {
    this.recoveryBlockers = new Set(ids);
  }

  hasRecoveryBlockers(): boolean {
    return this.recoveryBlockers.size > 0;
  }

  private blocksScope(scope: string): boolean {
    for (const operationId of this.recoveryBlockers) {
      const record = this.deps.journal.get(operationId);
      if (record === undefined || record.tool !== 'brain_project_ensure' || record.scope === scope) {
        return true;
      }
    }
    return false;
  }

  async recoverDetailed(): Promise<RecoveryReport> {
    return this.withLock(async () => {
      this.deps.journal.resolveLegacyKeys();
      const operations: RecoveryOperationReport[] = [];
      for (const record of this.deps.journal.pending()) {
        if (this.deps.journal.isKeyBlocked(record.idempotency_key)) {
          operations.push(
            this.operationReport(record, {
              outcome: 'conflicted',
              reason: 'idempotency_key_ambiguous',
              blocking: true,
              warnings: ['idempotency_key_ambiguous']
            })
          );
          continue;
        }
        let operation: RecoveryOperationReport;
        try {
          operation =
            record.tool === 'brain_project_ensure'
              ? await recoverProjectOperation(record, this.deps)
              : await this.recoverOne(record);
        } catch {
          operation = this.failDefinitively(record, 'recovery_error');
        }
        operations.push(operation);
      }
      const blocking = operations
        .filter((operation) => operation.blocking)
        .map((operation) => operation.operation_id);
      this.recoveryBlockers = new Set(blocking);
      const count = (outcome: RecoveryOutcome): number =>
        operations.filter((operation) => operation.outcome === outcome).length;
      return {
        inspected: operations.length,
        finalized: count('finalized'),
        conflicted: count('conflicted'),
        failed: count('failed'),
        released: count('released'),
        pending: count('pending'),
        blocking_operations: blocking,
        operations,
        scopes: this.deps.scopeRegistry.all().map((scope) => scope.id)
      };
    });
  }

  async serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.withLock(work);
  }

  async localWrite(
    ctx: AuthenticatedContext,
    input: DocumentStorePutInput
  ): Promise<DocumentStorePutResult> {
    const adapter = this.deps.localStore;
    if (adapter === undefined) {
      throw recoveryRequired('no local document store is configured');
    }
    if (ctx.signal.aborted) throw cancelled();
    return this.serialize(() => adapter.put(input));
  }

  private preconditionsValidated(record: LocalOperationRecord): boolean {
    if (record.progress_json === null) return false;
    try {
      const parsed = JSON.parse(record.progress_json) as { preconditions_validated?: unknown };
      return parsed.preconditions_validated === true;
    } catch {
      return false;
    }
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async commitSerialized(
    ctx: AuthenticatedContext,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    const scope = this.resolveProject(intent.scope);
    if (ctx.signal.aborted) throw cancelled();
    const digest = payloadDigest(intent.payload);
    const advisory = normalizeAdvisory(intent.advisory);
    const reservation: OperationReservation = {
      principal_id: ctx.actor.id,
      idempotency_key: intent.idempotency_key,
      tool: intent.tool,
      scope: scope.id,
      payload_hash: digest.payload_hash,
      payload_json: storedPayloadJson(digest.payload_json, advisory)
    };
    const reserved = this.deps.journal.reserve(reservation);
    if (reserved.kind === 'new' && this.blocksScope(scope.id)) {
      try {
        this.deps.journal.abort(reserved.record.operation_id);
      } catch {
        this.recoveryBlockers.delete(reserved.record.operation_id);
      }
      throw recoveryRequired(
        'an unresolved write requires recovery before new mutations are accepted',
        reserved.record.operation_id
      );
    }
    return this.drive(ctx, scope, reserved, intent, build);
  }

  private resolveProject(identifier: string): ScopeConfig {
    const scope = this.deps.scopeRegistry.get(identifier);
    if (scope === undefined) {
      throw new BrainError({
        code: 'NOT_FOUND',
        message: `project ${identifier} is not configured`
      });
    }
    if (!this.deps.scopeRegistry.isUsable(scope.id)) {
      throw recoveryRequired(`project ${scope.id} requires recovery before it can be used`);
    }
    return scope;
  }

  private async drive(
    ctx: AuthenticatedContext,
    scope: ScopeConfig,
    reserved: ReservationResult,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    const { record } = reserved;
    const advisory =
      reserved.kind === 'new' ? normalizeAdvisory(intent.advisory) : advisoryFromRecord(record);
    if (reserved.kind === 'replay') {
      if (record.receipt_json && (record.state === 'complete' || record.state === 'conflict')) {
        return applyAdvisory(
          await this.refreshTerminalReceipt(scope, parseReceipt(record.receipt_json, record.operation_id)),
          advisory
        );
      }
      if (record.state === 'conflict') {
        throw conflict('operation ended in conflict', record.operation_id);
      }
      if (record.state === 'failed') {
        throw conflict('operation failed definitively', record.operation_id);
      }
    }

    const persisted = this.loadPlan(record);
    if (persisted !== undefined) {
      if (persisted.revision.scope !== scope.id) {
        throw recoveryRequired('persisted plan does not match the authorized scope', record.operation_id);
      }
      if (record.state === 'submitted') {
        const wait = await this.awaitMaterialization(scope, persisted);
        if (wait.kind === 'matched') {
          return this.finalize(scope, persisted, wait.matches, record.operation_id, advisory);
        }
        return this.pending(record.operation_id, persisted, advisory);
      }
      if (record.state === 'materialized') {
        const wait = await this.awaitMaterialization(scope, persisted);
        if (wait.kind === 'matched') {
          return this.finalize(scope, persisted, wait.matches, record.operation_id, advisory);
        }
        if (wait.kind === 'absent') {
          this.markConflict(record.operation_id);
          throw conflict('operation was marked materialized but its file is absent', record.operation_id);
        }
        return this.pending(record.operation_id, persisted, advisory);
      }
      if (record.state !== 'prepared') {
        throw recoveryRequired(`operation is stuck in state ${record.state}`, record.operation_id);
      }
    }

    await this.deps.catalogue.reconcile(scope.id);
    let heads: Head[];
    try {
      heads =
        intent.resolve_heads !== undefined
          ? await intent.resolve_heads(scope)
          : await this.verifyExpectedHeads(scope, intent.expected_heads, record.operation_id);
    } catch (error) {
      this.abortPrepared(record.operation_id);
      throw error;
    }

    let plan = persisted;
    if (plan === undefined) {
      const identities = this.deriveIdentity(record, heads);
      let revision: StoredRevision;
      try {
        revision = await this.buildRevision(build, identities, heads, scope);
      } catch (error) {
        this.abortPrepared(record.operation_id);
        throw error;
      }
      plan = encodeRevision(revision, scope);
      this.deps.journal.savePlan(record.operation_id, plan);
    }

    if (ctx.signal.aborted) return this.pending(record.operation_id, plan, advisory);
    this.deps.journal.mark(record.operation_id, 'submitted', pendingReceipt(record.operation_id, plan, advisory));
    return this.submit(ctx, scope, plan, record.operation_id, advisory);
  }

  private abortPrepared(operation_id: string): void {
    try {
      const record = this.deps.journal.get(operation_id);
      if (record === undefined || record.state !== 'prepared') return;
      this.deps.journal.abort(operation_id);
    } catch {
      return;
    }
  }

  private deriveIdentity(record: OperationRecord, heads: Head[]): AllocatedIdentity {
    const targets = [...new Set(heads.map((head) => head.revision.id))];
    if (targets.length > 1) {
      throw invalidInput('a mutation may target only one logical note');
    }
    const namespace = `${record.operation_id}:${record.tool}:${record.scope}`;
    const noteId = targets[0] ?? deriveUuid(`${namespace}:note`);
    return {
      operation_id: record.operation_id,
      note_id: noteId,
      revision_id: deriveUuid(`${namespace}:revision:${noteId}`),
      timestamp: record.created_at
    };
  }

  private async buildRevision(
    build: RevisionBuilder,
    identities: AllocatedIdentity,
    heads: Head[],
    scope: ScopeConfig
  ): Promise<StoredRevision> {
    let revision: StoredRevision;
    try {
      revision = await build(identities, heads);
    } catch (error) {
      if (isBrainError(error)) throw error;
      throw invalidInput('revision builder failed', error);
    }
    if (revision === undefined || revision === null || typeof revision !== 'object') {
      throw invalidInput('revision builder returned no revision');
    }
    if (revision.operation_id !== identities.operation_id) {
      throw invalidInput('revision operation_id does not match the reserved operation');
    }
    if (revision.revision_id !== identities.revision_id) {
      throw invalidInput('revision_id does not match the allocated identity');
    }
    if (revision.id !== identities.note_id) {
      throw invalidInput('note id does not match the allocated identity');
    }
    if (revision.scope !== scope.id) {
      throw invalidInput('revision scope does not match the authorized scope');
    }
    return revision;
  }

  private async verifyExpectedHeads(
    scope: ScopeConfig,
    expected: ExpectedHead[],
    operation_id: string
  ): Promise<Head[]> {
    const heads: Head[] = [];
    for (const item of expected) {
      let head: Head;
      try {
        head =
          item.revision_id !== undefined
            ? await this.deps.catalogue.getRevision(scope.id, item.id, item.revision_id)
            : await this.deps.catalogue.get(scope.id, item.id);
      } catch (error) {
        if (isBrainError(error) && error.code === 'NOT_FOUND') {
          this.markConflict(operation_id);
          throw conflict(`expected head ${item.id} is missing`, operation_id);
        }
        if (isBrainError(error) && error.code === 'CONFLICT') {
          this.markConflict(operation_id);
          throw conflict(`expected head ${item.id} is conflicted`, operation_id);
        }
        throw error;
      }
      if (head.state === 'malformed' || head.source.etag !== item.etag) {
        this.markConflict(operation_id);
        throw conflict(`expected head ${item.id} no longer matches etag ${item.etag}`, operation_id);
      }
      heads.push(head);
    }
    return heads;
  }

  private async submit(
    ctx: AuthenticatedContext,
    scope: ScopeConfig,
    plan: PlannedWrite,
    operation_id: string,
    advisory: MutationAdvisory | undefined
  ): Promise<MutationReceipt> {
    if (ctx.signal.aborted) return this.pending(operation_id, plan, advisory);
    try {
      await this.deps.backend.create(plan);
    } catch (error) {
      if (isBrainError(error) && error.code === 'CONFLICT') {
        const scan = await this.scanMaterializations(scope, plan);
        if (scan.kind === 'inconclusive') return this.pending(operation_id, plan, advisory);
        if (scan.matches.length > 0) return this.finalize(scope, plan, scan.matches, operation_id, advisory);
        this.markConflict(operation_id);
        throw conflict('backend rejected a create that had no materialised file', operation_id);
      }
      if (!isUncertainWrite(error)) throw error;
      const wait = await this.awaitMaterialization(scope, plan);
      if (wait.kind === 'matched') return this.finalize(scope, plan, wait.matches, operation_id, advisory);
      return this.pending(operation_id, plan, advisory);
    }
    const wait = await this.awaitMaterialization(scope, plan);
    if (wait.kind === 'matched') return this.finalize(scope, plan, wait.matches, operation_id, advisory);
    return this.pending(operation_id, plan, advisory);
  }

  private async awaitMaterialization(
    scope: ScopeConfig,
    plan: PlannedWrite
  ): Promise<MaterializationWait> {
    const timeout = this.deps.config.limits.materialization_timeout_ms ?? MATERIALIZATION_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    let conclusiveZero = false;
    for (;;) {
      const scan = await this.scanMaterializations(scope, plan);
      if (scan.kind === 'conclusive') {
        if (scan.matches.length > 0) return { kind: 'matched', matches: scan.matches };
        conclusiveZero = true;
      } else {
        conclusiveZero = false;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return conclusiveZero ? { kind: 'absent' } : { kind: 'inconclusive' };
      await delay(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  private async scanMaterializations(
    scope: ScopeConfig,
    plan: PlannedWrite
  ): Promise<ScanOutcome> {
    const found = new Map<string, LocatedMaterialization>();
    const expected = expectedRelativePath(scope, plan);

    const direct = await this.inspect(scope, expected, plan);
    if (direct.kind === 'error') return { kind: 'inconclusive', reason: direct.reason };
    if (direct.kind === 'undecodable') {
      return { kind: 'inconclusive', reason: 'undecodable_materialization' };
    }
    if (direct.kind === 'match') found.set(direct.match.relative_path, direct.match);
    const expectedResolved = direct.kind === 'match';

    let paths: string[];
    try {
      paths = await this.deps.vault.list(scope.id);
    } catch (error) {
      return {
        kind: 'inconclusive',
        reason: isBrainError(error) ? `vault_list_${error.code}` : 'vault_list_failed'
      };
    }
    for (const path of paths) {
      if (path === expected && expectedResolved) continue;
      const inspected = await this.inspect(scope, path, plan);
      if (inspected.kind === 'error') return { kind: 'inconclusive', reason: inspected.reason };
      if (inspected.kind === 'match') found.set(inspected.match.relative_path, inspected.match);
    }
    return { kind: 'conclusive', matches: [...found.values()] };
  }

  private async inspect(
    scope: ScopeConfig,
    relativePath: string,
    plan: PlannedWrite
  ): Promise<Inspection> {
    let read: { raw: string; raw_hash: string; relative_path: string };
    try {
      read = await this.deps.vault.read(scope.id, relativePath);
    } catch (error) {
      if (isBrainError(error) && error.code === 'NOT_FOUND') return { kind: 'absent' };
      return { kind: 'error', reason: isBrainError(error) ? `vault_read_${error.code}` : 'vault_read_failed' };
    }
    let revision: StoredRevision;
    try {
      revision = decodeRevision(read.raw);
    } catch {
      return { kind: 'undecodable' };
    }
    if (revision.revision_id !== plan.revision.revision_id) return { kind: 'absent' };
    return {
      kind: 'match',
      match: {
        raw: read.raw,
        raw_hash: read.raw_hash,
        relative_path: read.relative_path,
        revision
      }
    };
  }

  private async finalize(
    scope: ScopeConfig,
    plan: PlannedWrite,
    matches: LocatedMaterialization[],
    operation_id: string,
    advisory: MutationAdvisory | undefined
  ): Promise<MutationReceipt> {
    const record = this.deps.journal.get(operation_id);
    if (record === undefined) {
      throw recoveryRequired('operation disappeared during materialization', operation_id);
    }
    if (record.state === 'submitted') {
      this.deps.journal.mark(operation_id, 'materialized');
    }

    await this.deps.catalogue.reconcile(scope.id);

    const warnings: string[] = [];
    let conflicted = false;
    const verified = matches.filter((candidate) => matchesPlan(candidate.revision, plan.revision));
    if (matches.length > 1) {
      conflicted = true;
      warnings.push('duplicate_materialization');
    } else if (verified.length !== 1) {
      conflicted = true;
      warnings.push('materialization_mismatch');
    }

    for (const parent of plan.revision.parents) {
      try {
        const parentHead = await this.deps.catalogue.getRevision(
          scope.id,
          plan.revision.id,
          parent.revision_id
        );
        if (parentHead.raw_hash !== parent.raw_hash) {
          conflicted = true;
          warnings.push('parent_changed');
        }
      } catch {
        conflicted = true;
        warnings.push('parent_unreadable');
      }
    }
    try {
      await this.deps.catalogue.get(scope.id, plan.revision.id);
    } catch {
      conflicted = true;
      warnings.push('revision_conflict');
    }

    const confirmed = verified[0] ?? matches[0];
    const indexed = await this.checkIndex(scope, plan.revision.revision_id, warnings);
    const receipt = applyAdvisory(
      {
        operation_id,
        id: plan.revision.id,
        revision_id: plan.revision.revision_id,
        outcome: conflicted ? 'stored_conflict' : 'stored',
        materialized: true,
        indexed,
        etag: makeEtag(plan.revision.revision_id, confirmed.raw_hash),
        possible_duplicates: [],
        warnings
      },
      advisory
    );

    try {
      this.deps.journal.mark(operation_id, conflicted ? 'conflict' : 'complete', receipt);
    } catch {
      const refreshed = this.deps.journal.get(operation_id);
      if (refreshed?.receipt_json !== undefined) {
        const stored = parseReceipt(refreshed.receipt_json, operation_id);
        if (stored.outcome !== 'pending') {
          this.recoveryBlockers.delete(operation_id);
          return applyAdvisory(stored, advisory);
        }
      }
    }
    this.recoveryBlockers.delete(operation_id);
    return receipt;
  }

  private async refreshTerminalReceipt(
    scope: ScopeConfig,
    receipt: MutationReceipt
  ): Promise<MutationReceipt> {
    if (receipt.indexed || !receipt.materialized) return receipt;
    let indexed: boolean;
    try {
      indexed = await this.deps.backend.isIndexed(scope.backend_project, receipt.revision_id);
    } catch {
      return receipt;
    }
    if (!indexed) return receipt;
    try {
      const updated = this.deps.journal.refreshReceiptAvailability(receipt.operation_id, {
        indexed: true
      });
      if (updated.receipt_json !== undefined) {
        return parseReceipt(updated.receipt_json, receipt.operation_id);
      }
    } catch {
      return { ...receipt, indexed: true };
    }
    return { ...receipt, indexed: true };
  }

  private async checkIndex(
    scope: ScopeConfig,
    revisionId: string,
    warnings: string[]
  ): Promise<boolean> {
    try {
      return await this.deps.backend.isIndexed(scope.backend_project, revisionId);
    } catch {
      warnings.push('index_unavailable');
      return false;
    }
  }

  private pending(
    operation_id: string,
    plan: PlannedWrite,
    advisory: MutationAdvisory | undefined
  ): MutationReceipt {
    const record = this.deps.journal.get(operation_id);
    if (record?.receipt_json !== undefined) {
      const stored = parseReceipt(record.receipt_json, operation_id);
      if (stored.outcome === 'pending') return applyAdvisory(stored, advisory);
    }
    return pendingReceipt(operation_id, plan, advisory);
  }

  private markConflict(operation_id: string): void {
    const record = this.deps.journal.get(operation_id);
    if (record === undefined) return;
    if (record.state === 'conflict' || record.state === 'complete' || record.state === 'failed') {
      this.recoveryBlockers.delete(operation_id);
      return;
    }
    this.deps.journal.mark(operation_id, 'conflict');
    this.recoveryBlockers.delete(operation_id);
  }

  private loadPlan(record: OperationRecord): PlannedWrite | undefined {
    if (record.plan_json === undefined) return undefined;
    let plan: unknown;
    try {
      plan = JSON.parse(record.plan_json);
    } catch (cause) {
      throw recoveryRequired(`operation ${record.operation_id} has an unreadable plan`, record.operation_id, cause);
    }
    if (plan === null || typeof plan !== 'object') {
      throw recoveryRequired(`operation ${record.operation_id} has an invalid plan`, record.operation_id);
    }
    const revision = (plan as { revision?: unknown }).revision;
    if (revision === null || typeof revision !== 'object') {
      throw recoveryRequired(`operation ${record.operation_id} has a plan without a revision`, record.operation_id);
    }
    const { id, revision_id, operation_id } = revision as {
      id?: unknown;
      revision_id?: unknown;
      operation_id?: unknown;
    };
    if (typeof id !== 'string' || typeof revision_id !== 'string' || typeof operation_id !== 'string') {
      throw recoveryRequired(`operation ${record.operation_id} has a plan without identities`, record.operation_id);
    }
    return plan as PlannedWrite;
  }

  private async recoverOne(record: OperationRecord): Promise<RecoveryOperationReport> {
    let plan: PlannedWrite | undefined;
    try {
      plan = this.loadPlan(record);
    } catch {
      return this.failDefinitively(record, 'unreadable_plan', ['plan_unreadable']);
    }
    if (plan === undefined) {
      if (record.state === 'prepared') {
        try {
          this.deps.journal.abort(record.operation_id);
          this.recoveryBlockers.delete(record.operation_id);
          return this.operationReport(record, { outcome: 'released', reason: 'no_plan' });
        } catch {
          return this.failDefinitively(record, 'unreleasable_reservation');
        }
      }
      return this.failDefinitively(record, 'missing_plan');
    }
    const scope = this.deps.scopeRegistry.get(record.scope);
    if (scope === undefined) return this.failDefinitively(record, 'unknown_scope');
    if (plan.revision.scope !== scope.id) return this.failDefinitively(record, 'plan_scope_mismatch');

    const scan = await this.scanMaterializations(scope, plan);
    if (scan.kind === 'inconclusive') {
      const blocking = record.state === 'submitted' || record.state === 'materialized';
      return this.operationReport(record, {
        outcome: 'pending',
        reason: 'inconclusive_materialization',
        blocking,
        warnings: ['materialization_inconclusive']
      });
    }
    if (scan.matches.length === 0) {
      if (record.state === 'materialized') {
        this.markConflict(record.operation_id);
        return this.operationReport(record, {
          outcome: 'conflicted',
          reason: 'materialization_absent',
          warnings: ['materialization_absent']
        });
      }
      if (record.state === 'submitted' && this.materializationWindowElapsed(record)) {
        return this.failDefinitively(record, 'materialization_absent', ['materialization_absent']);
      }
      return this.operationReport(record, {
        outcome: 'pending',
        reason: 'not_materialized',
        blocking: record.state === 'submitted',
        warnings: ['materialization_unconfirmed']
      });
    }

    try {
      if (record.state === 'prepared') this.deps.journal.mark(record.operation_id, 'submitted');
      const receipt = await this.finalize(
        scope,
        plan,
        scan.matches,
        record.operation_id,
        advisoryFromRecord(record)
      );
      this.recoveryBlockers.delete(record.operation_id);
      const conflicted = receipt.outcome === 'stored_conflict';
      return this.operationReport(record, {
        outcome: conflicted ? 'conflicted' : 'finalized',
        reason: conflicted ? 'materialization_conflict' : 'materialization_verified',
        receipt,
        warnings: receipt.warnings
      });
    } catch {
      const current = this.deps.journal.get(record.operation_id);
      const state = current?.state ?? record.state;
      if (state === 'conflict' || state === 'complete') {
        this.recoveryBlockers.delete(record.operation_id);
        return this.operationReport(record, {
          outcome: state === 'conflict' ? 'conflicted' : 'finalized',
          reason: 'finalized_on_retry'
        });
      }
      if (state === 'failed') {
        this.recoveryBlockers.delete(record.operation_id);
        return this.operationReport(record, { outcome: 'failed', reason: 'finalize_failed' });
      }
      return this.operationReport(record, {
        outcome: 'pending',
        reason: 'finalize_failed',
        blocking: state === 'submitted' || state === 'materialized',
        warnings: ['finalize_unconfirmed']
      });
    }
  }

  private materializationWindowElapsed(record: OperationRecord): boolean {
    const submittedAt = Date.parse(record.updated_at);
    if (!Number.isFinite(submittedAt)) return false;
    const timeout = this.deps.config.limits.materialization_timeout_ms ?? MATERIALIZATION_TIMEOUT_MS;
    return this.deps.clock.now().getTime() - submittedAt >= timeout;
  }

  private operationReport(
    record: OperationRecord,
    input: {
      outcome: RecoveryOutcome;
      reason?: string;
      blocking?: boolean;
      warnings?: string[];
      receipt?: MutationReceipt;
    }
  ): RecoveryOperationReport {
    let state = record.state;
    try {
      state = this.deps.journal.get(record.operation_id)?.state ?? record.state;
    } catch {
      state = record.state;
    }
    const report: RecoveryOperationReport = {
      operation_id: record.operation_id,
      scope: record.scope,
      tool: record.tool,
      previous_state: record.state,
      state,
      outcome: input.outcome,
      blocking: input.blocking === true,
      warnings: input.warnings ?? []
    };
    if (input.reason !== undefined) report.reason = input.reason;
    if (input.receipt !== undefined) report.receipt = input.receipt;
    return report;
  }

  private confirmedFailed(record: OperationRecord): boolean {
    try {
      return this.deps.journal.get(record.operation_id)?.state === 'failed';
    } catch {
      return false;
    }
  }

  private failDefinitively(
    record: OperationRecord,
    reason: string,
    warnings: string[] = []
  ): RecoveryOperationReport {
    let persistedFailed = false;
    try {
      this.deps.journal.mark(record.operation_id, 'failed');
      persistedFailed = this.confirmedFailed(record);
    } catch {
      persistedFailed = false;
    }
    if (!persistedFailed && this.confirmedFailed(record)) persistedFailed = true;
    if (!persistedFailed) {
      this.recoveryBlockers.add(record.operation_id);
      return this.operationReport(record, {
        outcome: 'pending',
        reason: `${reason}_unconfirmed`,
        blocking: true,
        warnings: [...warnings, 'terminal_transition_failed']
      });
    }
    this.recoveryBlockers.delete(record.operation_id);
    return this.operationReport(record, { outcome: 'failed', reason, warnings });
  }
}

export interface LocalDocumentExecutor {
  put(input: DocumentStorePutInput): Promise<DocumentStorePutResult>;
  readPath(path: string): Promise<DocumentStoreReadResult>;
  readRevision(id: string, revisionId: string): Promise<DocumentStoreRevisionRead>;
  applyRename(plan: RenamePlan): Promise<RenameReceipt>;
  consolidate(input: DocumentStoreConsolidateInput): Promise<DocumentStorePutResult>;
  getConsolidationReceipt(idempotencyKey: string): DocumentStorePutResult | undefined;
  hasConsolidationManifest?(idempotencyKey: string): boolean;
  hasDocumentActivity?(idempotencyKey: string): boolean;
  materializedPath?(id: string, revisionId: string): string | undefined;
  getConsolidationOperationId?(idempotencyKey: string): string | undefined;
  recover?(): Promise<{ recovered: string[]; pending: string[] }>;
  getDocumentReceipt(idempotencyKey: string): DocumentStorePutResult | undefined;
  getMoveReceipt(idempotencyKey: string): RenameReceipt | undefined;
}

export interface LocalObservedCatalogueEntry {
  id?: string;
  path: string;
  hash: string;
  etag: string;
  revision_id?: string;
}

export interface LocalObservedCatalogue {
  all(): readonly LocalObservedCatalogueEntry[];
  conflictsFor?(id: string): readonly LocalObservedCatalogueEntry[];
}

export interface LocalProjectLookup {
  getProjectByIdentity(repositoryIdentity: string):
    | { project: { id: string; relative_root: string }; updated_at: string; state: string; provisioning?: { creation_operation_id: string } }
    | undefined;
  reserveProject?(input: { repository_identity: string; project_id: string; display_name: string; relative_root: string; backend_project: string; backend_relative_root: string; created_by_actor_id: string; creation_operation_id: string }): unknown;
  markProjectReady?(id: string): unknown;
}

export interface EffectPostcondition {
  path: string;
  etag: string;
  id?: string;
  revision_id?: string;
  document_complete?: boolean;
}

export interface LocalOperationProgress {
  preconditions_validated?: boolean;
  renames?: Record<string, RenamePlan>;
  effects?: Record<string, EffectPostcondition>;
}

export interface LocalMutationCoordinatorDeps {
  operations: LocalOperationJournal;
  documents: LocalDocumentExecutor;
  catalogue: LocalObservedCatalogue;
  vaultRoot: string;
  clock: Clock;
  ids: IdSource;
  projects?: LocalProjectLookup;
  revisions?: RevisionStore;
  foreignKeys?: { has(idempotencyKey: string): boolean };
}

function localConflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function localInvalid(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function sharedKeyConflict(idempotencyKey: string): BrainError {
  return new BrainError({
    code: 'IDEMPOTENCY_CONFLICT',
    message: `idempotency key ${idempotencyKey} was used for a different tool`
  });
}

function localRecovery(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function canonicalRequest(intent: LocalOperationIntent): { hash: string; json: string } {
  const json = JSON.stringify(
    canonicalize({ tool: intent.tool, action: intent.action, payload: intent.payload,
      ...(intent.tool !== 'brain_review' || intent.project_id === null
        ? {} : { project_id: intent.project_id }) })
  );
  return { hash: createHash('sha256').update(json, 'utf8').digest('hex'), json };
}

function preconditionsOf(intent: LocalOperationIntent): {
  id?: string;
  path?: string;
  target_path?: string;
  etag?: string;
  expected_heads?: readonly LocalExpectedHead[];
} {
  const preconditions = intent.preconditions as {
    id?: unknown;
    path?: unknown;
    target_path?: unknown;
    etag?: unknown;
    expected_heads?: unknown;
  };
  return {
    ...(typeof preconditions.id === 'string' ? { id: preconditions.id } : {}),
    ...(typeof preconditions.path === 'string' ? { path: preconditions.path } : {}),
    ...(typeof preconditions.target_path === 'string'
      ? { target_path: preconditions.target_path }
      : {}),
    ...(typeof preconditions.etag === 'string' ? { etag: preconditions.etag } : {}),
    ...(Array.isArray(preconditions.expected_heads)
      ? { expected_heads: preconditions.expected_heads as readonly LocalExpectedHead[] }
      : {})
  };
}

export class LocalMutationCoordinator implements LocalMutationCoordinatorPort {
  private readonly deps: LocalMutationCoordinatorDeps;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: LocalMutationCoordinatorDeps) {
    this.deps = deps;
  }

  run(intent: LocalOperationIntent, plan: LocalOperationPlan): Promise<LocalOperationReceipt> {
    return this.runLazy(intent, async () => plan);
  }

  runLazy(intent: LocalOperationIntent, prepare: () => Promise<LocalOperationPlan>): Promise<LocalOperationReceipt> {
    return this.withLock(() => this.runSerialized(intent, prepare));
  }

  runWithSharedKey<T>(idempotencyKey: string, work: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const existing = this.deps.operations.findByKey(idempotencyKey);
      if (existing !== undefined) {
        if (!this.releasable(existing)) throw sharedKeyConflict(idempotencyKey);
        this.deps.operations.release(existing.operation_id);
      }
      return work();
    });
  }

  status(operation_id: string): LocalOperationStatus | undefined {
    const record = this.deps.operations.findById(operation_id);
    if (record === undefined) return undefined;
    const receipt = record.receipt_json === null
      ? undefined
      : JSON.parse(record.receipt_json) as LocalOperationReceipt;
    const status: LocalOperationStatus = {
      operation_id: record.operation_id,
      tool: record.tool,
      action: record.action,
      project_id: record.project_id ?? this.ensuredProject(record, receipt),
      state: record.state
    };
    if (receipt !== undefined) status.receipt = receipt;
    return status;
  }

  private ensuredProject(
    record: LocalOperationRecord,
    receipt: LocalOperationReceipt | undefined
  ): string | null {
    if (record.tool !== 'brain_project_ensure') return null;
    if (receipt?.kind === 'project_ensure') return receipt.project_id;
    if (record.plan_json === null) return null;
    try {
      const plan = JSON.parse(record.plan_json) as { kind?: unknown; project_id?: unknown };
      return plan.kind === 'project_ensure' && typeof plan.project_id === 'string' ? plan.project_id : null;
    } catch {
      return null;
    }
  }

  latestGeneratedNote(id: string): NoteInput | undefined {
    for (const record of this.deps.operations.listFinalizedForNote(id)) {
      let request: { tool?: unknown; action?: unknown; payload?: { note?: unknown; id?: unknown } };
      try {
        request = JSON.parse(record.payload_json) as typeof request;
      } catch {
        return undefined;
      }
      const note = request.payload?.note;
      if (note === undefined) continue;
      if (typeof note !== 'object' || note === null) return undefined;
      if (request.tool === 'brain_capture' ||
          (request.tool === 'brain_review' && request.payload?.id === id &&
            (request.action === 'revise' || request.action === 'resolve'))) {
        return note as NoteInput;
      }
      return undefined;
    }
    return undefined;
  }

  async selectSurvivorPath(id: string, heads: readonly LocalConflictHead[]): Promise<string> {
    if (heads.length === 0) throw localConflict(`note ${id} has no conflict heads`);
    const ordered = [...heads].sort((left, right) => compareCodeUnits(left.path, right.path));
    const fallback = ordered[0].path;
    const materialized = this.deps.documents.materializedPath;
    if (materialized === undefined || this.deps.revisions === undefined) return fallback;
    const lineages = new Map<string, Set<string>>();
    for (const head of heads) lineages.set(head.revision_id, await this.collectAncestors(id, head.revision_id));
    const headRevisions = new Set(heads.map((head) => head.revision_id));
    const all = [...lineages.values()];
    const common = [...all[0]].filter((revision) =>
      !headRevisions.has(revision) && all.every((lineage) => lineage.has(revision)));
    const commonLineages = new Map<string, Set<string>>();
    for (const revision of common) commonLineages.set(revision, await this.collectAncestors(id, revision));
    const latest = common.filter((revision) => !common.some((other) =>
      other !== revision && (commonLineages.get(other) as Set<string>).has(revision)));
    const headPaths = new Set(heads.map((head) => head.path));
    const recorded = new Set<string>();
    for (const revision of latest) {
      const path = materialized.call(this.deps.documents, id, revision);
      if (path !== undefined) recorded.add(path);
    }
    if (recorded.size !== 1) return fallback;
    const [path] = [...recorded];
    return headPaths.has(path) ? path : fallback;
  }

  recover(): Promise<LocalRecoveryReport> {
    return this.withLock(async () => {
      const pending = this.deps.operations.listIncomplete();
      const blocking: string[] = [];
      let finalized = 0;
      let conflicted = 0;
      let recovered = 0;
      let stillPending = 0;
      for (const record of pending) {
        if (record.plan_json === null && this.releasable(record)) {
          this.deps.operations.release(record.operation_id);
          continue;
        }
        if (record.plan_json === null) {
          this.deps.operations.update(record.operation_id, {
            state: 'recovery_required',
            updated_at: this.now()
          });
          blocking.push(record.operation_id);
          stillPending += 1;
          continue;
        }
        let plan: LocalPlannedOperation;
        try {
          plan = JSON.parse(record.plan_json) as LocalPlannedOperation;
        } catch {
          this.deps.operations.update(record.operation_id, {
            state: 'recovery_required',
            updated_at: this.now()
          });
          blocking.push(record.operation_id);
          stillPending += 1;
          continue;
        }
        try {
          await this.recoverOperation(record, plan);
          finalized += 1;
          recovered += 1;
        } catch (error) {
          if (isBrainError(error) && error.code === 'CONFLICT') {
            this.deps.operations.update(record.operation_id, {
              state: 'conflicted',
              updated_at: this.now()
            });
            conflicted += 1;
          } else {
            this.deps.operations.update(record.operation_id, {
              state: 'recovery_required',
              updated_at: this.now()
            });
            blocking.push(record.operation_id);
            stillPending += 1;
          }
        }
      }
      return {
        inspected: pending.length,
        finalized,
        conflicted,
        recovered,
        pending: stillPending,
        blocking_operations: blocking
      };
    });
  }

  private replayIntent(intent: LocalOperationIntent, record: LocalOperationRecord): LocalOperationIntent {
    const selection = intent.project_selection;
    if (intent.tool !== 'brain_review' || selection === undefined) return intent;
    if (record.project_selector !== undefined && record.project_selector === selection.selector) {
      return { ...intent, project_id: record.project_id } as LocalOperationIntent;
    }
    let resolved: string | null | undefined;
    try {
      resolved = selection.resolve();
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined) return { ...intent, project_id: resolved } as LocalOperationIntent;
    if (record.project_id !== null && selection.identifier === record.project_id) {
      return { ...intent, project_id: record.project_id } as LocalOperationIntent;
    }
    throw new BrainError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: `idempotency key ${intent.idempotency_key} was used for a different request`
    });
  }

  private releasable(record: LocalOperationRecord): boolean {
    return record.plan_json === null && record.receipt_json === null &&
      (record.state === 'pending' || record.state === 'recovery_required') &&
      this.deps.operations.listSubordinates(record.operation_id).length === 0 &&
      this.deps.documents.hasDocumentActivity?.(record.idempotency_key) !== true;
  }

  private releaseQuietly(operationId: string): void {
    try {
      this.deps.operations.release(operationId);
    } catch {
      undefined;
    }
  }

  private async runSerialized(
    intent: LocalOperationIntent,
    prepare: () => Promise<LocalOperationPlan>
  ): Promise<LocalOperationReceipt> {
    const existing = this.deps.operations.findByKey(intent.idempotency_key);
    if (existing !== undefined && !(existing.plan_json === null && this.releasable(existing))) {
      const replayed = this.replayIntent(intent, existing);
      return this.replay(replayed, existing, canonicalRequest(replayed).hash);
    }
    if (existing !== undefined) this.deps.operations.release(existing.operation_id);
    if (this.deps.foreignKeys?.has(intent.idempotency_key) === true) {
      throw sharedKeyConflict(intent.idempotency_key);
    }
    const selected = intent.project_selection === undefined
      ? intent
      : { ...intent, project_id: intent.project_selection.resolve() } as LocalOperationIntent;
    const request = canonicalRequest(selected);
    const now = this.now();
    const reserved = this.deps.operations.reserve({
      idempotency_key: selected.idempotency_key,
      tool: selected.tool,
      action: selected.action,
      project_id: selected.project_id,
      payload_hash: request.hash,
      payload_json: request.json,
      ...(intent.project_selection === undefined ? {} : { project_selector: intent.project_selection.selector }),
      created_at: now,
      updated_at: now
    }, () => this.deps.ids.next());
    if (reserved.kind === 'replay') return this.replay(selected, reserved.record, request.hash);
    const record = reserved.record;
    let observed: LocalObservedState;
    let planned: LocalPlannedOperation;
    try {
      const plan = await prepare();
      observed = await this.observe(selected);
      const identity = this.allocate(record, selected, observed);
      planned = await plan(identity, observed);
      this.assertPlanReadSet(planned);
      await this.bindPlanToIntent(selected, planned);
      this.assertNoPendingOverlap(record, planned);
    } catch (error) {
      this.releaseQuietly(record.operation_id);
      throw error;
    }
    this.deps.operations.update(record.operation_id, {
      ...(planned.kind === 'project_ensure' ? { project_id: planned.project_id } : {}),
      plan_json: JSON.stringify(planned),
      storage_key: JSON.stringify(this.storageKeys(record.idempotency_key, planned)),
      updated_at: this.now()
    });
    await this.persistObservedHeads(planned, observed);
    try {
      await this.recheckPlan(planned);
    } catch (error) {
      if (isBrainError(error) && error.code === 'CONFLICT') {
        this.deps.operations.update(record.operation_id, {
          state: 'conflicted',
          updated_at: this.now()
        });
      }
      throw error;
    }
    this.deps.operations.update(record.operation_id, {
      progress_json: JSON.stringify({ preconditions_validated: true }),
      updated_at: this.now()
    });
    this.persistSubordinates(record, planned);
    const receipt = await this.executePlan(record, planned);
    this.completeSubordinates(record, planned);
    return receipt;
  }

  private async replay(
    intent: LocalOperationIntent,
    record: LocalOperationRecord,
    payloadHash: string
  ): Promise<LocalOperationReceipt> {
    if (record.payload_hash !== payloadHash || record.tool !== intent.tool) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${intent.idempotency_key} was used for a different request`
      });
    }
    if (record.state === 'conflicted') {
      throw localConflict(`operation ${record.operation_id} ended in conflict and cannot be retried`);
    }
    if (record.state === 'recovery_required') {
      throw localRecovery(`operation ${record.operation_id} requires recovery`);
    }
    if (record.receipt_json !== null && record.state === 'finalized') {
      return JSON.parse(record.receipt_json) as LocalOperationReceipt;
    }
    if (record.plan_json === null) {
      throw localRecovery(`operation ${record.operation_id} has no durable plan yet`);
    }
    const plan = JSON.parse(record.plan_json) as LocalPlannedOperation;
    this.bindLegacySubordinates(record, plan);
    await this.recoverOperation(record, plan);
    const finalized = this.deps.operations.findById(record.operation_id);
    if (finalized?.receipt_json === null || finalized?.receipt_json === undefined) {
      throw localRecovery(`operation ${record.operation_id} did not produce a durable receipt`);
    }
    return JSON.parse(finalized.receipt_json) as LocalOperationReceipt;
  }

  private assertNoPendingOverlap(record: LocalOperationRecord, plan: LocalPlannedOperation): void {
    const plannedPaths = new Set<string>();
    const plannedIds = new Set<string>();
    if (plan.kind === 'note') {
      for (const head of plan.heads) { plannedIds.add(head.id); plannedPaths.add(head.path); }
      for (const effect of plan.effects) {
        if (effect.kind === 'move') { plannedPaths.add(effect.from_path); plannedPaths.add(effect.to_path); }
        else plannedPaths.add(effect.kind === 'write' || effect.kind === 'adopt' ? effect.write.path : effect.path);
      }
      for (const edit of plan.reference_edits ?? []) plannedPaths.add(edit.path);
    }
    for (const condition of plan.read_set) {
      if (condition.kind === 'path') plannedPaths.add(condition.path);
      else if (condition.kind === 'note') {
        plannedIds.add(condition.id);
        if (condition.expected.kind === 'present') plannedPaths.add(condition.expected.path);
      } else if (condition.kind === 'heads') plannedIds.add(condition.id);
    }
    for (const pending of this.deps.operations.listIncomplete()) {
      if (pending.operation_id === record.operation_id || pending.plan_json === null) continue;
      let other: LocalPlannedOperation;
      try { other = JSON.parse(pending.plan_json) as LocalPlannedOperation; }
      catch { throw localRecovery(`pending operation ${pending.operation_id} has unreadable affected paths`); }
      if (other.kind !== 'note') continue;
      if (other.heads.some((head) => plannedIds.has(head.id) || plannedPaths.has(head.path)) ||
          other.effects.some((effect) => effect.kind === 'move'
            ? plannedPaths.has(effect.from_path) || plannedPaths.has(effect.to_path)
            : plannedPaths.has(effect.kind === 'write' || effect.kind === 'adopt' ? effect.write.path : effect.path)) ||
          (other.reference_edits ?? []).some((edit) => plannedPaths.has(edit.path))) {
        throw localRecovery(`pending operation ${pending.operation_id} blocks an overlapping mutation`);
      }
    }
  }

  private async observe(intent: LocalOperationIntent): Promise<LocalObservedState> {
    const sources: LocalObservedSource[] = [];
    const heads: LocalConflictHead[] = [];
    const seen = new Set<string>();
    const read = async (path: string): Promise<void> => {
      if (seen.has(path)) return;
      seen.add(path);
      const file = await this.readPathOrUndefined(path);
      if (file === undefined) return;
      sources.push({
        path,
        raw: file.raw,
        etag: file.etag,
        ...(file.id === undefined ? {} : { id: file.id }),
        ...(file.revision_id === undefined ? {} : { revision_id: file.revision_id })
      });
    };
    const preconditions = preconditionsOf(intent);
    if (preconditions.id !== undefined) {
      const matches = await this.resolveConflictHeads(preconditions.id);
      for (const match of matches) {
        await read(match.path);
        heads.push({
          id: preconditions.id,
          path: match.path,
          revision_id: match.revision_id,
          etag: match.etag,
          parents: match.parents
        });
      }
    }
    if (preconditions.path !== undefined) await read(preconditions.path);
    return { sources, heads };
  }

  private allocate(
    record: LocalOperationRecord,
    intent: LocalOperationIntent,
    observed: LocalObservedState
  ): LocalAllocatedIdentity {
    const base = {
      operation_id: record.operation_id,
      timestamp: record.created_at,
      storage_operation_ids: [] as string[]
    };
    if (intent.tool === 'brain_project_ensure') return { kind: 'project_ensure', ...base };
    if (intent.tool === 'brain_feedback') {
      return { kind: 'feedback', feedback_id: this.deps.ids.next(), ...base };
    }
    const preconditions = preconditionsOf(intent);
    const note_id = preconditions.id ?? this.deps.ids.next();
    const revision_id = this.deps.ids.next();
    const observedPath = observed.sources.find((source) => source.id === note_id)?.path;
    const path =
      preconditions.target_path ??
      preconditions.path ??
      observedPath ??
      this.allocateCapturePath(intent);
    return { kind: 'note', note_id, revision_id, path: path as string, ...base };
  }

  private allocateCapturePath(intent: LocalOperationIntent): string {
    if (intent.tool !== 'brain_capture') {
      throw localInvalid('a note identity requires a persisted path');
    }
    const payload = intent.payload as CaptureRequest;
    return allocateNotePath({
      directory: 'Inbox',
      title: payload.note.title,
      occupied: this.deps.catalogue.all().map((entry) => entry.path)
    });
  }

  private subordinateSpecs(plan: LocalPlannedOperation): { kind: string; key: string }[] {
    if (plan.kind === 'project_ensure') return [{ kind: 'project_ensure', key: 'project' }];
    if (plan.kind === 'feedback') return [{ kind: 'feedback', key: 'feedback' }];
    if (plan.effects.some((effect) => effect.kind === 'remove')) {
      return [{ kind: 'consolidation', key: 'consolidate' }];
    }
    const specs: { kind: string; key: string }[] = [];
    plan.effects.forEach((effect, index) => {
      if (effect.kind === 'move') specs.push({ kind: 'move', key: `move:${index}` });
      else specs.push({ kind: effect.kind, key: `doc:${index}` });
      if (effect.kind === 'move' && effect.write !== undefined) {
        specs.push({ kind: 'write', key: `doc:${index + 1000}` });
      }
    });
    return specs;
  }

  private persistSubordinates(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): void {
    const existing = this.deps.operations.listSubordinates(record.operation_id);
    this.subordinateSpecs(plan).forEach((spec, index) => {
      const effectIndex = spec.key.startsWith('doc:') && Number(spec.key.slice(4)) >= 1000
        ? Number(spec.key.slice(4)) : index;
      const key = `${record.idempotency_key}:${spec.key}`;
      const held = existing.find((entry) => entry.effect_index === effectIndex);
      if (held !== undefined) {
        if (held.key !== key) {
          throw localRecovery('the persisted subordinate linkage changed for this operation');
        }
        return;
      }
      this.deps.operations.reserveSubordinate({
        operation_id: record.operation_id,
        effect_index: effectIndex,
        kind: spec.kind,
        key,
        created_at: record.created_at,
        updated_at: this.now()
      });
    });
  }

  private bindLegacySubordinates(record: LocalOperationRecord, plan: LocalPlannedOperation): void {
    const existing = this.deps.operations.listSubordinates(record.operation_id);
    if (record.storage_key === null) return;
    let legacyKeys: unknown;
    try {
      legacyKeys = JSON.parse(record.storage_key);
    } catch (cause) {
      throw localRecovery('the legacy subordinate linkage is unreadable', cause);
    }
    if (!Array.isArray(legacyKeys) || legacyKeys.some((entry) => typeof entry !== 'string')) {
      throw localRecovery('the legacy subordinate linkage is malformed');
    }
    const specs = this.subordinateSpecs(plan);
    const expectedKeys = specs.map((spec) => `${record.idempotency_key}:${spec.key}`);
    const hasManifest = plan.kind === 'note' && specs.length === 1 && specs[0].kind === 'consolidation' &&
      this.deps.documents.hasConsolidationManifest?.(expectedKeys[0]) === true;
    let compatibleConsolidation = false;
    if (plan.kind === 'note' && specs.length === 1 && specs[0].kind === 'consolidation') {
      const former = plan.effects.map((effect, index) =>
        `${record.idempotency_key}:${effect.kind === 'move' ? 'move' : 'doc'}:${index}`);
      former.push(`${record.idempotency_key}:consolidate:primary`,
        `${record.idempotency_key}:consolidate:manifest`);
      (plan.reference_edits ?? []).forEach((_edit, index) => former.push(`${record.idempotency_key}:ref:${index}`));
      let beforeManifest = false;
      if (!hasManifest && existing.length > 0 &&
          this.deps.documents.hasDocumentActivity?.(record.idempotency_key) === false) {
        let progress: LocalOperationProgress;
        try { progress = JSON.parse(record.progress_json ?? '{}') as LocalOperationProgress; }
        catch (error) { throw localRecovery('the pre-manifest operation progress is unreadable', error); }
        if (progress === null || typeof progress !== 'object' || Array.isArray(progress) ||
            progress.effects === null ||
            (progress.effects !== undefined && (typeof progress.effects !== 'object' || Array.isArray(progress.effects))) ||
            progress.renames === null ||
            (progress.renames !== undefined && (typeof progress.renames !== 'object' || Array.isArray(progress.renames)))) {
          throw localRecovery('the pre-manifest operation progress is malformed');
        }
        beforeManifest = Object.keys(progress.effects ?? {}).length === 0 &&
          Object.keys(progress.renames ?? {}).length === 0;
      }
      compatibleConsolidation = JSON.stringify(legacyKeys) === JSON.stringify(former) &&
        (hasManifest || beforeManifest);
      if (compatibleConsolidation) {
        const primary = plan.effects.find((effect) => effect.kind === 'write');
        const put = this.deps.documents.getDocumentReceipt(`${record.idempotency_key}:consolidate:primary`);
        const consolidated = this.deps.documents.getConsolidationReceipt(expectedKeys[0]);
        if (primary?.kind !== 'write' ||
            (put !== undefined && (put.id !== primary.write.id || put.revision_id !== primary.write.revision_id ||
              put.path !== primary.write.path)) ||
            (consolidated !== undefined && (consolidated.id !== primary.write.id ||
              consolidated.revision_id !== primary.write.revision_id || consolidated.path !== primary.write.path)) ||
            former.filter((key) => key !== `${record.idempotency_key}:consolidate:primary`).some((key) =>
              this.deps.documents.getDocumentReceipt(key) !== undefined ||
              this.deps.documents.getMoveReceipt(key) !== undefined)) {
          compatibleConsolidation = false;
        }
      }
    }
    if (JSON.stringify(legacyKeys) !== JSON.stringify(expectedKeys) && !compatibleConsolidation) {
      throw localRecovery(
        'the legacy subordinate linkage does not match this plan and cannot be rebound safely'
      );
    }
    if (existing.length > 0) {
      if (compatibleConsolidation && existing.some((row) => row.key !== expectedKeys[row.effect_index])) {
        const historical = plan.kind === 'note' ? [
          ...plan.effects.map((effect, index) => ({
            key: `${record.idempotency_key}:${effect.kind === 'move' ? `move:${index}` :
              effect.kind === 'remove' ? `remove:${index}` : `doc:${index}`}`,
            kind: effect.kind
          })),
          { key: expectedKeys[0], kind: 'consolidation' },
          ...(plan.reference_edits ?? []).map((_edit, index) => ({
            key: `${record.idempotency_key}:ref:${index}`, kind: 'reference_edit'
          }))
        ] : [];
        const manifestId = this.deps.documents.getConsolidationOperationId?.(expectedKeys[0]);
        const primaryReceipt = this.deps.documents.getDocumentReceipt(`${record.idempotency_key}:consolidate:primary`);
        const consolidatedReceipt = this.deps.documents.getConsolidationReceipt(expectedKeys[0]);
        const primaryDocumentId = consolidatedReceipt?.operation_id ?? primaryReceipt?.operation_id;
        const primaryIndex = plan.kind === 'note' ? plan.effects.findIndex((effect) => effect.kind === 'write') : -1;
        if ((hasManifest ? manifestId !== record.operation_id : manifestId !== undefined) ||
            existing.length > historical.length ||
            (consolidatedReceipt !== undefined && primaryReceipt !== undefined &&
              consolidatedReceipt.operation_id !== primaryReceipt.operation_id) ||
            this.deps.documents.getDocumentReceipt(expectedKeys[0]) !== undefined ||
            this.deps.documents.getMoveReceipt(expectedKeys[0]) !== undefined) {
          throw localRecovery('the persisted historical subordinate batch is ambiguous');
        }
        for (const [index, row] of existing.entries()) {
          const spec = historical[index];
          if (row.effect_index !== index || row.key !== spec?.key || row.kind !== spec.kind ||
              row.state === 'failed' || (!hasManifest && row.state === 'complete')) {
            throw localRecovery(`historical subordinate ${index} disagrees with its planned effect`);
          }
          const document = this.deps.documents.getDocumentReceipt(row.key)?.operation_id;
          const move = this.deps.documents.getMoveReceipt(row.key)?.operation_id;
          const candidates = [
            document, move,
            ...(index === primaryIndex ? [primaryDocumentId] : []),
            ...(spec.kind === 'consolidation' ? [manifestId] : [])
          ].filter((id): id is string => id !== undefined);
          if ((spec.kind !== 'write' && spec.kind !== 'consolidation' && (document !== undefined || move !== undefined)) ||
              new Set(candidates).size > 1 ||
              (row.document_operation_id !== null &&
                (candidates.length !== 1 || row.document_operation_id !== candidates[0]))) {
            throw localRecovery(`historical subordinate ${index} has ambiguous document linkage`);
          }
        }
        this.deps.operations.replaceLegacyConsolidationSubordinates({
          operation_id: record.operation_id,
          expected: existing,
          key: expectedKeys[0],
          document_operation_id: primaryDocumentId ?? null,
          created_at: record.created_at,
          updated_at: this.now()
        });
        return;
      }
      if (existing.length !== expectedKeys.length || expectedKeys.some((key, index) =>
        existing.find((row) => row.key === key)?.effect_index !== (
          specs[index].key.startsWith('doc:') && Number(specs[index].key.slice(4)) >= 1000
            ? Number(specs[index].key.slice(4)) : index))) {
        throw localRecovery('the persisted subordinate rows disagree with the stored key array');
      }
      return;
    }
    specs.forEach((spec, index) => {
      const effectIndex = spec.key.startsWith('doc:') && Number(spec.key.slice(4)) >= 1000
        ? Number(spec.key.slice(4)) : index;
      const key = expectedKeys[index];
      const candidates: string[] = [];
      const document = this.deps.documents.getDocumentReceipt(key);
      if (document?.operation_id !== undefined) candidates.push(document.operation_id);
      const move = this.deps.documents.getMoveReceipt(key);
      if (move?.operation_id !== undefined) candidates.push(move.operation_id);
      if (spec.kind === 'consolidation') {
        const consolidation = this.deps.documents.getConsolidationReceipt(key);
        if (consolidation?.operation_id !== undefined) candidates.push(consolidation.operation_id);
      }
      const unique = [...new Set(candidates)];
      if (unique.length > 1) {
        throw localRecovery(`legacy subordinate key ${key} matches multiple document operations`);
      }
      this.deps.operations.reserveSubordinate({
        operation_id: record.operation_id,
        effect_index: effectIndex,
        kind: spec.kind,
        key,
        created_at: record.created_at,
        updated_at: this.now()
      });
      if (unique.length === 1) {
        this.deps.operations.setSubordinateDocumentOperation(
          record.operation_id,
          effectIndex,
          unique[0]
        );
      }
    });
  }

  private completeSubordinates(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): void {
    this.subordinateSpecs(plan).forEach((_spec, index) => {
      const effectIndex = _spec.key.startsWith('doc:') && Number(_spec.key.slice(4)) >= 1000
        ? Number(_spec.key.slice(4)) : index;
      this.deps.operations.markSubordinate(record.operation_id, effectIndex, 'complete');
    });
  }

  private storageKeys(key: string, plan: LocalPlannedOperation): string[] {
    return this.subordinateSpecs(plan).map((spec) => `${key}:${spec.key}`);
  }

  private async bindPlanToIntent(intent: LocalOperationIntent, plan: LocalPlannedOperation): Promise<void> {
    if (plan.kind !== 'note') return;
    const preconditions = preconditionsOf(intent);
    if (intent.action === 'resolve') {
      const expected = preconditions.expected_heads ?? [];
      if (plan.heads.length !== expected.length) {
        throw localInvalid('the resolve plan does not match the requested conflict heads');
      }
      for (const head of expected) {
        if (
          !plan.heads.some(
            (planned) =>
              planned.revision_id === head.revision_id && planned.etag === head.etag
          )
        ) {
          throw localInvalid('the resolve plan does not match the requested conflict heads');
        }
      }
    }
    if (intent.action === 'supersede') {
      let replacementId: string | undefined = intent.payload.replacement_id;
      const visited = new Set([intent.payload.id]);
      while (replacementId !== undefined) {
        if (visited.has(replacementId)) throw localConflict('the supersession chain contains a cycle');
        visited.add(replacementId);
        const heads = await this.resolveConflictHeads(replacementId);
        if (heads.length !== 1 || heads[0].revision_id.length === 0) {
          throw localConflict(`replacement ${replacementId} has no unique durable current revision`);
        }
        const head = heads[0];
        if (!plan.read_set.some((condition) => condition.kind === 'note' &&
            condition.id === replacementId && condition.expected.kind === 'present' &&
            condition.expected.path === head.path && condition.expected.revision_id === head.revision_id &&
            condition.expected.etag === head.etag)) {
          throw localInvalid(`the supersede plan must bind replacement ${replacementId} and its revision`);
        }
        const file = await this.readPathOrUndefined(head.path);
        if (file === undefined) throw localConflict(`replacement ${replacementId} disappeared`);
        const parsed = parseDocument(file.raw, head.path);
        const next = parsed.properties.replacement_id ?? parsed.properties.brain_replacement_id;
        if (parsed.status === 'superseded' && (typeof next !== 'string' || next.length === 0)) {
          throw localRecovery(`replacement ${replacementId} has an incomplete supersession chain`);
        }
        replacementId = typeof next === 'string' ? next : undefined;
      }
    }
    if (preconditions.etag !== undefined) {
      const expectedPath = preconditions.path;
      const bound = plan.read_set.some(
        (condition) =>
          (condition.kind === 'note' &&
            condition.expected.kind === 'present' &&
            (expectedPath === undefined || condition.expected.path === expectedPath) &&
            condition.expected.etag === preconditions.etag) ||
          (condition.kind === 'path' &&
            condition.expected.kind === 'present' &&
            (expectedPath === undefined || condition.path === expectedPath) &&
            condition.expected.etag === preconditions.etag)
      );
      if (!bound) {
        throw localInvalid('the plan does not bind the requested expected etag');
      }
    }
  }

  private assertPlanReadSet(plan: LocalPlannedOperation): void {
    const readSet: readonly LocalReadCondition[] = plan.read_set;
    if (!Array.isArray(readSet) || readSet.length === 0) {
      throw localInvalid('an operation plan must persist a nonempty read set');
    }
    const coversPath = (path: string): boolean =>
      readSet.some(
        (condition) =>
          (condition.kind === 'path' && condition.path === path) ||
          (condition.kind === 'note' &&
            condition.expected.kind === 'present' &&
            condition.expected.path === path)
      );
    if (plan.kind === 'note') {
      for (const effect of plan.effects) {
        if (effect.kind === 'write') {
          if (!coversPath(effect.write.path)) {
            throw localInvalid(`the read set does not cover write target ${effect.write.path}`);
          }
        } else if (effect.kind === 'adopt') {
          if (!coversPath(effect.path)) {
            throw localInvalid(`the read set does not cover adoption target ${effect.path}`);
          }
        } else if (effect.kind === 'move') {
          if (!coversPath(effect.from_path) || !coversPath(effect.to_path) ||
              (effect.write !== undefined && !coversPath(effect.write.path))) {
            throw localInvalid(
              `the read set does not cover the move ${effect.from_path} -> ${effect.to_path}`
            );
          }
        } else {
          if (!coversPath(effect.path)) {
            throw localInvalid(`the read set does not cover removal target ${effect.path}`);
          }
        }
      }
      const priorEdit = new Map<string, string>();
      for (const edit of plan.reference_edits ?? []) {
        const prior = priorEdit.get(edit.path);
        if (prior !== undefined && createHash('sha256').update(prior).digest('hex') !== edit.expected_etag) {
          throw localInvalid(`reference edits for ${edit.path} do not compose`);
        }
        if (prior === undefined && !readSet.some((condition) =>
          (condition.kind === 'path' && condition.path === edit.path && condition.expected.kind === 'present' && condition.expected.etag === edit.expected_etag) ||
          (condition.kind === 'note' && condition.expected.kind === 'present' && condition.expected.path === edit.path && condition.expected.etag === edit.expected_etag))) {
          throw localInvalid(`the read set does not cover reference edit ${edit.path}`);
        }
        priorEdit.set(edit.path, edit.raw);
        if (edit.managed !== undefined) {
          const bound = readSet.some(
            (condition) =>
              condition.kind === 'note' &&
              condition.id === edit.managed?.id &&
              condition.expected.kind === 'present' &&
              condition.expected.path === edit.path &&
              condition.expected.etag === (prior === undefined ? edit.expected_etag :
                (plan.reference_edits ?? []).find((item) => item.path === edit.path)?.expected_etag)
          );
          if (!bound) {
            throw localInvalid(`the read set does not bind managed reference edit ${edit.path}`);
          }
        }
      }
      if (plan.heads.length > 0) {
        const headsCondition = readSet.find(
          (condition) => condition.kind === 'heads' && condition.id === plan.heads[0].id
        );
        if (headsCondition === undefined || headsCondition.kind !== 'heads') {
          throw localInvalid('a conflict-resolution plan must persist its expected conflict heads');
        }
        const expectedHeads: readonly LocalExpectedHead[] = (headsCondition as {
          expected_heads: readonly LocalExpectedHead[];
        }).expected_heads;
        if (expectedHeads.length !== plan.heads.length) {
          throw localInvalid('the heads condition must equal the verified conflict heads');
        }
        for (const head of plan.heads) {
          if (!readSet.some((condition) =>
            (condition.kind === 'path' && condition.path === head.path && condition.expected.kind === 'present' &&
              condition.expected.id === head.id && condition.expected.revision_id === head.revision_id && condition.expected.etag === head.etag) ||
            (condition.kind === 'note' && condition.id === head.id && condition.expected.kind === 'present' &&
              condition.expected.path === head.path && condition.expected.revision_id === head.revision_id && condition.expected.etag === head.etag))) {
            throw localInvalid(`the read set does not bind conflict head ${head.path}`);
          }
          if (
            !expectedHeads.some(
              (expected) =>
                expected.revision_id === head.revision_id && expected.etag === head.etag
            )
          ) {
            throw localInvalid('the heads condition must equal the verified conflict heads');
          }
        }
        if (plan.parents.length !== plan.heads.length) {
          throw localInvalid('resolution parents must equal the verified conflict heads');
        }
        for (const head of plan.heads) {
          if (
            !plan.parents.some(
              (parent) =>
                parent.revision_id === head.revision_id && parent.raw_hash === head.etag
            )
          ) {
            throw localInvalid('resolution parents must equal the verified conflict heads');
          }
        }
      }
    } else if (plan.kind === 'project_ensure') {
      if (
        !readSet.some(
          (condition) =>
            condition.kind === 'project' &&
            condition.repository_identity === plan.repository_identity
        )
      ) {
        throw localInvalid('a project-ensure plan must persist its project precondition');
      }
    } else if (
      !readSet.some(
        (condition) =>
          condition.kind === 'note' &&
          condition.id === plan.id &&
          condition.expected.kind === 'present' &&
          condition.expected.revision_id === plan.revision_id
      )
    ) {
      throw localInvalid('a feedback plan must persist its revision precondition');
    }
  }

  private async recheckPlan(
    plan: LocalPlannedOperation,
    options: { skipPaths?: ReadonlySet<string>; appliedEffects?: Readonly<Record<string, EffectPostcondition>> } = {}
  ): Promise<void> {
    for (const condition of plan.read_set) {
      if (condition.kind === 'path') {
        if (options.skipPaths?.has(condition.path)) continue;
        const current = await this.readPathOrUndefined(condition.path);
        if (condition.expected.kind === 'absent') {
          if (current !== undefined) throw localConflict(`path ${condition.path} is no longer vacant`);
          continue;
        }
        if (
          current === undefined ||
          current.etag !== condition.expected.etag ||
          (condition.expected.id !== undefined && current.id !== condition.expected.id) ||
          (condition.expected.revision_id !== undefined &&
            current.revision_id !== condition.expected.revision_id)
        ) {
          throw localConflict(`path ${condition.path} changed since the operation was planned`);
        }
        continue;
      }
      if (condition.kind === 'note') {
        const expected = condition.expected;
        if (expected.kind === 'present' && options.skipPaths?.has(expected.path)) continue;
        const heads = await this.resolveConflictHeads(condition.id);
        if (expected.kind === 'absent') {
          if (heads.length > 0) throw localConflict(`note ${condition.id} already exists`);
          continue;
        }
        const match = heads.find((head) => head.path === expected.path);
        if (
          match === undefined ||
          match.etag !== expected.etag ||
          match.revision_id !== expected.revision_id
        ) {
          throw localConflict(`note ${condition.id} changed since the operation was planned`);
        }
        continue;
      }
      if (condition.kind === 'heads') {
        if (options.appliedEffects !== undefined && plan.kind === 'note') {
          const expectedPaths = new Set(plan.heads.map((head) => head.path));
          for (const [index, effect] of plan.effects.entries()) {
            if (options.appliedEffects[String(index)] === undefined) continue;
            if (effect.kind === 'move') {
              expectedPaths.delete(effect.from_path);
              expectedPaths.add(effect.to_path);
            } else if (effect.kind === 'remove') expectedPaths.delete(effect.path);
          }
          const current = await this.resolveConflictHeads(condition.id);
          if (current.length !== expectedPaths.size || current.some((head) => !expectedPaths.has(head.path))) {
            throw localConflict('the current head set diverged after partial application');
          }
          for (const head of plan.heads) {
            if (options.skipPaths?.has(head.path)) continue;
            if (!current.some((item) => item.path === head.path && item.revision_id === head.revision_id && item.etag === head.etag)) {
              throw localConflict(`unfinished conflict head ${head.path} changed`);
            }
          }
          continue;
        }
        await this.verifyConflictHeads(condition.id, condition.expected_heads);
        continue;
      }
      const project = this.deps.projects?.getProjectByIdentity(condition.repository_identity);
      if (condition.expected.kind === 'absent') {
        if (project !== undefined) {
          throw localConflict(`project ${condition.repository_identity} already exists`);
        }
        continue;
      }
      if (
        project === undefined ||
        project.project.id !== condition.expected.project_id ||
        project.updated_at !== condition.expected.version
      ) {
        throw localConflict(
          `project ${condition.repository_identity} changed since the operation was planned`
        );
      }
    }
  }

  async enumerateConflictHeads(id: string): Promise<LocalConflictHead[]> {
    return this.resolveConflictHeads(id);
  }

  private async resolveConflictHeads(id: string): Promise<LocalConflictHead[]> {
    const scan = await scanVaultFilePaths(this.deps.vaultRoot);
    if (!scan.complete) throw localRecovery('the current vault scan is incomplete');
    const heads: LocalConflictHead[] = [];
    for (const path of scan.paths.filter((path) => path.endsWith('.md'))) {
      const entry = await this.readPathOrUndefined(path);
      if (entry === undefined || parseDocument(entry.raw, path).id !== id) continue;
      const revisionId = await this.deps.revisions?.currentBinding(id, path, entry.etag);
      let parents: readonly { revision_id: string; raw_hash: string }[] = [];
      if (revisionId !== undefined) {
        try { parents = (await this.deps.revisions?.readRevisionMetadata(id, revisionId))?.parents ?? []; }
        catch (error) {
          if (isBrainError(error) && error.code === 'NOT_FOUND') {
            parents = [];
          } else {
            throw error;
          }
        }
      }
      heads.push({
        id,
        path,
        revision_id: revisionId ?? '',
        etag: entry.etag,
        parents
      });
    }
    return heads;
  }

  async verifyConflictHeads(id: string, expected: readonly LocalExpectedHead[]): Promise<void> {
    const expectedIds = new Set<string>();
    for (const head of expected) {
      if (expectedIds.has(head.revision_id)) {
        throw localConflict('the expected conflict heads contain a duplicate revision');
      }
      expectedIds.add(head.revision_id);
    }
    const heads = await this.resolveConflictHeads(id);
    if (heads.length !== expected.length) {
      throw localConflict(`note ${id} does not have the exact complete set of conflict heads`);
    }
    const byRevision = new Map<string, LocalConflictHead>();
    for (const head of heads) {
      if (byRevision.has(head.revision_id)) {
        throw localConflict(`note ${id} has a duplicate conflict revision`);
      }
      byRevision.set(head.revision_id, head);
    }
    for (const head of expected) {
      const actual = byRevision.get(head.revision_id);
      if (actual === undefined) {
        throw localConflict(`expected conflict head ${head.revision_id} is missing`);
      }
      if (actual.etag !== head.etag) {
        throw localConflict(`expected conflict head ${head.revision_id} is stale`);
      }
    }
    if (heads.length <= 1) return;
    const uniqueEtags = new Set(heads.map((head) => head.etag));
    if (uniqueEtags.size !== heads.length) {
      throw localConflict(`note ${id} has a copied duplicate id, which is an identity conflict`);
    }
    const revisions = this.deps.revisions;
    if (revisions === undefined) {
      throw localRecovery('fork ancestry cannot be verified without durable revision history');
    }
    const ancestors = new Map<string, Set<string>>();
    for (const head of heads) {
      if (!REVISION_UUID_PATTERN.test(head.revision_id)) {
        throw localConflict(
          `conflict head ${head.path} has no durable revision identity and cannot be resolved`
        );
      }
      const bytes = await revisions.readRevision(id, head.revision_id);
      if (bytes.hash !== head.etag) {
        throw localRecovery(`conflict head ${head.path} does not match its durable revision bytes`);
      }
      ancestors.set(head.revision_id, await this.collectAncestors(id, head.revision_id));
    }
    for (const head of heads) {
      const lineage = ancestors.get(head.revision_id) as Set<string>;
      for (const other of heads) {
        if (other.revision_id === head.revision_id) continue;
        if (lineage.has(other.revision_id)) {
          throw localConflict(
            `conflict head ${other.path} is an ancestor of another head, not a distinct branch`
          );
        }
      }
    }
    const sets = [...ancestors.values()];
    const hasCommon = [...sets[0]].some((candidate) =>
      sets.every((lineage) => lineage.has(candidate))
    );
    if (!hasCommon) {
      throw localConflict(`note ${id} has no common ancestor and is not a legitimate fork`);
    }
  }

  private async collectAncestors(id: string, start: string): Promise<Set<string>> {
    const revisions = this.deps.revisions;
    if (revisions === undefined) {
      throw localRecovery('fork ancestry cannot be read without durable revision history');
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = async (revisionId: string): Promise<void> => {
      const status = state.get(revisionId);
      if (status === 'done') return;
      if (status === 'visiting') {
        throw localRecovery('the recorded revision ancestry contains a cycle');
      }
      state.set(revisionId, 'visiting');
      let metadata;
      try {
        metadata = await revisions.readRevisionMetadata(id, revisionId);
      } catch (error) {
        if (isBrainError(error) && error.code === 'NOT_FOUND') {
          throw localRecovery(`recorded ancestry for revision ${revisionId} is missing`);
        }
        throw error;
      }
      for (const parent of metadata.parents) {
        let bytes;
        try {
          bytes = await revisions.readRevision(id, parent.revision_id);
        } catch (error) {
          if (isBrainError(error) && error.code === 'NOT_FOUND') {
            throw localRecovery(`recorded parent ${parent.revision_id} is missing`);
          }
          throw error;
        }
        if (bytes.hash !== parent.raw_hash) {
          throw localRecovery(`recorded parent ${parent.revision_id} does not match its bytes`);
        }
        await visit(parent.revision_id);
      }
      state.set(revisionId, 'done');
    };
    await visit(start);
    return new Set(state.keys());
  }

  private async persistObservedHeads(
    plan: LocalPlannedOperation,
    observed: LocalObservedState
  ): Promise<void> {
    if (plan.kind !== 'note' || plan.heads.length === 0 || this.deps.revisions === undefined) return;
    for (const head of plan.heads) {
      const source = observed.sources.find((entry) => entry.path === head.path);
      if (source === undefined) continue;
      try {
        await this.deps.revisions.persistRevision(head.id, head.revision_id, source.raw);
      } catch (error) {
        throw localRecovery(`conflict head ${head.revision_id} could not be preserved`, error);
      }
    }
  }

  private async recoverOperation(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): Promise<void> {
    this.bindLegacySubordinates(record, plan);
    if (plan.kind === 'project_ensure' && plan.created) {
      const existing = this.deps.projects?.getProjectByIdentity(plan.repository_identity);
      if (existing?.provisioning?.creation_operation_id === record.operation_id &&
          existing.project.id === plan.project_id && existing.project.relative_root === plan.relative_root) {
        await this.executePlan(record, plan);
        return;
      }
    }
    if (plan.kind === 'note' && plan.effects.some((effect) => effect.kind === 'remove') &&
        this.deps.documents.hasConsolidationManifest?.(`${record.idempotency_key}:consolidate`)) {
      if (!this.preconditionsValidated(this.liveRecord(record))) {
        throw localRecovery('the in-flight consolidation has no validated-preconditions boundary');
      }
      await this.deps.documents.recover?.();
      if (this.deps.documents.getConsolidationReceipt(`${record.idempotency_key}:consolidate`) === undefined) {
        throw localRecovery('the in-flight consolidation has not verified its final document and references');
      }
      await this.executeConsolidation(record, plan);
      return;
    }
    if (plan.kind === 'note' && !plan.effects.some((effect) => effect.kind === 'remove')) {
      for (const [index, effect] of plan.effects.entries()) {
        if (effect.kind === 'move' && effect.write !== undefined &&
            this.recordedEffect(record, index + 1000) === undefined) {
          const write = this.deps.documents.getDocumentReceipt(`${record.idempotency_key}:doc:${index + 1000}`);
          if (write !== undefined) {
            this.recordEffect(record, index + 1000, {
              path: write.path, etag: write.etag, id: write.id,
              revision_id: write.revision_id, document_complete: true
            });
            this.linkSubordinate(record, index + 1000, write.operation_id);
          }
        }
        if (this.recordedEffect(record, index) !== undefined) continue;
        if (effect.kind === 'write' || effect.kind === 'adopt') {
          const stored = this.deps.documents.getDocumentReceipt(
            `${record.idempotency_key}:doc:${index}`
          );
          if (stored !== undefined) {
            this.recordEffect(record, index, {
              path: stored.path,
              etag: stored.etag,
              id: stored.id,
              revision_id: stored.revision_id,
              document_complete: true
            });
            this.linkSubordinate(record, index, stored.operation_id);
          }
          continue;
        }
        if (effect.kind === 'move') {
          const stored = this.deps.documents.getMoveReceipt(
            `${record.idempotency_key}:move:${index}`
          );
          if (stored !== undefined) {
            if (stored.to !== effect.to_path || stored.from !== effect.from_path || !stored.verified) {
              throw localRecovery(`move ${index} does not match its persisted plan`);
            }
            this.recordEffect(record, index, {
              path: stored.to,
              etag: this.originalMoveEtag(record, plan, effect, index),
              document_complete: true
            });
            this.linkSubordinate(record, index, stored.operation_id);
          }
        }
      }
    }
    const applied = Object.keys(this.readProgress(this.liveRecord(record)).effects ?? {}).length;
    if (applied === 0) {
      if (plan.kind === 'note' && plan.effects.some((effect) => effect.kind === 'move') &&
          Object.keys(this.readProgress(this.liveRecord(record)).renames ?? {}).length > 0) {
        await this.executePlan(record, plan);
        return;
      }
      try {
        await this.recheckPlan(plan);
      } catch (error) {
        if (isBrainError(error) && error.code === 'CONFLICT') {
          this.deps.operations.update(record.operation_id, {
            state: 'conflicted',
            updated_at: this.now()
          });
        }
        throw error;
      }
      if (!this.preconditionsValidated(this.liveRecord(record))) {
        const progress = this.readProgress(this.liveRecord(record));
        this.deps.operations.update(record.operation_id, {
          progress_json: JSON.stringify({ ...progress, preconditions_validated: true }),
          updated_at: this.now()
        });
      }
    } else {
      if (!this.preconditionsValidated(this.liveRecord(record)) &&
          !(plan.kind === 'note' && plan.effects.every((effect, index) =>
            this.recordedEffect(record, index)?.document_complete === true &&
            (effect.kind !== 'move' || effect.write === undefined ||
              this.recordedEffect(record, index + 1000)?.document_complete === true)))) {
        throw localRecovery('an applied effect has no durable validated-preconditions boundary');
      }
      await this.verifyPartial(record, plan);
    }
    await this.executePlan(record, plan);
  }

  private async verifyPartial(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): Promise<void> {
    const effects = this.readProgress(this.liveRecord(record)).effects ?? {};
    const allComplete = plan.kind === 'note' && plan.effects.length > 0 &&
      plan.effects.every((effect, index) => effects[String(index)]?.document_complete === true &&
        (effect.kind !== 'move' || effect.write === undefined ||
          effects[String(index + 1000)]?.document_complete === true));
    for (const [index, postcondition] of Object.entries(effects)) {
      if (plan.kind === 'note' && Number(index) < plan.effects.length &&
          plan.effects[Number(index)]?.kind === 'move' &&
          effects[String(Number(index) + 1000)] !== undefined) continue;
      if (allComplete && postcondition.document_complete === true) continue;
      const current = await this.readPathOrUndefined(postcondition.path);
      if (
        current === undefined ||
        current.etag !== postcondition.etag ||
        (postcondition.id !== undefined && current.id !== postcondition.id) ||
        (postcondition.revision_id !== undefined &&
          current.revision_id !== postcondition.revision_id)
      ) {
        throw localRecovery(`applied effect ${index} diverged from its recorded postcondition`);
      }
    }
    try {
      await this.recheckPlan(plan, {
        skipPaths: this.appliedSkipPaths(record, plan),
        appliedEffects: effects
      });
    } catch (error) {
      if (isBrainError(error) && error.code === 'CONFLICT') {
        throw localRecovery(
          'an unfinished effect precondition changed after partial application',
          error
        );
      }
      throw error;
    }
  }

  private async executePlan(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): Promise<LocalOperationReceipt> {
    const effects = this.readProgress(this.liveRecord(record)).effects ?? {};
    const completedDocument = plan.kind === 'note' && plan.effects.length > 0 &&
      plan.effects.every((effect, index) => effects[String(index)]?.document_complete === true &&
        (effect.kind !== 'move' || effect.write === undefined ||
          effects[String(index + 1000)]?.document_complete === true));
    if (!this.preconditionsValidated(this.liveRecord(record)) && !completedDocument) {
      throw localRecovery('the plan cannot execute without a durable validated-preconditions boundary');
    }
    let last: DocumentStorePutResult | undefined;
    let moveReceipt: RenameReceipt | undefined;
    if (plan.kind === 'note') {
      const removals = plan.effects.filter((effect) => effect.kind === 'remove');
      if (removals.length > 0) {
        return this.executeConsolidation(record, plan);
      }
      for (const [index, effect] of plan.effects.entries()) {
        const recorded = this.recordedEffect(record, index);
        if (recorded !== undefined) {
          if (recorded.document_complete !== true) {
            const current = await this.readPathOrUndefined(recorded.path);
            if (
              current === undefined ||
              current.etag !== recorded.etag ||
              (recorded.id !== undefined && current.id !== recorded.id) ||
              (recorded.revision_id !== undefined && current.revision_id !== recorded.revision_id)
            ) {
              throw localRecovery(`applied effect ${index} diverged from its recorded postcondition`);
            }
          }
          if (effect.kind === 'move') {
            moveReceipt = this.deps.documents.getMoveReceipt(`${record.idempotency_key}:move:${index}`);
            if (moveReceipt === undefined) {
              throw localRecovery(`move ${index} has no verified document receipt`);
            }
            if (effect.write !== undefined) {
              last = await this.applyOptionalMoveWrite(record, effect, plan, index);
            }
          } else {
            last = {
              id: recorded.id ?? '',
              path: recorded.path,
              etag: recorded.etag,
              revision_id: recorded.revision_id ?? '',
              indexed: false
            };
          }
          continue;
        }
        if (effect.kind === 'write' || effect.kind === 'adopt') {
          const put = await this.putEffect(record, effect.write, plan, index);
          last = put;
          this.recordEffect(record, index, {
            path: put.path,
            etag: put.etag,
            id: put.id,
            revision_id: put.revision_id
          });
          this.linkSubordinate(record, index, put.operation_id);
          continue;
        }
        if (effect.kind !== 'move') continue;
        moveReceipt = await this.moveEffect(record, effect, index);
        const destination = await this.readPathOrUndefined(effect.to_path);
        if (destination !== undefined) {
          this.recordEffect(record, index, {
            path: effect.to_path,
            etag: destination.etag,
            id: destination.id,
            revision_id: destination.revision_id
          });
        }
        this.linkSubordinate(record, index, moveReceipt.operation_id);
        if (effect.write !== undefined) {
          last = await this.applyOptionalMoveWrite(record, effect, plan, index);
        }
      }
    }
    const storageKey = `${record.idempotency_key}:local`;
    if (plan.kind === 'project_ensure') {
      await this.applyProjectEnsure(record, plan);
      const receipt: LocalOperationReceipt = {
        kind: 'project_ensure',
        operation_id: record.operation_id,
        repository_identity: plan.repository_identity,
        project_id: plan.project_id,
        relative_root: plan.relative_root,
        created: plan.created,
        materialized: true,
        warnings: []
      };
      this.finalize(record, receipt, storageKey);
      return receipt;
    }
    if (plan.kind === 'feedback') {
      this.deps.operations.recordFeedback({
        operation_id: record.operation_id,
        feedback_id: plan.feedback_id,
        id: plan.id,
        revision_id: plan.revision_id,
        verdict: plan.verdict,
        reason: plan.reason
      });
      const durable = this.deps.operations.getFeedbackEffect(record.operation_id);
      if (durable?.feedback_id !== plan.feedback_id || durable.id !== plan.id ||
          durable.revision_id !== plan.revision_id || durable.verdict !== plan.verdict || durable.reason !== plan.reason) {
        throw localRecovery('the feedback effect was not durably verified');
      }
      const receipt: LocalOperationReceipt = {
        kind: 'feedback', operation_id: record.operation_id, feedback_id: plan.feedback_id, recorded: true
      };
      this.finalize(record, receipt, storageKey);
      return receipt;
    }
    const targetPath = last?.path ?? moveReceipt?.to;
    if (targetPath === undefined) throw localInvalid('a note operation produced no document effect');
    const final = last ?? (await this.deps.documents.readPath(targetPath));
    const id = final.id;
    const revisionId = final.revision_id;
    if (id === undefined || revisionId === undefined) {
      throw localRecovery('a note operation did not produce a managed identity');
    }
    const receipt: LocalOperationReceipt = {
      kind: 'note',
      operation_id: record.operation_id,
      id,
      revision_id: revisionId,
      path: targetPath,
      etag: final.etag,
      indexed: last?.indexed ?? moveReceipt?.moved_indexed ?? false,
      warnings: plan.advisory_warnings ?? [],
      ...(plan.possible_duplicates === undefined ? {} : { possible_duplicates: plan.possible_duplicates })
    };
    this.finalize(record, receipt, storageKey);
    return receipt;
  }

  private async applyProjectEnsure(
    record: LocalOperationRecord,
    plan: Extract<LocalPlannedOperation, { kind: 'project_ensure' }>
  ): Promise<void> {
    const existing = this.deps.projects?.getProjectByIdentity(plan.repository_identity);
    if (!plan.created) {
      if (existing?.project.id !== plan.project_id || existing.state !== 'ready') {
        throw localConflict('the ensured project changed before receipt finalization');
      }
      return;
    }
    if (existing !== undefined &&
        (existing.project.id !== plan.project_id || existing.project.relative_root !== plan.relative_root ||
         existing.provisioning?.creation_operation_id !== record.operation_id)) {
      throw localConflict('the project identity was claimed by another operation');
    }
    if (existing === undefined) {
      if (plan.display_name === undefined || plan.created_by_actor_id === undefined ||
          this.deps.projects?.reserveProject === undefined) {
        throw localRecovery('the persisted project plan cannot be materialized');
      }
      this.deps.projects.reserveProject({
        repository_identity: plan.repository_identity,
        project_id: plan.project_id,
        display_name: plan.display_name,
        relative_root: plan.relative_root,
        backend_project: plan.project_id,
        backend_relative_root: plan.relative_root,
        created_by_actor_id: plan.created_by_actor_id,
        creation_operation_id: record.operation_id
      });
    }
    this.deps.projects?.markProjectReady?.(plan.project_id);
    const ready = this.deps.projects?.getProjectByIdentity(plan.repository_identity);
    if (ready?.state !== 'ready' || ready.project.id !== plan.project_id ||
        ready.provisioning?.creation_operation_id !== record.operation_id) {
      throw localRecovery('the planned project was not durably materialized');
    }
  }

  private async executeConsolidation(
    record: LocalOperationRecord,
    plan: Extract<LocalPlannedOperation, { kind: 'note' }>
  ): Promise<LocalOperationReceipt> {
    if (!this.preconditionsValidated(this.liveRecord(record))) {
      throw localRecovery('the consolidation has no validated-preconditions boundary');
    }
    if (record.tool !== 'brain_review' || record.action !== 'resolve') {
      throw localInvalid('remove effects are only legal inside a resolve consolidation');
    }
    const consolidationKey = `${record.idempotency_key}:consolidate`;
    const completed = this.deps.documents.getConsolidationReceipt(consolidationKey);
    if (completed !== undefined) {
      const doneReceipt: LocalOperationReceipt = {
        kind: 'note',
        operation_id: record.operation_id,
        id: completed.id,
        revision_id: completed.revision_id,
        path: completed.path,
        etag: completed.etag,
        indexed: completed.indexed,
        warnings: []
      };
      this.deps.operations.markSubordinate(record.operation_id, 0, 'complete');
      this.finalize(record, doneReceipt, consolidationKey);
      return doneReceipt;
    }
    const heads = plan.heads;
    if (heads.length < 2) throw localInvalid('a consolidation requires at least two verified heads');
    const writes = plan.effects.filter(
      (effect): effect is Extract<LocalDocumentEffect, { kind: 'write' }> => effect.kind === 'write'
    );
    if (writes.length !== 1) {
      throw localInvalid('a consolidation requires exactly one primary resolution write');
    }
    const primary = writes[0].write;
    if (primary.id !== heads[0]?.id || JSON.stringify(primary.parents) !== JSON.stringify(plan.parents)) {
      throw localInvalid('the resolution write must retain the verified identity and all parents');
    }
    const headPaths = new Set(heads.map((head) => head.path));
    if (!headPaths.has(primary.path)) {
      throw localInvalid('the resolution write must target a verified head path');
    }
    const removals = plan.effects.filter(
      (effect): effect is Extract<LocalDocumentEffect, { kind: 'remove' }> => effect.kind === 'remove'
    );
    const nonSurvivors = heads.filter((head) => head.path !== primary.path);
    if (removals.length !== nonSurvivors.length) {
      throw localInvalid('each non-surviving head requires exactly one removal effect');
    }
    if (new Set(removals.map((removal) => removal.path)).size !== removals.length) {
      throw localInvalid('a consolidation has duplicate removal paths');
    }
    for (const removal of removals) {
      const head = heads.find((entry) => entry.path === removal.path);
      if (
        head === undefined ||
        head.revision_id !== removal.expected_revision_id ||
        head.etag !== removal.expected_etag ||
        head.id !== removal.expected_id
      ) {
        throw localInvalid('a removal effect does not agree with its verified head');
      }
    }
    if (plan.parents.length !== heads.length) {
      throw localInvalid('resolution parents must equal the verified conflict heads');
    }
    for (const head of heads) {
      if (
        !plan.parents.some(
          (parent) => parent.revision_id === head.revision_id && parent.raw_hash === head.etag
        )
      ) {
        throw localInvalid('resolution parents must equal the verified conflict heads');
      }
    }
    const survivor = heads.find((head) => head.path === primary.path) as LocalConflictHead;
    const documentHeads: DocumentStoreConsolidationHead[] = [];
    for (const head of heads) {
      const observed = await this.readPathOrUndefined(head.path);
      if (observed === undefined || observed.etag !== head.etag) {
        throw localConflict(`conflict head ${head.path} changed before consolidation`);
      }
      documentHeads.push({
        path: head.path,
        id: head.id,
        revision_id: head.revision_id,
        etag: head.etag,
        raw: observed.raw,
        parents: head.parents
      });
    }
    const referenceEdits: DocumentStoreReferenceEdit[] = (plan.reference_edits ?? []).map((edit) => ({
      path: edit.path,
      expected_etag: edit.expected_etag,
      raw: edit.raw,
      ...(edit.managed === undefined ? {} : { managed: edit.managed })
    }));
    const input: DocumentStoreConsolidateInput = {
      idempotencyKey: `${record.idempotency_key}:consolidate`,
      operationId: record.operation_id,
      logicalId: primary.id,
      path: primary.path,
      raw: primary.raw,
      revisionId: primary.revision_id,
      expectedEtag: survivor.etag,
      parents: plan.parents,
      heads: documentHeads,
      removals: removals.map((removal) => ({
        path: removal.path,
        expected_id: removal.expected_id,
        expected_revision_id: removal.expected_revision_id,
        expected_etag: removal.expected_etag
      })),
      referenceEdits,
      source: record.tool
    };
    const result = await this.deps.documents.consolidate(input);
    const writeIndex = plan.effects.findIndex((effect) => effect.kind === 'write');
    if (writeIndex >= 0) {
      this.recordEffect(record, writeIndex, {
        path: result.path,
        etag: result.etag,
        id: result.id,
        revision_id: result.revision_id
      });
      this.linkSubordinate(record, writeIndex, result.operation_id);
    }
    const receipt: LocalOperationReceipt = {
      kind: 'note',
      operation_id: record.operation_id,
      id: result.id,
      revision_id: result.revision_id,
      path: result.path,
      etag: result.etag,
      indexed: result.indexed,
      warnings: []
    };
    this.deps.operations.markSubordinate(record.operation_id, 0, 'complete');
    this.finalize(record, receipt, input.idempotencyKey);
    return receipt;
  }

  private async putEffect(
    record: LocalOperationRecord,
    write: LocalPendingWrite,
    plan: LocalPlannedOperation,
    index: number,
    movedEtag?: string
  ): Promise<DocumentStorePutResult> {
    const expectedEtag = movedEtag ?? this.expectedEtagFor(write.path, plan.read_set);
    return this.deps.documents.put({
      path: write.path,
      raw: write.raw,
      expectedEtag,
      idempotencyKey: `${record.idempotency_key}:doc:${index}`,
      source: record.tool,
      revisionId: write.revision_id,
      parents: write.parents
    });
  }

  private async applyOptionalMoveWrite(
    record: LocalOperationRecord,
    effect: Extract<LocalDocumentEffect, { kind: 'move' }>,
    plan: LocalPlannedOperation,
    index: number
  ): Promise<DocumentStorePutResult> {
    if (effect.write === undefined) throw localInvalid('a move write is required');
    const stored = this.deps.documents.getDocumentReceipt(`${record.idempotency_key}:doc:${index + 1000}`);
    if (stored !== undefined) return stored;
    const expected = this.originalMoveEtag(record, plan, effect, index);
    const destination = await this.readPathOrUndefined(effect.to_path);
    if (destination?.etag !== expected) {
      throw localRecovery(`move ${index} destination changed before its optional write`);
    }
    const put = await this.putEffect(record, effect.write, plan, index + 1000,
      effect.write.path === effect.to_path ? expected : undefined);
    this.recordEffect(record, index + 1000, {
      path: put.path, etag: put.etag, id: put.id, revision_id: put.revision_id
    });
    this.linkSubordinate(record, index + 1000, put.operation_id);
    return put;
  }

  private originalMoveEtag(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation,
    effect: Extract<LocalDocumentEffect, { kind: 'move' }>,
    index: number
  ): string {
    const expected = this.expectedEtagFor(effect.from_path, plan.read_set);
    const persisted = this.storedRename(record, index)?.source_hash;
    if (effect.write === undefined && persisted !== undefined) return persisted;
    if (expected === null || (persisted !== undefined && persisted !== expected)) {
      throw localRecovery(`move ${index} changed from its original source precondition`);
    }
    return expected;
  }

  private async moveEffect(
    record: LocalOperationRecord,
    effect: Extract<LocalDocumentEffect, { kind: 'move' }>,
    index: number
  ): Promise<RenameReceipt> {
    const stored = this.storedRename(record, index);
    let renamePlan: RenamePlan;
    if (stored !== undefined) {
      renamePlan = stored;
    } else {
      const files = await collectRenameSnapshots(this.deps.vaultRoot);
      renamePlan = planRename({
        from: effect.from_path,
        to: effect.to_path,
        files,
        idempotency_key: `${record.idempotency_key}:move:${index}`
      });
      if (renamePlan.conflicts.length > 0) {
        throw localConflict(`move target ${effect.to_path} is unavailable`);
      }
      this.persistRename(record, index, renamePlan);
    }
    return this.deps.documents.applyRename(renamePlan);
  }

  private readProgress(record: LocalOperationRecord): LocalOperationProgress {
    if (record.progress_json === null) return {};
    try {
      return JSON.parse(record.progress_json) as LocalOperationProgress;
    } catch {
      return {};
    }
  }

  private liveRecord(record: LocalOperationRecord): LocalOperationRecord {
    return this.deps.operations.findById(record.operation_id) ?? record;
  }

  private recordedEffect(record: LocalOperationRecord, index: number): EffectPostcondition | undefined {
    return this.readProgress(this.liveRecord(record)).effects?.[String(index)];
  }

  private recordEffect(
    record: LocalOperationRecord,
    index: number,
    postcondition: EffectPostcondition
  ): void {
    const progress = this.readProgress(this.liveRecord(record));
    progress.effects = { ...(progress.effects ?? {}), [String(index)]: postcondition };
    this.deps.operations.update(record.operation_id, {
      progress_json: JSON.stringify(progress),
      updated_at: this.now()
    });
  }

  private appliedEffectPaths(record: LocalOperationRecord): Set<string> {
    const effects = this.readProgress(this.liveRecord(record)).effects ?? {};
    return new Set(Object.values(effects).map((effect) => effect.path));
  }

  private appliedSkipPaths(record: LocalOperationRecord, plan: LocalPlannedOperation): Set<string> {
    const effects = this.readProgress(this.liveRecord(record)).effects ?? {};
    const skip = new Set<string>();
    for (const index of Object.keys(effects)) {
      if (plan.kind !== 'note') continue;
      const effect = plan.effects[Number(index)];
      if (effect === undefined) continue;
      if (effect.kind === 'write' || effect.kind === 'adopt') skip.add(effect.write.path);
      else if (effect.kind === 'move') {
        skip.add(effect.from_path);
        skip.add(effect.to_path);
      } else skip.add(effect.path);
    }
    for (const effect of Object.values(effects)) skip.add(effect.path);
    if (plan.kind === 'note') {
      for (const [index, effect] of plan.effects.entries()) {
        if (effects[String(index)] !== undefined) continue;
        if (effect.kind === 'write' || effect.kind === 'adopt') skip.delete(effect.write.path);
        else if (effect.kind === 'move') {
          skip.delete(effect.from_path);
          skip.delete(effect.to_path);
          if (effect.write !== undefined) skip.delete(effect.write.path);
        } else skip.delete(effect.path);
      }
    }
    return skip;
  }

  private linkSubordinate(
    record: LocalOperationRecord,
    index: number,
    documentOperationId: string | undefined
  ): void {
    if (documentOperationId === undefined) return;
    this.deps.operations.setSubordinateDocumentOperation(
      record.operation_id,
      index,
      documentOperationId
    );
  }

  private storedRename(record: LocalOperationRecord, index: number): RenamePlan | undefined {
    return this.readProgress(record).renames?.[String(index)];
  }

  private persistRename(record: LocalOperationRecord, index: number, plan: RenamePlan): void {
    const progress = this.readProgress(record);
    progress.renames = { ...(progress.renames ?? {}), [String(index)]: plan };
    this.deps.operations.update(record.operation_id, {
      progress_json: JSON.stringify(progress),
      updated_at: this.now()
    });
  }

  private expectedEtagFor(path: string, readSet: LocalReadSet): string | null {
    for (const condition of readSet) {
      if (condition.kind === 'path' && condition.path === path) {
        return condition.expected.kind === 'present' ? condition.expected.etag : null;
      }
      if (
        condition.kind === 'note' &&
        condition.expected.kind === 'present' &&
        condition.expected.path === path
      ) {
        return condition.expected.etag;
      }
    }
    throw localInvalid(`the read set does not record the expected etag for ${path}`);
  }

  private finalize(
    record: LocalOperationRecord,
    receipt: LocalOperationReceipt,
    storageKey: string
  ): void {
    this.deps.operations.update(record.operation_id, {
      state: 'finalized',
      receipt_json: JSON.stringify(receipt),
      updated_at: this.now()
    });
  }

  private async readPathOrUndefined(path: string): Promise<DocumentStoreReadResult | undefined> {
    try {
      return await this.deps.documents.readPath(path);
    } catch (error) {
      if (isBrainError(error) && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  private preconditionsValidated(record: LocalOperationRecord): boolean {
    if (record.progress_json === null) return false;
    try {
      const parsed = JSON.parse(record.progress_json) as { preconditions_validated?: unknown };
      return parsed.preconditions_validated === true;
    } catch {
      return false;
    }
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
