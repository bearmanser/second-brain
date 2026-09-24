import { createHash } from 'node:crypto';
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { projectEnsureRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps, MutationDeps, RecoveryOperationReport } from '../core/mutation.js';
import type {
  AuthenticatedContext,
  PersistedProject,
  ProjectEnsureRequest,
  ProjectEnsureResult,
  ProjectProvisioningPlan
} from '../core/types.js';
import { PROJECTS_ROOT, allocateProjectRoot, collisionKey, safeBasename } from '../notes/paths.js';
import {
  normalizeRepositoryIdentity,
  scopeCandidateForRepository,
  scopeWithCollisionSuffix
} from '../projects/identity.js';
import {
  LegacyProjectAdapter,
  parseLegacyProvisioningPlan,
  projectEnsureReceipt
} from '../storage/legacy-project-adapter.js';
import type { OperationRecord } from '../storage/journal.js';

const TOOL = 'brain_project_ensure';
const WINDOW_MS = 60_000;

interface LimitEvent {
  at: number;
  key: string;
}
interface LimitState {
  global: LimitEvent[];
}
const limits = new WeakMap<object, LimitState>();

const failure = (
  code: 'CONFLICT' | 'LIMIT_EXCEEDED' | 'RECOVERY_REQUIRED',
  message: string,
  operation_id?: string
) =>
  new BrainError({ code, message, ...(operation_id === undefined ? {} : { operation_id }) });

function consumeLimit(request: ProjectEnsureRequest, deps: BrainDeps): void {
  const now = deps.clock.now().getTime();
  const state: LimitState = limits.get(deps) ?? { global: [] };
  limits.set(deps, state);
  const cutoff = now - WINDOW_MS;
  state.global = state.global.filter((event) => event.at > cutoff);
  const key = request.idempotency_key;
  if (state.global.some((event) => event.key === key)) return;
  if (state.global.length >= deps.config.limits.project_provision_global_per_minute) {
    throw failure('LIMIT_EXCEEDED', 'global project provisioning rate limit exceeded');
  }
  state.global.push({ at: now, key });
}

function chooseProjectId(identity: string, deps: BrainDeps): string {
  const existing = deps.journal.getProjectByIdentity(identity);
  if (existing !== undefined) return existing.project.id;
  const candidate = scopeCandidateForRepository(identity);
  const collision =
    deps.scopeRegistry.get(candidate) ?? deps.journal.getProjectById(candidate);
  if (collision === undefined) return candidate;
  const suffixed = scopeWithCollisionSuffix(candidate, identity);
  const suffixedCollision =
    deps.scopeRegistry.get(suffixed) ?? deps.journal.getProjectById(suffixed);
  if (suffixedCollision !== undefined) {
    throw failure('CONFLICT', 'derived project identifier is already reserved');
  }
  return suffixed;
}

interface PlannedProjectIdentity {
  projectId: string;
  displayName: string;
  relativeRoot: string;
}

function readProjectsDirectory(projectsDirectory: string): Dirent[] {
  try {
    return readdirSync(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return [];
    }
    throw new BrainError({
      code: 'RECOVERY_REQUIRED',
      message: 'the vault project directory cannot be inspected',
      cause: error
    });
  }
}

function vaultProjectRoots(deps: BrainDeps): string[] {
  const projectsDirectory = join(deps.config.mounts.vault, PROJECTS_ROOT);
  return readProjectsDirectory(projectsDirectory).map(
    (entry) => `${PROJECTS_ROOT}/${entry.name}`
  );
}

function occupiedProjectRoots(deps: BrainDeps): string[] {
  const roots: string[] = [];
  for (const scope of deps.scopeRegistry.all()) roots.push(scope.relative_root);
  for (const project of deps.journal.listProjects()) roots.push(project.project.relative_root);
  for (const root of vaultProjectRoots(deps)) roots.push(root);
  return roots;
}

function readableDisplayName(identity: string, occupied: string[]): string {
  const segments = identity.split('/');
  const basename = segments.at(-1) ?? identity;
  const occupiedKeys = new Set(occupied.map((root) => collisionKey(root)));
  if (!occupiedKeys.has(collisionKey(`${PROJECTS_ROOT}/${safeBasename(basename)}`))) {
    return basename;
  }
  const owner = segments.at(-2);
  if (owner !== undefined && owner.length > 0) return `${owner} ${basename}`;
  return basename;
}

