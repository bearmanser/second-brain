import { BrainError } from '../contracts/errors.js';
import type {
  LegacyProjectBackendBinding,
  PersistedProject,
  Project,
  ProjectAlias,
  ScopeConfig
} from '../core/types.js';
import { ProjectRegistry } from './registry.js';

export interface ScopeRegistrySource {
  listProjects(): PersistedProject[];
  getProjectBinding(projectId: string): LegacyProjectBackendBinding | undefined;
}

const RESERVED = new Set(['shared', 'profile']);

const invalidInput = (message: string): BrainError =>
  new BrainError({ code: 'INVALID_INPUT', message });

const conflict = (message: string): BrainError => new BrainError({ code: 'CONFLICT', message });

export class ScopeRegistry {
  private readonly projects = new Map<string, Project>();
  private readonly order: string[] = [];
  private readonly bindings = new Map<string, LegacyProjectBackendBinding>();
  private readonly staticAliases: ProjectAlias[] = [];
  private readonly dynamic = new Set<string>();
  private readonly quarantined = new Set<string>();
  private registry: ProjectRegistry;

  constructor(staticScopes: readonly ScopeConfig[], source?: ScopeRegistrySource) {
    for (const scope of staticScopes) this.registerStatic(scope);
    if (source !== undefined) {
      for (const project of source.listProjects()) {
        const binding = source.getProjectBinding(project.project.id);
        this.registerDynamicProject(
          project.project,
          binding,
          project.state !== 'ready' || binding === undefined
        );
      }
    }
    this.registry = this.buildRegistry();
  }

  all(): ScopeConfig[] {
    return [...this.projects.values()]
      .filter((project) => !this.quarantined.has(project.id))
      .map((project) => this.scopeFor(project));
  }

  get(idOrAlias: string): ScopeConfig | undefined {
    const project = this.registry.get(idOrAlias);
    return project === undefined ? undefined : this.scopeFor(project);
  }

  require(idOrAlias: string): ScopeConfig {
    const project = this.registry.get(idOrAlias);
    if (project !== undefined && !this.isUsable(project.id)) {
      throw new BrainError({
        code: 'RECOVERY_REQUIRED',
        message: `project ${project.id} requires recovery before it can be used`
      });
    }
    const scope = this.get(idOrAlias);
    if (scope === undefined) {
      throw new BrainError({ code: 'NOT_FOUND', message: `project ${idOrAlias} is not configured` });
    }
    return scope;
  }

  isUsable(idOrAlias: string): boolean {
    const project = this.registry.get(idOrAlias);
    return project !== undefined && this.registry.isUsable(project.id);
  }

  unusable(): ScopeConfig[] {
    return [...this.projects.values()]
      .filter((project) => this.quarantined.has(project.id))
      .map((project) => this.scopeFor(project));
  }

  registerReadyProject(project: PersistedProject, binding?: LegacyProjectBackendBinding): void {
    if (project.state !== 'ready') throw invalidInput('only ready projects can register');
    this.registerDynamicProject(project.project, binding ?? this.bindings.get(project.project.id));
  }

  quarantineProject(idOrAlias: string): void {
    const project = this.registry.get(idOrAlias);
    if (project === undefined) return;
    this.quarantined.add(project.id);
    this.registry = this.buildRegistry();
  }

  private buildRegistry(): ProjectRegistry {
    return new ProjectRegistry(
      [...this.projects.values()],
      [...this.staticAliases],
      [...this.quarantined]
    );
  }

  private scopeFor(project: Project): ScopeConfig {
    const binding = this.bindings.get(project.id);
    if (binding === undefined) {
      throw new BrainError({
        code: 'RECOVERY_REQUIRED',
        message: `project ${project.id} has no legacy backend binding`
      });
    }
    return {
      id: project.id,
      backend_project: binding.backend_project,
      relative_root: project.relative_root,
      repository_aliases: []
    };
  }

  private registerStatic(scope: ScopeConfig): void {
    if (this.projects.has(scope.id)) {
      throw invalidInput(`static project identifier ${scope.id} is duplicated`);
    }
    this.projects.set(scope.id, {
      id: scope.id,
      display_name: scope.id,
      relative_root: scope.relative_root
    });
    this.order.push(scope.id);
    for (const alias of scope.repository_aliases) {
      if (alias === scope.id) continue;
      this.staticAliases.push({ identifier: alias, project_id: scope.id });
    }
    this.bindings.set(scope.id, {
      backend_project: scope.backend_project,
      backend_relative_root: scope.relative_root
    });
  }

  private registerDynamicProject(
    project: Project,
    binding?: LegacyProjectBackendBinding,
    unusable = false
  ): void {
    if (RESERVED.has(project.id)) {
      throw invalidInput(`dynamic project ${project.id} is reserved`);
    }
    const existing = this.projects.get(project.id);
    if (existing !== undefined) {
      if (!this.dynamic.has(project.id)) {
        throw invalidInput(`dynamic project ${project.id} conflicts with static configuration`);
      }
      if (
        existing.relative_root !== project.relative_root ||
        existing.repository_identity !== project.repository_identity ||
        existing.display_name !== project.display_name
      ) {
        throw conflict(`dynamic project ${project.id} was registered with a different mapping`);
      }
      if (binding !== undefined) this.bindings.set(project.id, binding);
      if (unusable) this.quarantined.add(project.id);
      this.registry = this.buildRegistry();
      return;
    }
    this.projects.set(project.id, { ...project });
    this.order.push(project.id);
    this.dynamic.add(project.id);
    if (binding !== undefined) this.bindings.set(project.id, binding);
    if (unusable) this.quarantined.add(project.id);
    this.registry = this.buildRegistry();
  }
}
