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
import { decodeRevision, encodeRevision, makeEtag, payloadHash } from '../notes/codec.js';
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
const UNCERTAIN_WRITE_CODES = ['BACKEND_UNAVAILABLE', 'EMBEDDINGS_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR'] as const;

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
        return this.refreshTerminalReceipt(scope, parseReceipt(record.receipt_json, record.operation_id));
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
          return this.finalize(scope, persisted, wait.matches, record.operation_id);
        }
        if (wait.kind === 'absent') {
          return this.submit(ctx, scope, persisted, record.operation_id);
        }
        return this.pending(record.operation_id, persisted);
      }
      if (record.state === 'materialized') {
        const wait = await this.awaitMaterialization(scope, persisted);
        if (wait.kind === 'matched') {
          return this.finalize(scope, persisted, wait.matches, record.operation_id);
        }
        if (wait.kind === 'absent') {
          this.markConflict(record.operation_id);
          throw conflict('operation was marked materialized but its file is absent', record.operation_id);
        }
        return this.pending(record.operation_id, persisted);
      }
      if (record.state !== 'prepared') {
        throw recoveryRequired(`operation is stuck in state ${record.state}`, record.operation_id);
      }
    }

    await this.deps.catalogue.reconcile(scope.id);
    const heads = await this.verifyExpectedHeads(scope, intent.expected_heads, record.operation_id);

    let plan = persisted;
    if (plan === undefined) {
      const identities = this.deriveIdentity(record, intent);
      const revision = this.buildRevision(build, identities, heads, scope);
      plan = encodeRevision(revision, scope);
      this.deps.journal.savePlan(record.operation_id, plan);
    }

    if (ctx.signal.aborted) return this.pending(record.operation_id, plan);
    this.deps.journal.mark(record.operation_id, 'submitted', pendingReceipt(record.operation_id, plan));
    return this.submit(ctx, scope, plan, record.operation_id);
  }

  private deriveIdentity(record: OperationRecord, intent: MutationIntent): AllocatedIdentity {
    const targets = [...new Set(intent.expected_heads.map((head) => head.id))];
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
        const scan = await this.scanMaterializations(scope, plan);
        if (scan.kind === 'inconclusive') return this.pending(operation_id, plan);
        if (scan.matches.length > 0) return this.finalize(scope, plan, scan.matches, operation_id);
        this.markConflict(operation_id);
        throw conflict('backend rejected a create that had no materialised file', operation_id);
      }
      if (!isUncertainWrite(error)) throw error;
      const wait = await this.awaitMaterialization(scope, plan);
      if (wait.kind === 'matched') return this.finalize(scope, plan, wait.matches, operation_id);
      return this.pending(operation_id, plan);
    }
    const wait = await this.awaitMaterialization(scope, plan);
    if (wait.kind === 'matched') return this.finalize(scope, plan, wait.matches, operation_id);
    return this.pending(operation_id, plan);
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
      if (path === expected) continue;
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
    const receipt: MutationReceipt = {
      operation_id,
      id: plan.revision.id,
      revision_id: plan.revision.revision_id,
      outcome: conflicted ? 'stored_conflict' : 'stored',
      materialized: true,
      indexed,
      etag: makeEtag(plan.revision.revision_id, confirmed.raw_hash),
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
    const scan = await this.scanMaterializations(scope, plan);
    if (scan.kind !== 'conclusive' || scan.matches.length === 0) return;
    await this.finalize(scope, plan, scan.matches, record.operation_id);
  }
}
