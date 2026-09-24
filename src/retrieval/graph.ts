import type { SearchChunk } from './chunker.js';
import {
  documentMatchesFilters,
  type CandidateFilters,
  type FilterableDocument
} from './query.js';

export const GRAPH_SEED_LIMIT = 5;
export const GRAPH_NEIGHBOR_LIMIT = 10;

export interface GraphFilters extends CandidateFilters {
  query?: string;
}

export interface GraphDocument extends FilterableDocument {
  document_key: string;
  path: string;
  id?: string;
}

export interface GraphStoredEdge {
  source: string;
  target: string;
  relationship: string;
}

export type GraphEdge = GraphStoredEdge;

export interface GraphNeighbor {
  document_key: string;
  path: string;
  id?: string;
  relationship: string;
  reason: string;
  direction: 'outgoing' | 'incoming';
  chunk: SearchChunk;
}

export interface GraphExpansion {
  neighbors: GraphNeighbor[];
  edges: GraphEdge[];
}

export interface GraphStore {
  edgesTouching(seedKeys: readonly string[]): GraphStoredEdge[];
  documentFor(documentKey: string): GraphDocument | undefined;
  firstChunk(documentKey: string): SearchChunk | undefined;
  bestChunk(documentKey: string, query: string): SearchChunk | undefined;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.relationship}`;
}

function dedupeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const output: GraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }
  return output;
}

export function expandGraph(
  store: GraphStore,
  seedKeys: readonly string[],
  filters: GraphFilters,
  limit: number
): GraphExpansion {
  const seeds = [...new Set(seedKeys.filter((key) => typeof key === 'string' && key.length > 0))].slice(
    0,
    GRAPH_SEED_LIMIT
  );
  if (seeds.length === 0) return { neighbors: [], edges: [] };
  const maximum = Math.max(0, Math.min(Math.trunc(limit), GRAPH_NEIGHBOR_LIMIT));
  const seedSet = new Set(seeds);
  const chosen = new Map<string, { relationship: string; direction: 'outgoing' | 'incoming' }>();
  const edges: GraphEdge[] = [];
  for (const edge of store.edgesTouching(seeds)) {
    const candidates: Array<{ self: string; other: string; direction: 'outgoing' | 'incoming' }> = [
      { self: edge.source, other: edge.target, direction: 'outgoing' },
      { self: edge.target, other: edge.source, direction: 'incoming' }
    ];
    for (const candidate of candidates) {
      if (!seedSet.has(candidate.self)) continue;
      if (seedSet.has(candidate.other)) continue;
      edges.push(edge);
      const existing = chosen.get(candidate.other);
      if (existing === undefined) {
        chosen.set(candidate.other, { relationship: edge.relationship, direction: candidate.direction });
      } else if (existing.relationship === 'link' && edge.relationship !== 'link') {
        chosen.set(candidate.other, { relationship: edge.relationship, direction: candidate.direction });
      }
    }
  }
  const neighbors: GraphNeighbor[] = [];
  for (const [key, relation] of chosen) {
    if (neighbors.length >= maximum) break;
    const document = store.documentFor(key);
    if (document === undefined) continue;
    if (!documentMatchesFilters(document, filters)) continue;
    const lexical = filters.query === undefined ? undefined : store.bestChunk(key, filters.query);
    const chunk = lexical ?? store.firstChunk(key);
    if (chunk === undefined) continue;
    neighbors.push({
      document_key: key,
      path: document.path,
      ...(document.id === undefined ? {} : { id: document.id }),
      relationship: relation.relationship,
      reason: `graph:${relation.relationship}`,
      direction: relation.direction,
      chunk
    });
  }
  return { neighbors, edges: dedupeEdges(edges) };
}

export function createGraphExpander(
  store: GraphStore
): { expandGraph(seedKeys: readonly string[], filters: GraphFilters, limit: number): GraphExpansion } {
  return {
    expandGraph: (seedKeys, filters, limit) => expandGraph(store, seedKeys, filters, limit)
  };
}
