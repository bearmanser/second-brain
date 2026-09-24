import { BrainError } from '../contracts/errors.js';
import { NOTE_KINDS } from '../core/types.js';
import { DOCUMENT_STATUSES, HUMAN_DOCUMENT_TYPES } from '../notes/document.js';
import type { SearchChunk } from './chunker.js';

export interface Candidate extends SearchChunk {
  lexical_rank: number | null;
  candidate_position: number;
  reasons: string[];
}

export interface CandidateFilters {
  project?: string;
  project_roots?: readonly string[];
  types?: readonly string[];
  statuses?: readonly string[];
}

export const KNOWN_DOCUMENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...NOTE_KINDS,
  ...HUMAN_DOCUMENT_TYPES
]);

const TERM_LIMIT = 64;
const TERM_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_]*/gu;

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

export function literalMatch(query: string): string | null {
  if (typeof query !== 'string') return null;
  const terms: string[] = [];
  const seen = new Set<string>();
  TERM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TERM_PATTERN.exec(query)) !== null) {
    const term = match[0];
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= TERM_LIMIT) break;
  }
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

export function normalizeTypes(types: readonly string[] | undefined): string[] {
  if (types === undefined) return [];
  const normalized: string[] = [];
  for (const type of types) {
    if (typeof type !== 'string' || !KNOWN_DOCUMENT_TYPES.has(type)) {
      throw invalidInput(`unknown document type ${String(type)}`);
    }
    if (!normalized.includes(type)) normalized.push(type);
  }
  return normalized;
}

export function normalizeStatuses(statuses: readonly string[] | undefined): string[] {
  if (statuses === undefined) return [];
  const normalized: string[] = [];
  for (const status of statuses) {
    if (typeof status !== 'string' || !(DOCUMENT_STATUSES as readonly string[]).includes(status)) {
      throw invalidInput(`unknown document status ${String(status)}`);
    }
    if (!normalized.includes(status)) normalized.push(status);
  }
  return normalized;
}

export interface ProjectParts {
  norm: string;
  leaf: string;
}

export function projectParts(value: string): ProjectParts {
  const stripped = value
    .replace(/^\[\[/, '')
    .replace(/\]\]$/, '')
    .split('|')[0]
    .trim();
  const norm = stripped.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/').filter((segment) => segment.length > 0);
  const leaf = segments.length > 0 ? segments[segments.length - 1] : norm;
  return { norm, leaf };
}

export interface FilterableDocument {
  type: string;
  status: string;
  path?: string;
  project_norm?: string | null;
  project_leaf?: string | null;
}

export function documentInProjectRoots(
  path: string | undefined,
  roots: readonly string[] | undefined
): boolean {
  if (roots === undefined || roots.length === 0) return false;
  if (path === undefined) return false;
  const normalized = path.replace(/\\/g, '/');
  return roots.some((root) => {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}

export function documentMatchesFilters(
  document: FilterableDocument,
  filters: CandidateFilters
): boolean {
  if (filters.types !== undefined && filters.types.length > 0 && !filters.types.includes(document.type)) {
    return false;
  }
  if (
    filters.statuses !== undefined &&
    filters.statuses.length > 0 &&
    !filters.statuses.includes(document.status)
  ) {
    return false;
  }
  if (filters.project !== undefined || filters.project_roots !== undefined) {
    const projectMatch =
      filters.project !== undefined &&
      (() => {
        const wanted = projectParts(filters.project);
        return document.project_norm === wanted.norm || document.project_leaf === wanted.leaf;
      })();
    if (!projectMatch && !documentInProjectRoots(document.path, filters.project_roots)) {
      return false;
    }
  }
  return true;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function clampCandidateLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 0;
  const rounded = Math.trunc(limit);
  if (rounded < 0) return 0;
  if (rounded > 500) return 500;
  return rounded;
}
