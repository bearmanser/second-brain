import { BrainError } from '../contracts/errors.js';
import type {
  DynamicProjectGrant,
  Principal,
  RepositoryProjectRecord,
  ScopeConfig
} from '../core/types.js';

export interface ScopePermissions {
  can_read: boolean;
  can_write: boolean;
  can_review: boolean;
}

export interface ScopeRegistrySource {
  listReadyProjects(): RepositoryProjectRecord[];
  listProjectGrants(principalId?: string): DynamicProjectGrant[];
}

const RESERVED = new Set(['shared', 'profile']);

const invalidInput = (message: string): BrainError =>
  new BrainError({ code: 'INVALID_INPUT', message });

const conflict = (message: string): BrainError => new BrainError({ code: 'CONFLICT', message });

const sameScope = (left: ScopeConfig, right: ScopeConfig): boolean =>
  left.id === right.id &&
  left.backend_project === right.backend_project &&
  left.relative_root === right.relative_root &&
  left.repository_aliases.length === right.repository_aliases.length &&
  left.repository_aliases.every((alias, index) => alias === right.repository_aliases[index]);

export class ScopeRegistry {
  private readonly scopes = new Map<string, ScopeConfig>();
  private readonly aliases = new Map<string, string>();
  private readonly dynamicScopes = new Set<string>();
  private readonly grants = new Map<string, DynamicProjectGrant>();

  constructor(staticScopes: readonly ScopeConfig[], source?: ScopeRegistrySource) {
    for (const scope of staticScopes) this.registerStatic(scope);
    if (source === undefined) return;
    const grantsByScope = new Map<string, DynamicProjectGrant[]>();
    for (const grant of source.listProjectGrants()) {
      const entries = grantsByScope.get(grant.scope) ?? [];
      entries.push(grant);
      grantsByScope.set(grant.scope, entries);
    }
    for (const project of source.listReadyProjects()) {
      const projectGrants = grantsByScope.get(project.scope) ?? [];
      this.registerDynamicScope(project);
      for (const grant of projectGrants) this.registerGrant(project.scope, grant);
    }
  }

  all(): ScopeConfig[] {
    return [...this.scopes.values()].map((scope) => ({
      ...scope,
      repository_aliases: [...scope.repository_aliases]
    }));
  }

  get(idOrAlias: string): ScopeConfig | undefined {
    const direct = this.scopes.get(idOrAlias);
    const resolved = direct ?? this.scopes.get(this.aliases.get(idOrAlias) ?? '');
    return resolved === undefined
      ? undefined
      : { ...resolved, repository_aliases: [...resolved.repository_aliases] };
  }

  visibleTo(principal: Principal): ScopeConfig[] {
    return this.all().filter((scope) => this.permissions(principal, scope.id).can_read);
  }

  permissions(principal: Principal, scopeOrAlias: string): ScopePermissions {
    const scope = this.get(scopeOrAlias);
    if (scope === undefined) return { can_read: false, can_write: false, can_review: false };
    if (!this.dynamicScopes.has(scope.id)) {
      return {
        can_read: principal.read_scopes.includes(scope.id),
        can_write: principal.write_scopes.includes(scope.id),
        can_review:
          principal.review_scopes.includes(scope.id) &&
          (principal.role === 'reviewer' || principal.role === 'owner')
      };
    }
    if (principal.role === 'owner') {
      return { can_read: true, can_write: true, can_review: true };
    }
    const grant = this.grants.get(this.grantKey(principal.id, scope.id));
    return grant === undefined
      ? { can_read: false, can_write: false, can_review: false }
      : {
          can_read: grant.can_read,
          can_write: grant.can_write,
          can_review: grant.can_review && principal.role === 'reviewer'
        };
  }

  registerReadyProject(project: RepositoryProjectRecord, grant: DynamicProjectGrant): void {
    if (project.state !== 'ready') throw invalidInput('only ready repository projects can register');
    this.registerDynamicScope(project);
    this.registerGrant(project.scope, grant);
  }

  private registerStatic(scope: ScopeConfig): void {
    if (this.scopes.has(scope.id) || this.aliases.has(scope.id)) {
      throw invalidInput(`static scope identifier ${scope.id} is duplicated`);
    }
    const copy = { ...scope, repository_aliases: [...scope.repository_aliases] };
    this.scopes.set(copy.id, copy);
    for (const alias of copy.repository_aliases) {
      if (alias === copy.id) continue;
      if (this.scopes.has(alias) || this.aliases.has(alias)) {
        throw invalidInput(`static scope alias ${alias} is duplicated`);
      }
      this.aliases.set(alias, copy.id);
    }
  }

  private registerDynamicScope(project: RepositoryProjectRecord): void {
    if (project.state !== 'ready') throw invalidInput('only ready repository projects can register');
    if (RESERVED.has(project.scope) || this.aliases.has(project.scope)) {
      throw invalidInput(`dynamic scope ${project.scope} is reserved`);
    }
    const scope: ScopeConfig = {
      id: project.scope,
      backend_project: project.backend_project,
      relative_root: project.relative_root,
      repository_aliases: []
    };
    const existing = this.scopes.get(scope.id);
    if (existing !== undefined) {
      if (!this.dynamicScopes.has(scope.id)) {
        throw invalidInput(`dynamic scope ${scope.id} conflicts with static configuration`);
      }
      if (!sameScope(existing, scope)) {
        throw conflict(`dynamic scope ${scope.id} was registered with a different mapping`);
      }
      return;
    }
    this.scopes.set(scope.id, scope);
    this.dynamicScopes.add(scope.id);
  }

  private registerGrant(scope: string, grant: DynamicProjectGrant): void {
    if (grant.scope !== scope || grant.can_read !== true) {
      throw invalidInput('dynamic project grant does not match the registered scope');
    }
    this.grants.set(this.grantKey(grant.principal_id, scope), { ...grant });
  }

  private grantKey(principalId: string, scope: string): string {
    return `${principalId}\u0000${scope}`;
  }
}
