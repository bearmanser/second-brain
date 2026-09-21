import { createHash } from 'node:crypto';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { projectEnsureRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps, MutationDeps, RecoveryOperationReport } from '../core/mutation.js';
import type {
  DynamicProjectGrant,
  Principal,
  ProjectEnsureRequest,
  ProjectEnsureResult,
  ProjectProvisioningPlan,
  RepositoryProjectRecord,
  RequestContext,
  ScopeConfig
} from '../core/types.js';
import {
  normalizeRepositoryIdentity,
  scopeCandidateForRepository,
  scopeWithCollisionSuffix
} from '../projects/identity.js';
import type { OperationRecord } from '../storage/journal.js';

const TOOL = 'brain_project_ensure';
const WINDOW_MS = 60_000;

interface LimitEvent {
  at: number;
  key: string;
}
interface LimitState {
  principal: Map<string, LimitEvent[]>;
  global: LimitEvent[];
}
const limits = new WeakMap<object, LimitState>();

const failure = (
  code: 'CONFLICT' | 'LIMIT_EXCEEDED' | 'RECOVERY_REQUIRED',
  message: string,
  operation_id?: string
) =>
  new BrainError({ code, message, ...(operation_id === undefined ? {} : { operation_id }) });

function grantFor(principal: Principal, scope: string): DynamicProjectGrant {
  return {
    principal_id: principal.id,
    scope,
    can_read: true,
    can_write: true,
    can_review: principal.role === 'reviewer' || principal.role === 'owner'
  };
}

function consumeLimit(ctx: RequestContext, request: ProjectEnsureRequest, deps: BrainDeps): void {
  const now = deps.clock.now().getTime();
  const state: LimitState = limits.get(deps) ?? { principal: new Map(), global: [] };
  limits.set(deps, state);
  const cutoff = now - WINDOW_MS;
  state.global = state.global.filter((event) => event.at > cutoff);
  const own = (state.principal.get(ctx.principal.id) ?? []).filter((event) => event.at > cutoff);
  const key = `${ctx.principal.id}\u0000${request.idempotency_key}`;
  if (own.some((event) => event.key === key)) {
    state.principal.set(ctx.principal.id, own);
    return;
  }
  if (own.length >= deps.config.limits.project_provision_per_principal_per_minute) {
    throw failure('LIMIT_EXCEEDED', 'project provisioning rate limit exceeded');
  }
  if (state.global.length >= deps.config.limits.project_provision_global_per_minute) {
    throw failure('LIMIT_EXCEEDED', 'global project provisioning rate limit exceeded');
  }
  const event = { at: now, key };
  own.push(event);
  state.principal.set(ctx.principal.id, own);
  state.global.push(event);
}

function chooseScope(identity: string, deps: BrainDeps): string {
  const existing = deps.journal.getProjectByIdentity(identity);
  if (existing !== undefined) return existing.scope;
  const candidate = scopeCandidateForRepository(identity);
  if (
    deps.scopeRegistry.get(candidate) === undefined &&
    deps.journal.getProjectByScope(candidate) === undefined
  ) {
    return candidate;
  }
  const suffixed = scopeWithCollisionSuffix(candidate, identity);
  const collision = deps.scopeRegistry.get(suffixed) ?? deps.journal.getProjectByScope(suffixed);
  if (collision !== undefined) throw failure('CONFLICT', 'derived project scope is already reserved');
  return suffixed;
}

function planFor(identity: string, scope: string, principal: Principal): ProjectProvisioningPlan {
  return {
    repository_identity: identity,
    scope,
    backend_project: scope,
    relative_root: `Projects/${scope}`,
    grant: grantFor(principal, scope)
  };
}