function plannedProjectIdentity(
  identity: string,
  requestedDisplayName: string | undefined,
  deps: BrainDeps
): PlannedProjectIdentity {
  const projectId = chooseProjectId(identity, deps);
  const existing = deps.journal.getProjectByIdentity(identity);
  if (existing !== undefined) {
    return {
      projectId,
      displayName: existing.project.display_name,
      relativeRoot: existing.project.relative_root
    };
  }
  const occupied = occupiedProjectRoots(deps);
  const displayName = requestedDisplayName ?? readableDisplayName(identity, occupied);
  return { projectId, displayName, relativeRoot: allocateProjectRoot(displayName, occupied) };
}

function planFor(
  identity: string,
  identityPlan: PlannedProjectIdentity,
  actorId: string,
  operationId: string
): ProjectProvisioningPlan {
  return {
    repository_identity: identity,
    project_id: identityPlan.projectId,
    display_name: identityPlan.displayName,
    relative_root: identityPlan.relativeRoot,
    backend_project: identityPlan.projectId,
    backend_relative_root: identityPlan.relativeRoot,
    created_by_actor_id: actorId,
    creation_operation_id: operationId
  };
}

function digest(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function parsePlan(record: OperationRecord): ProjectProvisioningPlan {
  const parsed = parseLegacyProvisioningPlan({
    ...(record.plan_json === undefined ? {} : { plan_json: record.plan_json }),
    operation_id: record.operation_id
  });
  if (parsed.project_id !== record.scope) {
    throw failure('RECOVERY_REQUIRED', 'project provisioning plan is inconsistent', record.operation_id);
  }
  return {
    repository_identity: parsed.repository_identity,
    project_id: parsed.project_id,
    display_name: parsed.display_name,
    relative_root: parsed.relative_root,
    backend_project: parsed.backend_project,
    backend_relative_root: parsed.backend_relative_root,
    created_by_actor_id: parsed.created_by_actor_id,
    creation_operation_id: parsed.creation_operation_id
  };
}

function parseResult(record: OperationRecord): ProjectEnsureResult {
  if (record.receipt_json === undefined) {
    throw failure('RECOVERY_REQUIRED', 'project provisioning receipt is unreadable', record.operation_id);
  }
  const projected = projectEnsureReceipt(record.receipt_json, record.operation_id);
  if (projected.operation_id !== record.operation_id || projected.project_id !== record.scope) {
    throw failure('RECOVERY_REQUIRED', 'project provisioning receipt is inconsistent', record.operation_id);
  }
  return {
    operation_id: projected.operation_id,
    repository_identity: projected.repository_identity,
    scope: projected.project_id,
    created: projected.created,
    backend_ready: projected.backend_ready,
    materialized: projected.materialized,
    warnings: projected.warnings
  };
}

function adapterFor(deps: MutationDeps): LegacyProjectAdapter {
  return new LegacyProjectAdapter({
    source: deps.journal,
    backend: deps.backend,
    vault: deps.vault,
    catalogue: deps.catalogue
  });
}

async function finalizePlan(
  record: OperationRecord,
  plan: ProjectProvisioningPlan,
  deps: MutationDeps,
  allowRecovery = false
): Promise<ProjectEnsureResult> {
  let project = deps.journal.getProjectById(plan.project_id);
  if (project === undefined) {
    if (deps.journal.countProjects() >= deps.config.limits.dynamic_projects_max) {
      throw failure('LIMIT_EXCEEDED', 'dynamic project limit reached', record.operation_id);
    }
    project = deps.journal.reserveProject({
      repository_identity: plan.repository_identity,
      project_id: plan.project_id,
      display_name: plan.display_name,
      relative_root: plan.relative_root,
      backend_project: plan.backend_project,
      backend_relative_root: plan.backend_relative_root,
      created_by_actor_id: plan.created_by_actor_id,
      creation_operation_id: record.operation_id
    }).project;
  }
  if (project.project.id !== plan.project_id) {
    throw failure('CONFLICT', 'repository project mapping changed', record.operation_id);
  }
  if (project.state === 'recovery_required' && !allowRecovery) {
    throw failure('RECOVERY_REQUIRED', 'repository project requires recovery', record.operation_id);
  }
  const adapter = adapterFor(deps);
  if (project.state === 'ready') {
    try {
      const verified = await adapter.verify(project.project);
      if (!verified) {
        throw new BrainError({
          code: 'BACKEND_PROTOCOL_ERROR',
          message: 'ready repository project is missing from the backend'
        });
      }
    } catch (error) {
      if (
        isBrainError(error) &&
        ['RECOVERY_REQUIRED', 'CONFLICT', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)
      ) {
        deps.journal.markProjectRecoveryRequired(plan.project_id, 'ready_verification', error.code);
        deps.scopeRegistry.quarantineProject(plan.project_id);
        try {
          deps.journal.mark(record.operation_id, 'conflict');
        } catch {}
        throw failure('RECOVERY_REQUIRED', 'ready repository project requires recovery', record.operation_id);
      }
      throw error;
    }
    const binding = deps.journal.getProjectBinding(plan.project_id);
    deps.scopeRegistry.registerReadyProject(project, binding);
    const result: ProjectEnsureResult = {
      operation_id: record.operation_id,
      repository_identity: plan.repository_identity,
      scope: plan.project_id,
      created: false,
      backend_ready: true,
      materialized: true,
      warnings: []
    };
    deps.journal.mark(record.operation_id, 'complete', result);
    return result;
  }

  let created = false;
  try {
    created = (await adapter.ensure(project.project)).created;
    project = deps.journal.markProjectReady(plan.project_id);
    const binding = deps.journal.getProjectBinding(plan.project_id);
    deps.scopeRegistry.registerReadyProject(project, binding);
    const result: ProjectEnsureResult = {
      operation_id: record.operation_id,
      repository_identity: plan.repository_identity,
      scope: plan.project_id,
      created,
      backend_ready: true,
      materialized: true,
      warnings: []
    };
    deps.journal.mark(record.operation_id, 'complete', result);
    return result;
  } catch (error) {
    if (
      isBrainError(error) &&
      ['INVALID_INPUT', 'CONFLICT', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)
    ) {
      deps.journal.markProjectRecoveryRequired(plan.project_id, 'backend_verification', error.code);
      try {
        deps.journal.mark(record.operation_id, 'conflict');
      } catch {}
      throw failure('RECOVERY_REQUIRED', 'repository project mapping requires recovery', record.operation_id);
    }
    throw error;
  }
}

export async function ensureProject(
  ctx: AuthenticatedContext,
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
    consumeLimit(parsed.data, deps);
    const result = await deps.mutations.serialize(async () => {
      const identityPlan = plannedProjectIdentity(identity, parsed.data.display_name, deps);
      if (
        deps.journal.getProjectByIdentity(identity) === undefined &&
        deps.journal.countProjects() >= deps.config.limits.dynamic_projects_max
      ) {
        throw failure('LIMIT_EXCEEDED', 'dynamic project limit reached');
      }
      const reservation = deps.journal.reserve({
        principal_id: ctx.actor.id,
        idempotency_key: parsed.data.idempotency_key,
        tool: TOOL,
        scope: identityPlan.projectId,
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
          ? planFor(identity, identityPlan, ctx.actor.id, record.operation_id)
          : parsePlan(record);
      if (record.plan_json === undefined) deps.journal.saveProjectPlan(record.operation_id, plan);
      if (record.state === 'prepared') deps.journal.mark(record.operation_id, 'submitted');
      return finalizePlan(deps.journal.get(record.operation_id) ?? record, plan, deps);
    });
    try {
      deps.journal.appendAudit({
        request_id: ctx.request_id,
        tool: TOOL,
        outcome: 'ok',
        duration_ms: Math.max(0, Date.now() - started),
        note_count: 0
      });
    } catch {}
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
    } catch {}
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
    await finalizePlan(deps.journal.get(record.operation_id) ?? record, plan, deps, true);
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
    let project: PersistedProject | undefined;
    try {
      project =
        record.plan_json === undefined ? undefined : deps.journal.getProjectById(parsePlan(record).project_id);
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
