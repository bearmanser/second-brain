import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { MATERIALIZATION_TIMEOUT_MS } from './limits.js';
import type {
  BackendPort,
  CataloguePort,
  Clock,
  Head,
  IdSource,
  MutationReceipt,
  PlannedWrite,
  Principal,
  RequestContext,
  ScopeConfig,
  StoredRevision,
  VaultPort
} from './types.js';
import type { BrainConfig } from '../config/schema.js';
import { decodeRevision, encodeRevision, makeEtag } from '../notes/codec.js';
import { slugify } from '../notes/identity.js';
import { resolveScopes } from '../security/authorise.js';
import type {
  Journal,
  OperationRecord,
  OperationReservation,
  OperationState,
  ReceiptAvailability,
  ReservationResult
} from '../storage/journal.js';

const POLL_INTERVAL_MS = 20;

export interface ExpectedHead {
  id: string;
  revision_id?: string;
  etag: string;
}

export interface MutationIntent {
  tool: string;
  scope: string;
  idempotency_key: string;
  payload: unknown;
  expected_heads: ExpectedHead[];
}

export interface AllocatedIdentity {
  operation_id: string;
  note_id: string;
  revision_id: string;
  timestamp: string;
}

export type RevisionBuilder = (identities: AllocatedIdentity, heads: Head[]) => StoredRevision;

export interface MutationJournal {
  reserve(input: OperationReservation): ReservationResult;
  savePlan(id: string, plan: PlannedWrite): void;
  mark(id: string, state: OperationState, receipt?: MutationReceipt): void;
  get(id: string): OperationRecord | undefined;
  pending(): OperationRecord[];
  refreshReceiptAvailability(id: string, availability: ReceiptAvailability): OperationRecord;
}

export interface BrainDeps {
  config: BrainConfig;
  backend: BackendPort;
  vault: VaultPort;
  catalogue: CataloguePort;
  journal: Journal;
  clock: Clock;
  ids: IdSource;
  mutations: MutationCoordinator;
}

export interface MutationDeps {
  config: BrainConfig;
  backend: BackendPort;
  vault: VaultPort;
  catalogue: CataloguePort;
  journal: MutationJournal;
  clock: Clock;
  ids: IdSource;
}

interface LocatedMaterialization {
  raw: string;
  raw_hash: string;
  relative_path: string;
}

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

function payloadDigest(payload: unknown): { payload_hash: string; payload_json: string } {
  let json: string;
  try {
    json = JSON.stringify(canonicalize(payload));
  } catch (cause) {
    throw invalidInput('mutation payload is not serializable', cause);
  }
  if (json === undefined) throw invalidInput('mutation payload is not serializable');
  return { payload_hash: createHash('sha256').update(json, 'utf8').digest('hex'), payload_json: json };
}

function parseReceipt(json: string, operation_id: string): MutationReceipt {
  try {
    return JSON.parse(json) as MutationReceipt;
  } catch (cause) {
    throw recoveryRequired(`operation ${operation_id} has an unreadable receipt`, operation_id, cause);
  }
}

function pendingReceipt(operation_id: string, plan: PlannedWrite): MutationReceipt {
  return {
    operation_id,
    id: plan.revision.id,
    revision_id: plan.revision.revision_id,
    outcome: 'pending',
    materialized: false,
    indexed: false,
    possible_duplicates: [],
    warnings: ['materialization_unconfirmed']
  };
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
  private released = false;

  private constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  static acquire(stateDir: string, name = 'gateway.lock'): InstanceLock {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        return new InstanceLock(lockPath);
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
    let raw: string;
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch {
      return false;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
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

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      unlinkSync(this.lockPath);
    } catch {
      return;
    }
  }
}