function digest(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function parsePlan(record: OperationRecord): ProjectProvisioningPlan {
  try {
    const value = JSON.parse(record.plan_json ?? '') as ProjectProvisioningPlan;
    if (
      value.repository_identity.length === 0 ||
      value.scope !== record.scope ||
      value.backend_project !== value.scope ||
      value.relative_root !== `Projects/${value.scope}` ||
      value.grant.scope !== value.scope ||
      value.grant.can_read !== true
    ) {
      throw new Error('invalid');
    }
    return value;
  } catch {
    throw failure('RECOVERY_REQUIRED', 'project provisioning plan is unreadable', record.operation_id);
  }
}

function parseResult(record: OperationRecord): ProjectEnsureResult {
  try {
    const value = JSON.parse(record.receipt_json ?? '') as ProjectEnsureResult;
    if (value.operation_id !== record.operation_id || value.scope !== record.scope) {
      throw new Error('invalid');
    }
    return value;
  } catch {
    throw failure('RECOVERY_REQUIRED', 'project provisioning receipt is unreadable', record.operation_id);
  }
}

function scopeFor(project: RepositoryProjectRecord): ScopeConfig {
  return {
    id: project.scope,
    backend_project: project.backend_project,
    relative_root: project.relative_root,
    repository_aliases: []
  };
}

async function finalizePlan(
  record: OperationRecord,
  plan: ProjectProvisioningPlan,
  deps: MutationDeps,
  allowOwnerRepair = false
): Promise<ProjectEnsureResult> {
  let project = deps.journal.getProjectByIdentity(plan.repository_identity);
  if (project === undefined) {
    if (deps.journal.countProjects() >= deps.config.limits.dynamic_projects_max) {
      throw failure('LIMIT_EXCEEDED', 'dynamic project limit reached', record.operation_id);
    }
    project = deps.journal.reserveProject({
      repository_identity: plan.repository_identity,
      scope: plan.scope,
      created_by_principal_id: plan.grant.principal_id,
      creation_operation_id: record.operation_id
    }).project;
  }
  if (project.scope !== plan.scope) {
    throw failure('CONFLICT', 'repository project mapping changed', record.operation_id);
  }
  if (project.state === 'recovery_required' && !allowOwnerRepair) {
    throw failure('RECOVERY_REQUIRED', 'repository project requires owner recovery', record.operation_id);
  }
  if (project.state === 'ready') {
    const scope = scopeFor(project);
    try {
      deps.vault.registerScope(scope);
      const verified = await deps.backend.verifyProject(
        project.backend_project,
        `/app/data/${project.relative_root}`
      );
      if (!verified) {
        throw new BrainError({
          code: 'BACKEND_PROTOCOL_ERROR',
          message: 'ready repository project is missing from the backend'
        });
      }
    } catch (error) {
      if (
        isBrainError(error) &&
        ['RECOVERY_REQUIRED', 'FORBIDDEN', 'CONFLICT', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)
      ) {
        deps.journal.markProjectRecoveryRequired(
          plan.repository_identity,
          'ready_verification',
          error.code
        );
        deps.scopeRegistry.quarantineProject(project.scope);
        try {
          deps.journal.mark(record.operation_id, 'conflict');
        } catch {}
        throw failure(
          'RECOVERY_REQUIRED',
          'ready repository project requires owner recovery',
          record.operation_id
        );
      }
      throw error;
    }
    const grant = deps.journal.grantProject(plan.grant);
    deps.scopeRegistry.registerReadyProject(project, grant);
    const result: ProjectEnsureResult = {
      operation_id: record.operation_id,
      repository_identity: plan.repository_identity,
      scope: plan.scope,
      created: false,
      permissions: { can_read: true, can_write: grant.can_write, can_review: grant.can_review },
      backend_ready: true, materialized: true, warnings: []
    };
    deps.journal.mark(record.operation_id, 'complete', result);
    return result;
  }

  let created = false;
  try {
    created = (
      await deps.backend.ensureProject(plan.backend_project, `/app/data/${plan.relative_root}`)
    ).created;
    const scope = scopeFor(project);
    deps.vault.registerScope(scope);
    deps.backend.registerScope(scope);
    deps.catalogue.registerScope(scope);
    const grant = deps.journal.grantProject(plan.grant);
    project = deps.journal.markProjectReady(plan.repository_identity);
    deps.scopeRegistry.registerReadyProject(project, grant);
    const result: ProjectEnsureResult = {
      operation_id: record.operation_id,
      repository_identity: plan.repository_identity,
      scope: plan.scope,
      created,
      permissions: { can_read: true, can_write: grant.can_write, can_review: grant.can_review },
      backend_ready: true, materialized: true, warnings: []
    };
    deps.journal.mark(record.operation_id, 'complete', result);
    return result;
  } catch (error) {
    if (
      isBrainError(error) &&
      ['INVALID_INPUT', 'FORBIDDEN', 'CONFLICT', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)
    ) {
      deps.journal.markProjectRecoveryRequired(
        plan.repository_identity,
        'backend_verification',
        error.code
      );
      try {
        deps.journal.mark(record.operation_id, 'conflict');
      } catch {
        // The recovery-required project row remains the source of truth.
      }
      throw failure(
        'RECOVERY_REQUIRED',
        'repository project mapping requires owner recovery',
        record.operation_id
      );
    }
    throw error;
  }
}

export async function ensureProject(
  ctx: RequestContext,
  request: ProjectEnsureRequest,
  deps: BrainDeps
): Promise<ProjectEnsureResult> {
  const started = Date.now();
  try {
    const parsed = projectEnsureRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new BrainError({ code: 'INVALID_INPUT', message: 'invalid project ensure request' });
    }
    if (ctx.signal.aborted) {
      throw new BrainError({ code: 'CANCELLED', message: 'request cancelled' });
    }
    const identity = normalizeRepositoryIdentity(parsed.data.remote_url);
    consumeLimit(ctx, parsed.data, deps);
    const result = await deps.mutations.serialize(async () => {
      const scope = chooseScope(identity, deps);
      if (
        deps.journal.getProjectByIdentity(identity) === undefined &&
        deps.journal.countProjects() >= deps.config.limits.dynamic_projects_max
      ) {
        throw failure('LIMIT_EXCEEDED', 'dynamic project limit reached');
      }
      const reservation = deps.journal.reserve({
        principal_id: ctx.principal.id,
        idempotency_key: parsed.data.idempotency_key,
        tool: TOOL,
        scope,
        payload_hash: digest(identity),
        payload_json: JSON.stringify({ repository_identity: identity })
      });
      if (reservation.kind === 'replay') {
        if (reservation.record.state === 'complete') return parseResult(reservation.record);
        if (reservation.record.state === 'conflict' || reservation.record.state === 'failed') {
          throw failure(
            'RECOVERY_REQUIRED',
            'project provisioning did not complete',
            reservation.record.operation_id
          );
        }
      }
      const record = reservation.record;
      const plan =
        record.plan_json === undefined
          ? planFor(identity, scope, ctx.principal)
          : parsePlan(record);
      if (record.plan_json === undefined) deps.journal.saveProjectPlan(record.operation_id, plan);
      if (record.state === 'prepared') deps.journal.mark(record.operation_id, 'submitted');
      return finalizePlan(
        deps.journal.get(record.operation_id) ?? record,
        plan,
        deps,
        ctx.principal.role === 'owner'
      );
    });
    try {
      deps.journal.appendAudit({
        request_id: ctx.request_id,
        tool: TOOL,
        outcome: 'ok',
        duration_ms: Math.max(0, Date.now() - started),
        note_count: 0
      });
    } catch {
      // Audit persistence cannot change the already durable provisioning result.
    }
    return result;
  } catch (error) {
    try {
      deps.journal.appendAudit({
        request_id: ctx.request_id,
        tool: TOOL,
        outcome: 'error',
        duration_ms: Math.max(0, Date.now() - started),
        note_count: 0
      });
    } catch {
      // Preserve the original provisioning error.
    }
    throw error;
  }
}

