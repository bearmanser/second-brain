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

export interface ReconcileOptions {
  detailed?: boolean;
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
