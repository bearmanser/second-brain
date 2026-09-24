import { isExternalTarget, type LinkReference, type LinkReferenceInput, type LinkSyntax, type RelationshipEdge, type ResolvedRelationship } from './links.js';

export type LinkResolution =
  | { state: 'resolved'; path: string; id?: string }
  | { state: 'unresolved'; target: string }
  | { state: 'ambiguous'; target: string; paths: string[] };

export type LinkCatalogue =
  | ReadonlyMap<string, string | undefined>
  | Record<string, string | undefined>;

interface CatalogueEntry {
  path: string;
  id?: string;
}

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  '.avif',
  '.base',
  '.canvas',
  '.csv',
  '.docx',
  '.gif',
  '.jpeg',
  '.jpg',
  '.json',
  '.markdown',
  '.md',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.svg',
  '.txt',
  '.wav',
  '.webp',
  '.xlsx'
]);

function catalogueEntries(catalogue: LinkCatalogue): CatalogueEntry[] {
  const raw: Array<[string, string | undefined]> =
    catalogue instanceof Map
      ? [...catalogue.entries()]
      : Object.entries(catalogue).map(([path, id]) => [path, id ?? undefined]);
  const entries: CatalogueEntry[] = [];
  for (const [path, id] of raw) {
    if (typeof path !== 'string' || path.length === 0) continue;
    entries.push({ path, ...(id === undefined ? {} : { id }) });
  }
  return entries;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasKnownExtension(value: string): boolean {
  const dot = value.lastIndexOf('.');
  if (dot <= value.lastIndexOf('/')) return false;
  return KNOWN_EXTENSIONS.has(value.slice(dot).toLowerCase());
}

function withExtension(value: string): string {
  return hasKnownExtension(value) ? value : `${value}.md`;
}

function sourceDirectory(sourcePath: string): string {
  const normalized = normalizePath(sourcePath);
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

function joinRelative(base: string, relative: string): string {
  const segments = base.length === 0 ? [] : base.split('/');
  for (const part of relative.split('/')) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function matchTier(
  entries: readonly CatalogueEntry[],
  candidates: ReadonlySet<string>,
  matches: (path: string, candidate: string) => boolean
): CatalogueEntry[] {
  const found: CatalogueEntry[] = [];
  for (const entry of entries) {
    const path = entry.path.normalize('NFC');
    for (const candidate of candidates) {
      if (!matches(path, candidate)) continue;
      found.push(entry);
      break;
    }
  }
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return found;
}

function resolutionFor(found: readonly CatalogueEntry[], target: string): LinkResolution {
  if (found.length === 1) {
    const entry = found[0];
    return { state: 'resolved', path: entry.path, ...(entry.id === undefined ? {} : { id: entry.id }) };
  }
  return { state: 'ambiguous', target, paths: found.map((entry) => entry.path) };
}

export function resolveLink(
  reference: LinkReferenceInput,
  sourcePath: string,
  catalogue: LinkCatalogue
): LinkResolution {
  const rawTarget = typeof reference?.target === 'string' ? reference.target.trim() : '';
  if (rawTarget.length === 0) return { state: 'unresolved', target: rawTarget };
  if (isExternalTarget(rawTarget)) return { state: 'unresolved', target: rawTarget };
  const decoded = decodePath(rawTarget);
  const normalized = normalizePath(decoded);
  const absolute = normalized.startsWith('/');
  const withoutRoot = normalized.replace(/^\/+/, '');
  if (withoutRoot.length === 0) return { state: 'unresolved', target: rawTarget };
  const syntax: LinkSyntax | undefined = reference.syntax;
  const dotRelative = withoutRoot.startsWith('./') || withoutRoot.startsWith('../');
  const relative = dotRelative || (syntax === 'markdown' && !absolute);

  const entries = catalogueEntries(catalogue);
  const byId = entries.filter((entry) => entry.id !== undefined && (entry.id === rawTarget || entry.id === decoded));
  if (byId.length > 0) return resolutionFor(byId, rawTarget);

  const exact = new Set<string>();
  const suffix = new Set<string>();
  if (relative) {
    const joined = withExtension(joinRelative(sourceDirectory(sourcePath), withoutRoot)).normalize('NFC');
    exact.add(joined);
    suffix.add(joined);
  } else {
    const vaultPath = withExtension(withoutRoot).normalize('NFC');
    exact.add(vaultPath);
    suffix.add(vaultPath);
  }

  const exactMatches = matchTier(entries, exact, (path, candidate) => path === candidate);
  if (exactMatches.length > 0) return resolutionFor(exactMatches, rawTarget);
  const suffixMatches = matchTier(
    entries,
    suffix,
    (path, candidate) => path === candidate || path.endsWith(`/${candidate}`)
  );
  if (suffixMatches.length > 0) return resolutionFor(suffixMatches, rawTarget);
  return { state: 'unresolved', target: rawTarget };
}

export function resolveRelationships(
  edges: ReadonlyArray<RelationshipEdge>,
  sourcePath: string,
  catalogue: LinkCatalogue
): ResolvedRelationship[] {
  const resolved: ResolvedRelationship[] = [];
  for (const edge of edges) {
    const outcome = resolveLink(edge.reference, sourcePath, catalogue);
    if (outcome.state !== 'resolved') continue;
    resolved.push({
      kind: edge.kind,
      source: normalizePath(sourcePath),
      target: outcome.path,
      ...(edge.reference.fragment === undefined ? {} : { fragment: edge.reference.fragment }),
      ...(outcome.id === undefined ? {} : { id: outcome.id })
    });
  }
  return resolved;
}

export type { LinkReference, RelationshipEdge, ResolvedRelationship };
