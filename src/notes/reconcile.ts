import { BrainError } from '../contracts/errors.js';
import type { BrainDeps } from '../core/mutation.js';
import type {
  Principal,
  ReconcileFinding,
  ReconcileReport,
  ScopeConfig
} from '../core/types.js';
import type { OperationRecord } from '../storage/journal.js';
import type { ApprovalProvenance, ApprovalProvenanceInput } from './catalogue.js';

export interface ReconcileOptions {
  detailed?: boolean;
  principal?: Principal;
}

export type { ReconcileFinding, ReconcileReport, ReconcileScopeReport } from '../core/types.js';

interface ApprovalJournal {
  get(operation_id: string): OperationRecord | undefined;
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
  if (scope === undefined) return [...deps.config.scopes];
  const matches = deps.config.scopes.filter(
    (candidate) => candidate.id === scope || candidate.repository_aliases.includes(scope)
  );
  const unique = matches.filter((candidate, index) => matches.indexOf(candidate) === index);
  if (unique.length === 0) {
    throw new BrainError({
      code: 'FORBIDDEN',
      message: `scope ${scope} is not configured for reconciliation`
    });
  }
  if (unique.length > 1) {
    throw new BrainError({
      code: 'INVALID_INPUT',
      message: `scope ${scope} is ambiguous for reconciliation`
    });
  }
  return unique;
}

function authorized(findings: ReconcileFinding[], principal: Principal | undefined): ReconcileFinding[] {
  if (principal === undefined) return findings;
  const readable = new Set(principal.read_scopes);
  return findings.filter((finding) => readable.has(finding.scope));
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
    const visible = authorized(findings, options.principal);
    report.findings = visible;
    report.ids = {
      malformed: idsFor(visible, 'malformed'),
      conflicted: idsFor(visible, 'conflict'),
      manual_unreviewed: idsFor(visible, 'manual_unreviewed'),
      unsupported_schema: idsFor(visible, 'unsupported_schema')
    };
  }
  return report;
}