export async function recoverProjectOperation(
  record: OperationRecord,
  deps: MutationDeps
): Promise<RecoveryOperationReport> {
  const base = {
    operation_id: record.operation_id,
    scope: record.scope,
    tool: record.tool,
    previous_state: record.state
  };
  try {
    if (record.plan_json === undefined && record.state === 'prepared') {
      deps.journal.abort(record.operation_id);
      return {
        ...base,
        state: 'failed',
        outcome: 'released',
        blocking: false,
        warnings: [],
        reason: 'no_plan'
      };
    }
    const plan = parsePlan(record);
    if (record.state === 'prepared') deps.journal.mark(record.operation_id, 'submitted');
    await finalizePlan(deps.journal.get(record.operation_id) ?? record, plan, deps);
    return {
      ...base,
      state: 'complete',
      outcome: 'finalized',
      blocking: false,
      warnings: [],
      reason: 'project_verified'
    };
  } catch {
    const current = deps.journal.get(record.operation_id) ?? record;
    let project: RepositoryProjectRecord | undefined;
    try {
      project =
        record.plan_json === undefined
          ? undefined
          : deps.journal.getProjectByIdentity(parsePlan(record).repository_identity);
    } catch {
      project = undefined;
    }
    if (current.state === 'conflict' || project?.state === 'recovery_required') {
      return {
        ...base,
        state: current.state,
        outcome: 'conflicted',
        blocking: true,
        warnings: ['project_recovery_required'],
        reason: 'project_mapping_conflict'
      };
    }
    return {
      ...base,
      state: current.state,
      outcome: 'pending',
      blocking: true,
      warnings: ['project_provisioning_pending'],
      reason: 'project_verification_inconclusive'
    };
  }
}
