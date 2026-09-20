import { BrainError } from '../contracts/errors.js';
import type { Principal, ScopeConfig } from '../core/types.js';

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

const resolveIdentifier = (identifier: string, configured: ScopeConfig[]): ScopeConfig => {
  const matches = configured.filter(
    (scope) => scope.id === identifier || scope.repository_aliases.includes(identifier)
  );
  const unique = matches.filter((scope, index) => matches.indexOf(scope) === index);
  if (unique.length === 0) throw forbidden('requested scope is not available');
  if (unique.length > 1) throw forbidden('requested scope identifier is ambiguous');
  return unique[0];
};

const permitted = (principal: Principal, scope: string, operation: ScopeOperation): boolean => {
  if (operation === 'read') return principal.read_scopes.includes(scope);
  if (operation === 'write') return principal.write_scopes.includes(scope);
  return canReview(principal, scope, false);
};

export function resolveScopes(
  principal: Principal,
  requested: string,
  includeShared: boolean,
  operation: ScopeOperation,
  configured: ScopeConfig[]
): ScopeConfig[] {
  const identifier = requireIdentifier(requested);
  const primary = resolveIdentifier(identifier, configured);
  if (!permitted(principal, primary.id, operation)) {
    throw forbidden('scope access is not allowed');
  }
  const resolved: ScopeConfig[] = [primary];
  if (includeShared && primary.id !== SHARED_SCOPE_ID) {
    const shared = configured.find((scope) => scope.id === SHARED_SCOPE_ID);
    if (shared && permitted(principal, shared.id, operation)) {
      resolved.push(shared);
    }
  }
  return resolved;
}

export function resolveLinkedScopes(
  principal: Principal,
  requested: string[],
  configured: ScopeConfig[]
): ScopeConfig[] {
  const resolved: ScopeConfig[] = [];
  const seen = new Set<string>();
  for (const value of requested) {
    const identifier = requireIdentifier(value);
    const scope = resolveIdentifier(identifier, configured);
    if (!principal.read_scopes.includes(scope.id)) {
      throw forbidden('linked scope access is not allowed');
    }
    if (!seen.has(scope.id)) {
      seen.add(scope.id);
      resolved.push(scope);
    }
  }
  return resolved;
}
