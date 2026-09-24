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
  DocumentStoreRevisionRead
} from '../storage/document-store.js';
import type { LocalOperationJournal, LocalOperationRecord } from '../storage/journal.js';
import type { RevisionStore } from '../storage/revision-store.js';
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
  LocalRecoveryReport
} from './types.js';

const POLL_INTERVAL_MS = 20;
const UNCERTAIN_WRITE_CODES = ['BACKEND_UNAVAILABLE', 'EMBEDDINGS_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR'] as const;

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
    | { project: { id: string }; updated_at: string }
    | undefined;
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
}

function localConflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function localInvalid(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function localRecovery(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function canonicalRequest(intent: LocalOperationIntent): { hash: string; json: string } {
  const json = JSON.stringify(
    canonicalize({ tool: intent.tool, action: intent.action, payload: intent.payload })
  );
  return { hash: createHash('sha256').update(json, 'utf8').digest('hex'), json };
}

function preconditionsOf(intent: LocalOperationIntent): {
  id?: string;
  path?: string;
  target_path?: string;
} {
  const preconditions = intent.preconditions as { id?: unknown; path?: unknown; target_path?: unknown };
  return {
    ...(typeof preconditions.id === 'string' ? { id: preconditions.id } : {}),
    ...(typeof preconditions.path === 'string' ? { path: preconditions.path } : {}),
    ...(typeof preconditions.target_path === 'string' ? { target_path: preconditions.target_path } : {})
  };
}

export class LocalMutationCoordinator implements LocalMutationCoordinatorPort {
  private readonly deps: LocalMutationCoordinatorDeps;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: LocalMutationCoordinatorDeps) {
    this.deps = deps;
  }

  run(intent: LocalOperationIntent, plan: LocalOperationPlan): Promise<LocalOperationReceipt> {
    return this.withLock(() => this.runSerialized(intent, plan));
  }

  status(operation_id: string): LocalOperationStatus | undefined {
    const record = this.deps.operations.findById(operation_id);
    if (record === undefined) return undefined;
    const status: LocalOperationStatus = {
      operation_id: record.operation_id,
      tool: record.tool,
      action: record.action,
      project_id: record.project_id,
      state: record.state
    };
    if (record.receipt_json !== null) {
      status.receipt = JSON.parse(record.receipt_json) as LocalOperationReceipt;
    }
    return status;
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
        if (record.plan_json === null) {
          this.deps.operations.update(record.operation_id, {
            state: 'recovery_required',
            updated_at: this.now()
          });
          blocking.push(record.operation_id);
          stillPending += 1;
          continue;
        }
        const plan = JSON.parse(record.plan_json) as LocalPlannedOperation;
        try {
          await this.executePlan(record, plan);
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

  private async runSerialized(
    intent: LocalOperationIntent,
    plan: LocalOperationPlan
  ): Promise<LocalOperationReceipt> {
    const request = canonicalRequest(intent);
    const existing = this.deps.operations.findByKey(intent.idempotency_key);
    if (existing !== undefined) return this.replay(intent, existing, request.hash);
    const now = this.now();
    const reserved = this.deps.operations.reserve({
      operation_id: this.deps.ids.next(),
      idempotency_key: intent.idempotency_key,
      tool: intent.tool,
      action: intent.action,
      project_id: intent.project_id,
      payload_hash: request.hash,
      payload_json: request.json,
      created_at: now,
      updated_at: now
    });
    if (reserved.kind === 'replay') return this.replay(intent, reserved.record, request.hash);
    const record = reserved.record;
    const observed = await this.observe(intent);
    const identity = this.allocate(record, intent, observed);
    const planned = await plan(identity, observed);
    this.assertPlanReadSet(planned);
    this.deps.operations.update(record.operation_id, {
      plan_json: JSON.stringify(planned),
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
    return this.executePlan(record, planned);
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
    return this.executePlan(record, plan);
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
      const matches = this.observedEntries(preconditions.id);
      for (const match of matches) {
        await read(match.path);
        heads.push({
          id: preconditions.id,
          path: match.path,
          revision_id: match.revision_id ?? match.hash,
          etag: match.etag,
          parents: []
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
        } else {
          if (!coversPath(effect.from_path) || !coversPath(effect.to_path)) {
            throw localInvalid(
              `the read set does not cover the move ${effect.from_path} -> ${effect.to_path}`
            );
          }
        }
      }
      if (
        plan.heads.length > 0 &&
        !readSet.some(
          (condition) => condition.kind === 'heads' && condition.id === plan.heads[0].id
        )
      ) {
        throw localInvalid('a conflict-resolution plan must persist its expected conflict heads');
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

  private async recheckPlan(plan: LocalPlannedOperation): Promise<void> {
    for (const condition of plan.read_set) {
      if (condition.kind === 'path') {
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
        const matches = this.deps.catalogue.all().filter((entry) => entry.id === condition.id);
        const expected = condition.expected;
        if (expected.kind === 'absent') {
          if (matches.length > 0) throw localConflict(`note ${condition.id} already exists`);
          continue;
        }
        const match = matches.find((entry) => entry.path === expected.path);
        if (
          match === undefined ||
          match.etag !== expected.etag ||
          (match.revision_id ?? match.hash) !== expected.revision_id
        ) {
          throw localConflict(`note ${condition.id} changed since the operation was planned`);
        }
        continue;
      }
      if (condition.kind === 'heads') {
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
    return this.observedEntries(id).map((entry) => ({
      id,
      path: entry.path,
      revision_id: entry.revision_id ?? entry.hash,
      etag: entry.etag,
      parents: []
    }));
  }

  private observedEntries(id: string): LocalObservedCatalogueEntry[] {
    const byPath = new Map<string, LocalObservedCatalogueEntry>();
    for (const entry of this.deps.catalogue.all()) {
      if (entry.id === id) byPath.set(entry.path, entry);
    }
    for (const entry of this.deps.catalogue.conflictsFor?.(id) ?? []) {
      byPath.set(entry.path, entry);
    }
    return [...byPath.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
  }

  async verifyConflictHeads(id: string, expected: readonly LocalExpectedHead[]): Promise<void> {
    const expectedIds = new Set<string>();
    for (const head of expected) {
      if (expectedIds.has(head.revision_id)) {
        throw localConflict('the expected conflict heads contain a duplicate revision');
      }
      expectedIds.add(head.revision_id);
    }
    const matches = this.observedEntries(id);
    if (matches.length !== expected.length) {
      throw localConflict(`note ${id} does not have the exact complete set of conflict heads`);
    }
    const etags = new Map<string, string>();
    for (const match of matches) {
      const revisionId = match.revision_id ?? match.hash;
      if (etags.has(revisionId)) {
        throw localConflict(`note ${id} has a duplicate conflict revision`);
      }
      etags.set(revisionId, match.etag);
    }
    if (matches.length > 1) {
      const uniqueEtags = new Set(matches.map((match) => match.etag));
      if (uniqueEtags.size !== matches.length) {
        throw localConflict(`note ${id} has a copied duplicate id, which is an identity conflict`);
      }
    }
    for (const head of expected) {
      const actual = etags.get(head.revision_id);
      if (actual === undefined) {
        throw localConflict(`expected conflict head ${head.revision_id} is missing`);
      }
      if (actual !== head.etag) {
        throw localConflict(`expected conflict head ${head.revision_id} is stale`);
      }
    }
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

  private async executePlan(
    record: LocalOperationRecord,
    plan: LocalPlannedOperation
  ): Promise<LocalOperationReceipt> {
    let last: DocumentStorePutResult | undefined;
    let moveReceipt: RenameReceipt | undefined;
    if (plan.kind === 'note') {
      for (const [index, effect] of plan.effects.entries()) {
        if (effect.kind === 'write' || effect.kind === 'adopt') {
          last = await this.putEffect(record, effect.write, plan, index);
          continue;
        }
        moveReceipt = await this.moveEffect(record, effect, index);
        if (effect.write !== undefined) {
          last = await this.putEffect(record, effect.write, plan, index + 1000);
        }
      }
    }
    const storageKey = `${record.idempotency_key}:local`;
    if (plan.kind === 'project_ensure') {
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
      const receipt: LocalOperationReceipt = {
        kind: 'feedback',
        operation_id: record.operation_id,
        feedback_id: plan.feedback_id,
        recorded: true
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
      indexed: last?.indexed ?? (moveReceipt !== undefined && moveReceipt.indexed.length > 0),
      warnings: []
    };
    this.finalize(record, receipt, storageKey);
    return receipt;
  }

  private async putEffect(
    record: LocalOperationRecord,
    write: LocalPendingWrite,
    plan: LocalPlannedOperation,
    index: number
  ): Promise<DocumentStorePutResult> {
    const expectedEtag = this.expectedEtagFor(write.path, plan.read_set);
    return this.deps.documents.put({
      path: write.path,
      raw: write.raw,
      expectedEtag,
      idempotencyKey: `${record.idempotency_key}:doc:${index}`,
      source: record.tool
    });
  }

  private async moveEffect(
    record: LocalOperationRecord,
    effect: Extract<LocalDocumentEffect, { kind: 'move' }>,
    index: number
  ): Promise<RenameReceipt> {
    const files = await collectRenameSnapshots(this.deps.vaultRoot);
    const renamePlan = planRename({
      from: effect.from_path,
      to: effect.to_path,
      files,
      idempotency_key: `${record.idempotency_key}:move:${index}`
    });
    if (renamePlan.conflicts.length > 0) {
      throw localConflict(`move target ${effect.to_path} is unavailable`);
    }
    return this.deps.documents.applyRename(renamePlan);
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
      storage_key: storageKey,
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

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
