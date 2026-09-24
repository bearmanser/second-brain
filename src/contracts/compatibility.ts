import { BrainError } from './errors.js';
import type { RecallMode } from '../core/types.js';
import type { ProjectFilter } from '../projects/registry.js';

export const LEGACY_WARNING_HYBRID_DEPRECATED = 'hybrid_deprecated';
export const LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED = 'include_shared_deprecated';
export const LEGACY_SHARED_CATEGORY = 'shared';

export type ExecutedRecallMode = 'text' | 'reranked';

export interface NormalizedRecallMode {
  requested: RecallMode;
  executed: ExecutedRecallMode;
  deprecated: boolean;
  warnings: string[];
}

export function normalizeRecallMode(mode: RecallMode | undefined): NormalizedRecallMode {
  if (mode === 'hybrid') {
    return {
      requested: 'hybrid',
      executed: 'reranked',
      deprecated: true,
      warnings: [`${LEGACY_WARNING_HYBRID_DEPRECATED}: mode hybrid is a deprecated alias for reranked`]
    };
  }
  return {
    requested: mode ?? 'text',
    executed: mode ?? 'text',
    deprecated: false,
    warnings: []
  };
}

export interface LegacyRecallInput {
  project?: string;
  scope?: string;
  include_shared?: boolean;
}

export interface ProjectLookup {
  canonicalId(identifier: string): string | undefined;
}

export interface NormalizedRecallScope {
  filter: ProjectFilter;
  include_shared: boolean;
  selected_shared: boolean;
  warnings: string[];
}

export interface NormalizedRecallRequest {
  filter: ProjectFilter;
  include_shared: boolean;
  selected_shared: boolean;
  requested_mode: RecallMode;
  mode: ExecutedRecallMode;
  warnings: string[];
}

export function normalizeRecallRequest(
  input: LegacyRecallInput & { mode?: RecallMode },
  lookup: ProjectLookup
): NormalizedRecallRequest {
  const scope = normalizeRecallScope(input, lookup);
  const mode = normalizeRecallMode(input.mode);
  return {
    filter: scope.filter,
    include_shared: scope.include_shared,
    selected_shared: scope.selected_shared,
    requested_mode: mode.requested,
    mode: mode.executed,
    warnings: [...scope.warnings, ...mode.warnings]
  };
}

export function unknownLegacyScope(identifier: string): BrainError {
  return new BrainError({
    code: 'NOT_FOUND',
    message: `legacy scope ${identifier} is not a known project; the query was not widened`
  });
}

function conflictingAliases(): BrainError {
  return new BrainError({
    code: 'INVALID_INPUT',
    message: 'project and scope refer to different projects'
  });
}

export function normalizeRecallScope(
  input: LegacyRecallInput,
  lookup: ProjectLookup
): NormalizedRecallScope {
  const warnings: string[] = [];
  if (input.include_shared !== undefined) {
    warnings.push(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
  }
  const identifiers = [input.project, input.scope].filter(
    (value): value is string => value !== undefined
  );
  if (identifiers.length === 0) {
    return {
      filter: { mode: 'all' },
      include_shared: false,
      selected_shared: false,
      warnings
    };
  }
  const resolved = identifiers.map((identifier) => ({
    identifier,
    canonical: lookup.canonicalId(identifier)
  }));
  for (const entry of resolved) {
    if (entry.canonical === undefined) throw unknownLegacyScope(entry.identifier);
  }
  const canonicalIds = [...new Set(resolved.map((entry) => entry.canonical as string))];
  if (canonicalIds.length > 1) throw conflictingAliases();
  const canonical = canonicalIds[0];
  const sharedCanonical = lookup.canonicalId(LEGACY_SHARED_CATEGORY);
  const selectedShared =
    input.include_shared === true && sharedCanonical !== undefined && sharedCanonical !== canonical;
  return {
    filter: { mode: 'project', identifier: canonical },
    include_shared: input.include_shared === true,
    selected_shared: selectedShared,
    warnings
  };
}
