import { BrainError } from '../contracts/errors.js';
import type { BrainDeps } from '../core/mutation.js';
import type {
  ReconcileFinding,
  ReconcileReport,
  ScopeConfig
} from '../core/types.js';
import type { OperationRecord } from '../storage/journal.js';
import {
  planSchemaMigration,
  type SchemaMigrationPlan,
  type SchemaVersionRegistry
} from './codec.js';
import type { ApprovalProvenance, ApprovalProvenanceInput } from './catalogue.js';
import type { CurrentCatalogue, ReconcileCurrentVaultReport } from './current-catalogue.js';

export {
  CURRENT_VAULT_DEBOUNCE_MS,
  CURRENT_VAULT_RESCAN_INTERVAL_MS,
  CurrentCatalogue,
  matchCurrentIdentity,
  observeCurrentVault,
  readCurrentSource,
  reconcileCurrentVault
} from './current-catalogue.js';
export type {
  CurrentCatalogueOptions,
  CurrentHistory,
  CurrentIdentity,
  CurrentIndexEntry,
  CurrentIdentityMatch,
  CurrentSource,
  CurrentSourceLookup,
  CurrentVault,
  CurrentVaultChange,
  CurrentVaultDuplicate,
  CurrentVaultMalformed,
  CurrentVaultMove,
  CurrentVaultObserver,
  CurrentVaultRemoval,
  CurrentVaultUnresolvedLink,
  ObserveCurrentVaultOptions,
  ReadCurrentSourceInput,
  ReconcileCurrentVaultInput,
  ReconcileCurrentVaultReport
} from './current-catalogue.js';

export interface ReconcileOptions {
  detailed?: boolean;
}

export interface SearchIndexSink {
  upsert(entry: {
    path: string;
    raw: string;
    etag: string;
    id?: string;
    revision_id?: string;
  }): void;
  remove?(path: string): void;
  paths?(): string[];
  identities?(): { path: string; id: string | null; etag: string }[];
}

export interface IndexReconciledDocumentsInput {
  catalogue: Pick<CurrentCatalogue, 'all' | 'rawFor' | 'getByPath'>;
  index: SearchIndexSink;
  report: ReconcileCurrentVaultReport;
}

export function indexReconciledDocuments(input: IndexReconciledDocumentsInput): void {
  const { catalogue, index, report } = input;
  const protectedPaths = new Set<string>();
  for (const malformed of report.malformed) protectedPaths.add(malformed.path);
  for (const duplicate of report.duplicate_ids) {
    for (const path of duplicate.paths) protectedPaths.add(path);
  }
  const indexed = index.identities?.() ?? [];
  const byId = new Map(
    indexed.filter((entry) => entry.id !== null).map((entry) => [entry.id, entry.path])
  );
  const byPath = new Map(indexed.map((entry) => [entry.path, entry]));
  const paths = new Set<string>();
  for (const source of report.added) paths.add(source.path);
  for (const change of report.changed) paths.add(change.path);
  for (const moved of report.moved) paths.add(moved.to);
  if (report.complete && index.identities !== undefined) {
    for (const source of catalogue.all()) {
      const current = byPath.get(source.path);
      if (current === undefined || current.etag !== source.etag || current.id !== (source.id ?? null)) {
        paths.add(source.path);
      }
    }
  }
  const blocked = new Set<string>();
  for (const path of paths) {
    const source = catalogue.getByPath(path);
    if (source === undefined) continue;
    const priorPath = source.id === undefined ? undefined : byId.get(source.id);
    const priorId = byPath.get(path)?.id;
    const collides = priorPath !== undefined && priorPath !== path;
    const changesIdentity = priorId !== undefined && priorId !== (source.id ?? null);
    if (
      protectedPaths.has(path) ||
      (collides && (!report.complete || protectedPaths.has(priorPath))) ||
      (!report.complete && changesIdentity)
    ) {
      blocked.add(path);
      if (collides && source.id !== undefined && !report.duplicate_ids.some((item) => item.id === source.id)) {
        const conflict = { id: source.id, paths: [priorPath, path].sort() };
        report.duplicate_ids.push(conflict);
        for (const conflictPath of conflict.paths) protectedPaths.add(conflictPath);
      }
      if (!report.complete && changesIdentity && !report.identity_conflicts?.some((item) => item.paths.includes(path))) {
        report.identity_conflicts ??= [];
        report.identity_conflicts.push({ id: source.id ?? priorId ?? path, paths: [path] });
      }
    }
  }
  const destructive = report.complete;
  if (destructive) {
    for (const moved of report.moved) {
      if (!protectedPaths.has(moved.from) && !blocked.has(moved.to)) index.remove?.(moved.from);
    }
  }
  for (const path of paths) {
    if (blocked.has(path)) continue;
    const raw = catalogue.rawFor(path);
    const source = catalogue.getByPath(path);
    if (raw === undefined || source === undefined) continue;
    index.upsert({
      path,
      raw,
      etag: source.etag,
      ...(source.id === undefined ? {} : { id: source.id }),
      ...(source.revision_id === undefined ? {} : { revision_id: source.revision_id })
    });
  }
  if (!destructive) return;
  for (const removed of report.removed) {
    if (!protectedPaths.has(removed.path)) index.remove?.(removed.path);
  }
  if (typeof index.paths !== 'function') return;
  const live = new Set(catalogue.all().map((source) => source.path));
  for (const path of protectedPaths) live.add(path);
  for (const indexed of index.paths()) {
    if (!live.has(indexed)) index.remove?.(indexed);
  }
}

