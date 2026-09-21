import { BrainError } from '../contracts/errors.js';
import type { Principal, ScopeConfig } from '../core/types.js';
import type { ScopeRegistry } from '../projects/scope-registry.js';

export const SHARED_SCOPE_ID = 'shared';

export type ScopeOperation = 'read' | 'write' | 'review';

const forbidden = (message: string): BrainError => new BrainError({ code: 'FORBIDDEN', message });
const scopeRequired = (message: string): BrainError =>
  new BrainError({ code: 'SCOPE_REQUIRED', message });

export function canReview(principal: Principal, scope: string, protectedNote: boolean): boolean {
  if (!principal.review_scopes.includes(scope)) return false;
  if (protectedNote) return principal.role === 'owner';
  return principal.role === 'reviewer' || principal.role === 'owner';
}

const requireIdentifier = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw scopeRequired('a scope identifier is required');
  }
  return value.trim();
};

const permitted = (
  registry: ScopeRegistry,
  principal: Principal,
  scope: string,
  operation: ScopeOperation
): boolean => {
  const permissions = registry.permissions(principal, scope);
  if (operation === 'read') return permissions.can_read;
  if (operation === 'write') return permissions.can_write;
  return permissions.can_review;
};

export function resolveScopes(
  principal: Principal,
  requested: string,
  includeShared: boolean,
  operation: ScopeOperation,
  registry: ScopeRegistry
): ScopeConfig[] {
  const identifier = requireIdentifier(requested);
  const primary = registry.get(identifier);
  if (primary === undefined || !permitted(registry, principal, primary.id, operation)) {
    throw forbidden('requested scope is not available');
  }
  const resolved: ScopeConfig[] = [primary];
  if (includeShared && primary.id !== SHARED_SCOPE_ID) {
    const shared = registry.get(SHARED_SCOPE_ID);
    if (shared !== undefined && permitted(registry, principal, shared.id, operation)) {
      resolved.push(shared);
    }
  }
  return resolved;
}

export function resolveLinkedScopes(
  principal: Principal,
  requested: string[],
  registry: ScopeRegistry
): ScopeConfig[] {
  const resolved: ScopeConfig[] = [];
  const seen = new Set<string>();
  for (const value of requested) {
    const identifier = requireIdentifier(value);
    const scope = registry.get(identifier);
    if (scope === undefined || !registry.permissions(principal, scope.id).can_read) {
      throw forbidden('requested scope is not available');
    }
    if (!seen.has(scope.id)) {
      seen.add(scope.id);
      resolved.push(scope);
    }
  }
  return resolved;
}