export class MutationCoordinator {
  private readonly deps: MutationDeps;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: MutationDeps) {
    this.deps = deps;
  }

  async commit(
    ctx: RequestContext,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    return this.withLock(() => this.commitSerialized(ctx, intent, build));
  }

  async recover(): Promise<void> {
    await this.withLock(async () => {
      for (const record of this.deps.journal.pending()) {
        try {
          await this.recoverRecord(record);
        } catch {
          continue;
        }
      }
    });
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
    ctx: RequestContext,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    const scope = this.authorize(ctx.principal, intent.scope);
    if (ctx.signal.aborted) throw cancelled();
    const digest = payloadDigest(intent.payload);
    const reservation: OperationReservation = {
      principal_id: ctx.principal.id,
      idempotency_key: intent.idempotency_key,
      tool: intent.tool,
      scope: scope.id,
      payload_hash: digest.payload_hash,
      payload_json: digest.payload_json
    };
    const reserved = this.deps.journal.reserve(reservation);
    return this.drive(ctx, scope, reserved, intent, build);
  }

  private authorize(principal: Principal, requested: string): ScopeConfig {
    const [scope] = resolveScopes(principal, requested, false, 'write', this.deps.config.scopes);
    return scope;
  }

  private async drive(
    ctx: RequestContext,
    scope: ScopeConfig,
    reserved: ReservationResult,
    intent: MutationIntent,
    build: RevisionBuilder
  ): Promise<MutationReceipt> {
    const { record } = reserved;
    if (reserved.kind === 'replay') {
      if (record.receipt_json && (record.state === 'complete' || record.state === 'conflict')) {
        return parseReceipt(record.receipt_json, record.operation_id);
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
      const located = await this.locate(scope, persisted);
      if (located !== undefined) return this.finalize(scope, persisted, located, record.operation_id);
      if (record.state === 'materialized') {
        this.markConflict(record.operation_id);
        throw conflict('operation was marked materialized but its file is absent', record.operation_id);
      }
      if (record.state === 'submitted') {
        return this.submit(ctx, scope, persisted, record.operation_id);
      }
    }

    await this.deps.catalogue.reconcile(scope.id);
    const heads = await this.verifyExpectedHeads(scope, intent.expected_heads, record.operation_id);

    let plan = persisted;
    if (plan === undefined) {
      const identities = this.allocate(record.operation_id, intent);
      const revision = this.buildRevision(build, identities, heads, scope);
      plan = encodeRevision(revision, scope);
      this.deps.journal.savePlan(record.operation_id, plan);
    }

    if (ctx.signal.aborted) return this.pending(record.operation_id, plan);
    this.deps.journal.mark(record.operation_id, 'submitted', pendingReceipt(record.operation_id, plan));
    return this.submit(ctx, scope, plan, record.operation_id);
  }

  private allocate(operation_id: string, intent: MutationIntent): AllocatedIdentity {
    const targets = [...new Set(intent.expected_heads.map((head) => head.id))];
    if (targets.length > 1) {
      throw invalidInput('a mutation may target only one logical note');
    }
    const note_id = targets[0] ?? this.deps.ids.next();
    return {
      operation_id,
      note_id,
      revision_id: this.deps.ids.next(),
      timestamp: this.deps.clock.now().toISOString()
    };
  }

  private buildRevision(
    build: RevisionBuilder,
    identities: AllocatedIdentity,
    heads: Head[],
    scope: ScopeConfig
  ): StoredRevision {
    let revision: StoredRevision;
    try {
      revision = build(identities, heads);
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
    ctx: RequestContext,
    scope: ScopeConfig,
    plan: PlannedWrite,
    operation_id: string
  ): Promise<MutationReceipt> {
    if (ctx.signal.aborted) return this.pending(operation_id, plan);
    try {
      await this.deps.backend.create(plan);
    } catch (error) {
      if (isBrainError(error) && error.code === 'CONFLICT') {
        const located = await this.locate(scope, plan);
        if (located === undefined) {
          this.markConflict(operation_id);
          throw conflict('backend rejected a create that had no materialised file', operation_id);
        }
        return this.finalize(scope, plan, located, operation_id);
      }
    }
    const located = await this.awaitMaterialization(scope, plan);
    if (located === undefined) return this.pending(operation_id, plan);
    return this.finalize(scope, plan, located, operation_id);
  }

  private async awaitMaterialization(
    scope: ScopeConfig,
    plan: PlannedWrite
  ): Promise<LocatedMaterialization | undefined> {
    const timeout = this.deps.config.limits.materialization_timeout_ms ?? MATERIALIZATION_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      const located = await this.locate(scope, plan);
      if (located !== undefined) return located;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await delay(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  private async locate(scope: ScopeConfig, plan: PlannedWrite): Promise<LocatedMaterialization | undefined> {
    const expected = expectedRelativePath(scope, plan);
    const direct = await this.readMaterialized(scope, expected, plan);
    if (direct !== undefined) return direct;
    let paths: string[];
    try {
      paths = await this.deps.vault.list(scope.id);
    } catch {
      return undefined;
    }
    for (const path of paths) {
      if (path === expected) continue;
      const found = await this.readMaterialized(scope, path, plan);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private async readMaterialized(
    scope: ScopeConfig,
    relativePath: string,
    plan: PlannedWrite
  ): Promise<LocatedMaterialization | undefined> {
    let read: { raw: string; raw_hash: string; relative_path: string };
    try {
      read = await this.deps.vault.read(scope.id, relativePath);
    } catch {
      return undefined;
    }
    let revision: StoredRevision;
    try {
      revision = decodeRevision(read.raw);
    } catch {
      return undefined;
    }
    if (revision.revision_id !== plan.revision.revision_id) return undefined;
    if (revision.operation_id !== plan.revision.operation_id) return undefined;
    return { raw: read.raw, raw_hash: read.raw_hash, relative_path: read.relative_path };
  }

  private async finalize(
    scope: ScopeConfig,
    plan: PlannedWrite,
    located: LocatedMaterialization,
    operation_id: string
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

    const indexed = await this.checkIndex(scope, plan.revision.revision_id, warnings);
    const receipt: MutationReceipt = {
      operation_id,
      id: plan.revision.id,
      revision_id: plan.revision.revision_id,
      outcome: conflicted ? 'stored_conflict' : 'stored',
      materialized: true,
      indexed,
      etag: makeEtag(plan.revision.revision_id, located.raw_hash),
      possible_duplicates: [],
      warnings
    };

    try {
      this.deps.journal.mark(operation_id, conflicted ? 'conflict' : 'complete', receipt);
    } catch {
      const refreshed = this.deps.journal.get(operation_id);
      if (refreshed?.receipt_json !== undefined) {
        const stored = parseReceipt(refreshed.receipt_json, operation_id);
        if (stored.outcome !== 'pending') return stored;
      }
    }
    return receipt;
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

  private pending(operation_id: string, plan: PlannedWrite): MutationReceipt {
    const record = this.deps.journal.get(operation_id);
    if (record?.receipt_json !== undefined) {
      const stored = parseReceipt(record.receipt_json, operation_id);
      if (stored.outcome === 'pending') return stored;
    }
    return pendingReceipt(operation_id, plan);
  }

  private markConflict(operation_id: string): void {
    const record = this.deps.journal.get(operation_id);
    if (record === undefined) return;
    if (record.state === 'conflict' || record.state === 'complete' || record.state === 'failed') return;
    this.deps.journal.mark(operation_id, 'conflict');
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

  private async recoverRecord(record: OperationRecord): Promise<void> {
    if (record.state === 'prepared') return;
    const plan = this.loadPlan(record);
    if (plan === undefined) return;
    const scope = this.deps.config.scopes.find((candidate) => candidate.id === record.scope);
    if (scope === undefined) return;
    const located = await this.locate(scope, plan);
    if (located === undefined) return;
    await this.finalize(scope, plan, located, record.operation_id);
  }
}