export type { ReconcileFinding, ReconcileReport, ReconcileScopeReport } from '../core/types.js';

interface ApprovalJournal {
  get(operation_id: string): OperationRecord | undefined;
  getApprovalProvenance(operation_id: string): {
    operation_id: string;
    scope: string;
    logical_id: string;
    revision_id: string;
    principal_id: string;
    payload_hash: string;
  } | undefined;
}

interface PlannedApprovalRecord {
  id?: unknown;
  revision_id?: unknown;
  scope?: unknown;
  operation_id?: unknown;
  approval?: unknown;
}

export class JournalApprovalProvenance implements ApprovalProvenance {
  private readonly journal: ApprovalJournal;

  constructor(journal: ApprovalJournal) {
    this.journal = journal;
  }

  verify(input: ApprovalProvenanceInput): boolean {
    const durable = this.journal.getApprovalProvenance(input.operation_id);
    if (durable !== undefined) {
      return (
        durable.scope === input.scope &&
        durable.logical_id === input.id &&
        durable.revision_id === input.revision_id &&
        durable.principal_id === input.principal_id &&
        durable.payload_hash === input.payload_hash
      );
    }
    const record = this.journal.get(input.operation_id);
    if (record === undefined || record.scope !== input.scope) return false;
    if (record.plan_json === undefined) return false;
    let plan: { revision?: unknown };
    try {
      plan = JSON.parse(record.plan_json) as { revision?: unknown };
    } catch {
      return false;
    }
    const revision = plan.revision;
    if (revision === null || typeof revision !== 'object') return false;
    const planned = revision as PlannedApprovalRecord;
    if (
      planned.id !== input.id ||
      planned.revision_id !== input.revision_id ||
      planned.scope !== input.scope ||
      planned.operation_id !== input.operation_id
    ) {
      return false;
    }
    const approval = planned.approval;
    if (approval === null || typeof approval !== 'object') return false;
    const fields = approval as { principal_id?: unknown; payload_hash?: unknown };
    return (
      fields.principal_id === input.principal_id && fields.payload_hash === input.payload_hash
    );
  }
}

function selectScopes(deps: BrainDeps, scope: string | undefined): ScopeConfig[] {
  if (scope === undefined) return deps.scopeRegistry.all();
  const match = deps.scopeRegistry.get(scope);
  if (match === undefined) {
    throw new BrainError({
      code: 'INVALID_INPUT',
      message: `scope ${scope} is not configured for reconciliation`
    });
  }
  return [match];
}

function idsFor(
  findings: ReconcileFinding[],
  state: ReconcileFinding['state']
): string[] {
  const ids: string[] = [];
  for (const finding of findings) {
    if (finding.state !== state || finding.id === undefined) continue;
    if (!ids.includes(finding.id)) ids.push(finding.id);
  }
  return ids;
}

export async function reconcileVault(
  deps: BrainDeps,
  scope?: string,
  options: ReconcileOptions = {}
): Promise<ReconcileReport> {
  const scopes = selectScopes(deps, scope);
  const report: ReconcileReport = {
    scopes: [],
    scanned: 0,
    updated: 0,
    unmanaged: 0,
    malformed: 0,
    conflicted: 0,
    manual_unreviewed: 0,
    unsupported_schema: 0
  };
  const findings: ReconcileFinding[] = [];
  for (const config of scopes) {
    const scoped = await deps.catalogue.reconcileReport(config.id);
    report.scopes.push(config.id);
    report.scanned += scoped.scanned;
    report.updated += scoped.updated;
    report.unmanaged += scoped.unmanaged;
    report.malformed += scoped.malformed;
    report.conflicted += scoped.conflicted;
    report.manual_unreviewed += scoped.manual_unreviewed;
    report.unsupported_schema += scoped.unsupported_schema;
    findings.push(...scoped.findings);
  }
  if (options.detailed === true) {
    report.findings = findings;
    report.ids = {
      malformed: idsFor(findings, 'malformed'),
      conflicted: idsFor(findings, 'conflict'),
      manual_unreviewed: idsFor(findings, 'manual_unreviewed'),
      unsupported_schema: idsFor(findings, 'unsupported_schema')
    };
  }
  return report;
}

export interface MigrateSchemaRequest {
  relative_path: string;
  revision_id: string;
  operation_id: string;
  timestamp?: string;
  registry?: SchemaVersionRegistry;
}

export interface MigrateSchemaResult {
  plan: SchemaMigrationPlan;
  materialized: { permalink: string; relative_path?: string };
}

export async function migrateSchemaRevision(
  deps: BrainDeps,
  scope: string,
  request: MigrateSchemaRequest
): Promise<MigrateSchemaResult> {
  const config = selectScopes(deps, scope)[0];
  const read = await deps.vault.read(config.id, request.relative_path);
  const plan = planSchemaMigration({
    raw: read.raw,
    scope: config,
    revision_id: request.revision_id,
    operation_id: request.operation_id,
    timestamp: request.timestamp ?? deps.clock.now().toISOString(),
    ...(request.registry === undefined ? {} : { registry: request.registry })
  });
  const materialized = await deps.mutations.serialize(() =>
    deps.backend.create(plan.planned_write)
  );
  return { plan, materialized };
}
