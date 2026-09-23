import { BrainError } from '../contracts/errors.js';
import { SCOPE_ID_PATTERN } from '../core/limits.js';
import type {
  BackendPort,
  CataloguePort,
  LegacyProjectAdapterPort,
  LegacyProjectBackendBinding,
  PersistedProject,
  Project,
  ScopeConfig,
  VaultPort
} from '../core/types.js';
import { SYSTEM_ACTOR } from '../core/types.js';

export interface LegacyProjectAdapterSource {
  getProjectById(id: string): PersistedProject | undefined;
  getProjectByIdentity(identity: string): PersistedProject | undefined;
  getProjectBinding(id: string): LegacyProjectBackendBinding | undefined;
}

export interface LegacyProjectAdapterDeps {
  source: LegacyProjectAdapterSource;
  backend: BackendPort;
  vault: VaultPort;
  catalogue: CataloguePort;
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

export class LegacyProjectAdapter implements LegacyProjectAdapterPort {
  private readonly deps: LegacyProjectAdapterDeps;

  constructor(deps: LegacyProjectAdapterDeps) {
    this.deps = deps;
  }

  binding(projectId: string): LegacyProjectBackendBinding | undefined {
    return this.deps.source.getProjectBinding(projectId);
  }

  scopeFor(project: Project): ScopeConfig | undefined {
    const binding = this.binding(project.id);
    if (binding === undefined) return undefined;
    return {
      id: project.id,
      backend_project: binding.backend_project,
      relative_root: project.relative_root,
      repository_aliases: []
    };
  }

  async ensure(project: Project): Promise<{ created: boolean }> {
    const scope = this.scopeFor(project);
    const binding = this.binding(project.id);
    if (scope === undefined || binding === undefined) {
      throw recoveryRequired(`project ${project.id} has no legacy backend binding`);
    }
    const created = (
      await this.deps.backend.ensureProject(
        binding.backend_project,
        `/app/data/${binding.backend_relative_root}`
      )
    ).created;
    this.deps.vault.registerScope(scope);
    this.deps.backend.registerScope(scope);
    this.deps.catalogue.registerScope(scope);
    return { created };
  }

  async verify(project: Project): Promise<boolean> {
    const scope = this.scopeFor(project);
    const binding = this.binding(project.id);
    if (scope === undefined || binding === undefined) return false;
    this.deps.vault.registerScope(scope);
    return this.deps.backend.verifyProject(
      binding.backend_project,
      `/app/data/${binding.backend_relative_root}`
    );
  }
}

export interface LegacyProvisioningPlan {
  repository_identity: string;
  project_id: string;
  display_name: string;
  relative_root: string;
  backend_project: string;
  backend_relative_root: string;
  created_by_actor_id: string;
  creation_operation_id: string;
}

function requiredString(value: unknown, field: string, operationId: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw recoveryRequired(`provisioning plan for ${operationId} has an invalid ${field}`, undefined);
  }
  return value;
}

export function parseLegacyProvisioningPlan(input: {
  plan_json?: string;
  operation_id: string;
}): LegacyProvisioningPlan {
  if (input.plan_json === undefined) {
    throw recoveryRequired(`operation ${input.operation_id} has no provisioning plan`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.plan_json);
  } catch (cause) {
    throw recoveryRequired(`operation ${input.operation_id} has an unreadable provisioning plan`, cause);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw recoveryRequired(`operation ${input.operation_id} has an invalid provisioning plan`);
  }
  const record = parsed as Record<string, unknown>;
  const repositoryIdentity = requiredString(
    record.repository_identity,
    'repository_identity',
    input.operation_id
  );
  const legacyScope = record.scope;
  if (legacyScope !== undefined) {
    const scope = requiredString(legacyScope, 'scope', input.operation_id);
    if (!SCOPE_ID_PATTERN.test(scope)) {
      throw recoveryRequired(`provisioning plan for ${input.operation_id} has an invalid scope`);
    }
    const backendProject = requiredString(
      record.backend_project,
      'backend_project',
      input.operation_id
    );
    const relativeRoot = requiredString(record.relative_root, 'relative_root', input.operation_id);
    if (backendProject !== scope || relativeRoot !== `Projects/${scope}`) {
      throw recoveryRequired(
        `provisioning plan for ${input.operation_id} has inconsistent legacy storage mappings`
      );
    }
    const grant = record.grant;
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
      throw recoveryRequired(`provisioning plan for ${input.operation_id} has no legacy grant`);
    }
    const grantRecord = grant as Record<string, unknown>;
    const grantActor = requiredString(grantRecord.principal_id, 'grant principal', input.operation_id);
    if (grantRecord.scope !== scope || grantRecord.can_read !== true) {
      throw recoveryRequired(
        `provisioning plan for ${input.operation_id} has an inconsistent legacy grant`
      );
    }
    return {
      repository_identity: repositoryIdentity,
      project_id: scope,
      display_name: scope,
      relative_root: relativeRoot,
      backend_project: backendProject,
      backend_relative_root: relativeRoot,
      created_by_actor_id: grantActor,
      creation_operation_id: input.operation_id
    };
  }
  const projectId = requiredString(record.project_id, 'project_id', input.operation_id);
  const displayName = requiredString(record.display_name, 'display_name', input.operation_id);
  const relativeRoot = requiredString(record.relative_root, 'relative_root', input.operation_id);
  const backendProject = requiredString(
    record.backend_project ?? projectId,
    'backend_project',
    input.operation_id
  );
  const backendRelativeRoot = requiredString(
    record.backend_relative_root ?? relativeRoot,
    'backend_relative_root',
    input.operation_id
  );
  const createdBy =
    typeof record.created_by_actor_id === 'string' && record.created_by_actor_id.length > 0
      ? record.created_by_actor_id
      : SYSTEM_ACTOR.id;
  const creationOperationId =
    typeof record.creation_operation_id === 'string' && record.creation_operation_id.length > 0
      ? record.creation_operation_id
      : input.operation_id;
  return {
    repository_identity: repositoryIdentity,
    project_id: projectId,
    display_name: displayName,
    relative_root: relativeRoot,
    backend_project: backendProject,
    backend_relative_root: backendRelativeRoot,
    created_by_actor_id: createdBy,
    creation_operation_id: creationOperationId
  };
}

export interface ProjectEnsureReceiptProjection {
  operation_id: string;
  repository_identity: string;
  project_id: string;
  created: boolean;
  backend_ready: boolean;
  materialized: boolean;
  warnings: string[];
}

export function projectEnsureReceipt(
  raw: string,
  operationId: string
): ProjectEnsureReceiptProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw recoveryRequired(`operation ${operationId} has an unreadable project receipt`, cause);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw recoveryRequired(`operation ${operationId} has an invalid project receipt`);
  }
  const record = parsed as Record<string, unknown>;
  const repositoryIdentity = requiredString(
    record.repository_identity,
    'repository_identity',
    operationId
  );
  const projectId = requiredString(record.project_id ?? record.scope, 'project_id', operationId);
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    operation_id: requiredString(record.operation_id, 'operation_id', operationId),
    repository_identity: repositoryIdentity,
    project_id: projectId,
    created: record.created === true,
    backend_ready: record.backend_ready === true,
    materialized: record.materialized === true,
    warnings
  };
}
