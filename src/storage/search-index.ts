import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BrainError } from '../contracts/errors.js';
import type { CurrentDocument } from '../notes/document.js';
import { parseDocument } from '../notes/document-codec.js';
import { resolveLink } from '../notes/link-resolver.js';
import { extractLinks, extractRelationships, type LinkSyntax } from '../notes/links.js';
import { chunkDocument, type SearchChunk } from '../retrieval/chunker.js';
import {
  clampCandidateLimit,
  documentMatchesFilters,
  literalMatch,
  normalizeStatuses,
  normalizeTypes,
  projectParts,
  type Candidate,
  type CandidateFilters,
  type FilterableDocument
} from '../retrieval/query.js';
import {
  expandGraph,
  type GraphDocument,
  type GraphExpansion,
  type GraphFilters,
  type GraphStoredEdge,
  type GraphStore
} from '../retrieval/graph.js';

const SEARCH_SCHEMA_PATH = fileURLToPath(new URL('./search-schema.sql', import.meta.url));
const FTS_RANK = 'bm25(chunks_fts, 8, 6, 4, 3, 1)';
const CHUNK_COLUMNS =
  'c.chunk_key AS chunk_key, c.document_key AS document_key, c.path AS path, c.title AS title, ' +
  'c.heading AS heading, c.line_from AS line_from, c.line_to AS line_to, ' +
  'c.start_offset AS start_offset, c.end_offset AS end_offset, c.text AS text, ' +
  'c.source_hash AS source_hash, c.reference_tokens_json AS reference_tokens_json';

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function titleFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const withoutExtension = base.endsWith('.md') ? base.slice(0, -3) : base;
  return withoutExtension.length > 0 ? withoutExtension : 'Untitled';
}

function documentForIndex(raw: string, path: string, overrideId?: string): CurrentDocument {
  try {
    const document = parseDocument(raw, path);
    if (document.id === undefined && overrideId !== undefined) {
      return { ...document, id: overrideId };
    }
    return document;
  } catch {
    return {
      ...(overrideId === undefined ? {} : { id: overrideId }),
      path,
      title: titleFromPath(path),
      type: 'note',
      status: 'candidate',
      aliases: [],
      tags: [],
      properties: {},
      body: raw
    };
  }
}

function propertyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseReferenceTokens(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function normalizePathQuery(query: string): string {
  const slashed = query.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return slashed.endsWith('.md') ? slashed : `${slashed}.md`;
}

interface ChunkRow {
  chunk_key: string;
  document_key: string;
  path: string;
  title: string;
  heading: string | null;
  line_from: number;
  line_to: number;
  start_offset: number;
  end_offset: number;
  text: string;
  source_hash: string;
  reference_tokens_json: string;
  id: string | null;
}

interface DocumentRow {
  document_key: string;
  path: string;
  id: string | null;
  title?: string;
  type: string;
  status: string;
  project_norm: string | null;
  project_leaf: string | null;
}

interface LinkRow {
  source_document_key: string;
  source_path: string;
  kind: string;
  reference_target: string;
  reference_fragment: string | null;
  reference_syntax: string;
}

interface IndexedReference {
  kind: string;
  target: string;
  fragment?: string;
  syntax: LinkSyntax;
}

function chunkRowToSearchChunk(row: ChunkRow): SearchChunk {
  return {
    chunk_key: row.chunk_key,
    document_key: row.document_key,
    ...(row.id === null || row.id === undefined ? {} : { id: row.id }),
    path: row.path,
    title: row.title,
    heading: row.heading ?? null,
    line_from: row.line_from,
    line_to: row.line_to,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    text: row.text,
    source_hash: row.source_hash,
    reference_tokens: parseReferenceTokens(row.reference_tokens_json)
  };
}

function removeDocumentRows(
  database: Database.Database,
  documentKey: string,
  path: string
): void {
  const rows = database
    .prepare('SELECT row_id FROM chunks WHERE document_key = ? OR path = ?')
    .all(documentKey, path) as { row_id: number }[];
  if (rows.length > 0) {
    const deleteFts = database.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const row of rows) deleteFts.run(row.row_id);
  }
  database.prepare('DELETE FROM chunks WHERE document_key = ? OR path = ?').run(documentKey, path);
  database.prepare('DELETE FROM documents WHERE document_key = ? OR path = ?').run(documentKey, path);
  database.prepare('DELETE FROM document_properties WHERE document_key = ?').run(documentKey);
  database.prepare('DELETE FROM document_aliases WHERE document_key = ?').run(documentKey);
  database.prepare('DELETE FROM document_links WHERE source_document_key = ?').run(documentKey);
}

function mergeCandidates(
  lexical: readonly Candidate[],
  exact: readonly Candidate[],
  limit: number
): Candidate[] {
  const merged: Candidate[] = [];
  for (const candidate of [...lexical, ...exact]) {
    const existing = merged.find((entry) => entry.chunk_key === candidate.chunk_key);
    if (existing !== undefined) {
      for (const reason of candidate.reasons) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      }
      continue;
    }
    merged.push({ ...candidate, reasons: [...candidate.reasons] });
  }
  return merged.slice(0, limit).map((candidate, index) => ({ ...candidate, candidate_position: index }));
}

export interface ReplaceDocumentInput {
  path: string;
  raw: string;
  etag: string;
}

export interface CandidateQuery extends CandidateFilters {
  query: string;
  limit: number;
}

export interface SearchIndexEntry {
  path: string;
  raw: string;
  etag: string;
  id?: string;
  revision_id?: string;
}

export interface SearchIndex {
  replaceDocument(input: ReplaceDocumentInput): void;
  deletePath(path: string): void;
  candidates(input: CandidateQuery): Candidate[];
  expandGraph(seedKeys: readonly string[], filters: GraphFilters, limit: number): GraphExpansion;
  upsert(entry: SearchIndexEntry): void;
  remove(path: string): void;
  close(): void;
}

function isCorrupt(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.includes('NOTADB')) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /not a database/i.test(message);
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${path}${suffix}`;
    if (!existsSync(target)) continue;
    try {
      unlinkSync(target);
    } catch (cause) {
      throw recoveryRequired(`corrupt search database ${target} cannot be removed`, cause);
    }
  }
}

function initializeDatabase(database: Database.Database): void {
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = FULL');
  database.exec(readFileSync(SEARCH_SCHEMA_PATH, 'utf8'));
}

class SearchIndexImpl implements SearchIndex {
  private readonly database: Database.Database;
  private closed = false;

  constructor(database: Database.Database) {
    this.database = database;
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('the search index is closed');
  }

  replaceDocument(input: ReplaceDocumentInput): void {
    this.indexDocument(input.path, input.raw, input.etag);
  }

  upsert(entry: SearchIndexEntry): void {
    this.indexDocument(entry.path, entry.raw, entry.etag, entry.id);
  }

  remove(path: string): void {
    this.deletePath(path);
  }

  private referencesFor(raw: string): IndexedReference[] {
    const typed = extractRelationships(raw);
    const typedSpans = new Set(typed.map((edge) => `${edge.reference.start}:${edge.reference.end}`));
    const references: IndexedReference[] = [];
    for (const reference of extractLinks(raw)) {
      if (typedSpans.has(`${reference.start}:${reference.end}`)) continue;
      references.push({
        kind: 'link',
        target: reference.target,
        ...(reference.fragment === undefined ? {} : { fragment: reference.fragment }),
        syntax: reference.syntax
      });
    }
    for (const edge of typed) {
      references.push({
        kind: edge.kind,
        target: edge.reference.target,
        ...(edge.reference.fragment === undefined ? {} : { fragment: edge.reference.fragment }),
        syntax: edge.reference.syntax
      });
    }
    return references;
  }

  private indexDocument(path: string, raw: string, etag: string, overrideId?: string): void {
    this.assertOpen();
    if (typeof path !== 'string' || path.length === 0) {
      throw invalidInput('a document path is required');
    }
    if (typeof raw !== 'string') throw invalidInput('document raw must be a string');
    if (typeof etag !== 'string' || etag.length === 0) {
      throw invalidInput('a document etag is required');
    }
    const document = documentForIndex(raw, path, overrideId);
    const documentKey = document.id ?? path;
    const sourceHash = sha256(raw);
    const chunks = chunkDocument(document, raw);
    const references = this.referencesFor(raw);
    const aliasesJson = JSON.stringify(document.aliases);
    const tagsJson = JSON.stringify(document.tags);
    const propertiesJson = JSON.stringify(document.properties);
    const project = document.project ?? null;
    const parts = document.project === undefined ? undefined : projectParts(document.project);
    const updatedAt = new Date().toISOString();
    const aliasText = document.aliases.join(' ');
    const tagText = document.tags.join(' ');
    const database = this.database;
    const transaction = database.transaction(() => {
      removeDocumentRows(database, documentKey, path);
      database
        .prepare(
          'INSERT INTO documents (document_key, path, id, title, type, status, project, project_norm, project_leaf, aliases_json, tags_json, properties_json, source_hash, etag, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          documentKey,
          path,
          document.id ?? null,
          document.title,
          document.type,
          document.status,
          project,
          parts?.norm ?? null,
          parts?.leaf ?? null,
          aliasesJson,
          tagsJson,
          propertiesJson,
          sourceHash,
          etag,
          updatedAt
        );
      const insertProperty = database.prepare(
        'INSERT INTO document_properties (document_key, key, value) VALUES (?, ?, ?)'
      );
      for (const [key, value] of Object.entries(document.properties)) {
        insertProperty.run(documentKey, key, propertyValue(value));
      }
      const insertAlias = database.prepare(
        'INSERT INTO document_aliases (document_key, alias, alias_norm) VALUES (?, ?, ?)'
      );
      for (const alias of document.aliases) {
        insertAlias.run(documentKey, alias, alias.toLowerCase());
      }
      const insertChunk = database.prepare(
        'INSERT INTO chunks (chunk_key, document_key, path, title, heading, aliases_text, tags_text, line_from, line_to, start_offset, end_offset, text, source_hash, reference_tokens_json) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const insertFts = database.prepare(
        'INSERT INTO chunks_fts (rowid, title, aliases, tags, heading, text) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const chunk of chunks) {
        const info = insertChunk.run(
          chunk.chunk_key,
          documentKey,
          document.path,
          document.title,
          chunk.heading,
          aliasText,
          tagText,
          chunk.line_from,
          chunk.line_to,
          chunk.start_offset,
          chunk.end_offset,
          chunk.text,
          sourceHash,
          JSON.stringify(chunk.reference_tokens)
        );
        const rowId = Number(info.lastInsertRowid);
        insertFts.run(rowId, document.title, aliasText, tagText, chunk.heading, chunk.text);
      }
      const insertLink = database.prepare(
        'INSERT INTO document_links (source_document_key, source_path, kind, reference_target, reference_fragment, reference_syntax) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const reference of references) {
        insertLink.run(
          documentKey,
          document.path,
          reference.kind,
          reference.target,
          reference.fragment ?? null,
          reference.syntax
        );
      }
    });
    transaction.immediate();
  }

  deletePath(path: string): void {
    this.assertOpen();
    if (typeof path !== 'string' || path.length === 0) {
      throw invalidInput('a document path is required');
    }
    const row = this.database
      .prepare('SELECT document_key FROM documents WHERE path = ?')
      .get(path) as { document_key: string } | undefined;
    const documentKey = row?.document_key ?? path;
    const transaction = this.database.transaction(() => {
      removeDocumentRows(this.database, documentKey, path);
    });
    transaction.immediate();
  }

  private lexicalCandidates(
    match: string,
    filters: CandidateFilters,
    limit: number
  ): Candidate[] {
    const conditions: string[] = ['chunks_fts MATCH ?'];
    const parameters: unknown[] = [match];
    if (filters.project !== undefined) {
      const wanted = projectParts(filters.project);
      conditions.push('(d.project_norm = ? OR d.project_leaf = ?)');
      parameters.push(wanted.norm, wanted.leaf);
    }
    if (filters.types !== undefined && filters.types.length > 0) {
      conditions.push(`d.type IN (${filters.types.map(() => '?').join(', ')})`);
      parameters.push(...filters.types);
    }
    if (filters.statuses !== undefined && filters.statuses.length > 0) {
      conditions.push(`d.status IN (${filters.statuses.map(() => '?').join(', ')})`);
      parameters.push(...filters.statuses);
    }
    parameters.push(limit);
    const sql =
      `SELECT ${CHUNK_COLUMNS}, d.id AS id, ${FTS_RANK} AS rank ` +
      'FROM chunks_fts JOIN chunks c ON c.row_id = chunks_fts.rowid ' +
      'JOIN documents d ON d.document_key = c.document_key ' +
      `WHERE ${conditions.join(' AND ')} ` +
      'ORDER BY rank ASC, c.path ASC, c.start_offset ASC LIMIT ?';
    const rows = this.database.prepare(sql).all(...(parameters as never[])) as Array<
      ChunkRow & { rank: number }
    >;
    return rows.map((row) => ({
      ...chunkRowToSearchChunk(row),
      lexical_rank: Number(row.rank),
      candidate_position: 0,
      reasons: ['lexical']
    }));
  }

  private documentRow(documentKey: string): (DocumentRow & FilterableDocument) | undefined {
    const row = this.database
      .prepare(
        'SELECT document_key, path, id, type, status, project_norm, project_leaf FROM documents WHERE document_key = ?'
      )
      .get(documentKey) as (DocumentRow & FilterableDocument) | undefined;
    return row;
  }

  private exactCandidates(query: string, filters: CandidateFilters): Candidate[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const lowered = trimmed.toLowerCase();
    const pathQuery = normalizePathQuery(trimmed);
    const reasons = new Map<string, Set<string>>();
    const add = (documentKey: string, reason: string): void => {
      const set = reasons.get(documentKey) ?? new Set<string>();
      set.add(reason);
      reasons.set(documentKey, set);
    };
    const titleRows = this.database
      .prepare('SELECT document_key FROM documents WHERE LOWER(title) = ?')
      .all(lowered) as { document_key: string }[];
    for (const row of titleRows) add(row.document_key, 'title');
    const pathRows = this.database
      .prepare('SELECT document_key FROM documents WHERE LOWER(path) = ? OR LOWER(path) = ?')
      .all(lowered, pathQuery) as { document_key: string }[];
    for (const row of pathRows) add(row.document_key, 'path');
    const aliasRows = this.database
      .prepare('SELECT document_key FROM document_aliases WHERE alias_norm = ?')
      .all(lowered) as { document_key: string }[];
    for (const row of aliasRows) add(row.document_key, 'alias');
    const candidates: Candidate[] = [];
    for (const [documentKey, reasonSet] of reasons) {
      const document = this.documentRow(documentKey);
      if (document === undefined) continue;
      if (!documentMatchesFilters(document, filters)) continue;
      const chunk = this.firstChunk(documentKey);
      if (chunk === undefined) continue;
      candidates.push({
        ...chunk,
        lexical_rank: null,
        candidate_position: 0,
        reasons: [...reasonSet]
      });
    }
    candidates.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : left.start_offset - right.start_offset
    );
    return candidates;
  }

  candidates(input: CandidateQuery): Candidate[] {
    this.assertOpen();
    const query = typeof input?.query === 'string' ? input.query : '';
    const match = literalMatch(query);
    if (match === null) throw invalidInput('the query has no searchable terms');
    const limit = clampCandidateLimit(input?.limit ?? 0);
    if (limit === 0) return [];
    const types = normalizeTypes(input?.types);
    const statuses = normalizeStatuses(input?.statuses);
    const project =
      typeof input?.project === 'string' && input.project.trim().length > 0
        ? input.project
        : undefined;
    const filters: CandidateFilters = {
      ...(project === undefined ? {} : { project }),
      ...(types.length === 0 ? {} : { types }),
      ...(statuses.length === 0 ? {} : { statuses })
    };
    const lexical = this.lexicalCandidates(match, filters, limit);
    const exact = this.exactCandidates(query, filters);
    return mergeCandidates(lexical, exact, limit);
  }

  private firstChunk(documentKey: string): SearchChunk | undefined {
    const row = this.database
      .prepare(
        `SELECT ${CHUNK_COLUMNS}, d.id AS id FROM chunks c ` +
          'JOIN documents d ON d.document_key = c.document_key ' +
          'WHERE c.document_key = ? ORDER BY c.start_offset ASC LIMIT 1'
      )
      .get(documentKey) as ChunkRow | undefined;
    return row === undefined ? undefined : chunkRowToSearchChunk(row);
  }

  private bestChunk(documentKey: string, query: string): SearchChunk | undefined {
    const match = literalMatch(query);
    if (match === null) return undefined;
    const row = this.database
      .prepare(
        `SELECT ${CHUNK_COLUMNS}, d.id AS id, ${FTS_RANK} AS rank FROM chunks_fts ` +
          'JOIN chunks c ON c.row_id = chunks_fts.rowid ' +
          'JOIN documents d ON d.document_key = c.document_key ' +
          'WHERE chunks_fts MATCH ? AND c.document_key = ? ' +
          'ORDER BY rank ASC, c.start_offset ASC LIMIT 1'
      )
      .get(match, documentKey) as ChunkRow | undefined;
    return row === undefined ? undefined : chunkRowToSearchChunk(row);
  }

  private graphDocument(documentKey: string): GraphDocument | undefined {
    const row = this.documentRow(documentKey);
    if (row === undefined) return undefined;
    return {
      document_key: row.document_key,
      path: row.path,
      ...(row.id === null ? {} : { id: row.id }),
      type: row.type,
      status: row.status,
      project_norm: row.project_norm,
      project_leaf: row.project_leaf
    };
  }

  private edgesTouching(seedKeys: readonly string[]): GraphStoredEdge[] {
    const rows = this.database
      .prepare(
        'SELECT source_document_key, source_path, kind, reference_target, reference_fragment, reference_syntax FROM document_links'
      )
      .all() as LinkRow[];
    if (rows.length === 0) return [];
    const catalogue = new Map<string, string | undefined>();
    const documentRows = this.database
      .prepare('SELECT path, id FROM documents')
      .all() as { path: string; id: string | null }[];
    for (const row of documentRows) catalogue.set(row.path, row.id ?? undefined);
    const seeds = new Set(seedKeys);
    const edges: GraphStoredEdge[] = [];
    for (const row of rows) {
      const resolution = resolveLink(
        {
          target: row.reference_target,
          ...(row.reference_fragment === null ? {} : { fragment: row.reference_fragment }),
          syntax: row.reference_syntax as LinkSyntax
        },
        row.source_path,
        catalogue
      );
      if (resolution.state !== 'resolved') continue;
      const target = resolution.id ?? resolution.path;
      if (!seeds.has(row.source_document_key) && !seeds.has(target)) continue;
      edges.push({ source: row.source_document_key, target, relationship: row.kind });
    }
    return edges;
  }

  expandGraph(seedKeys: readonly string[], filters: GraphFilters, limit: number): GraphExpansion {
    this.assertOpen();
    const store: GraphStore = {
      edgesTouching: (seeds) => this.edgesTouching(seeds),
      documentFor: (key) => this.graphDocument(key),
      firstChunk: (key) => this.firstChunk(key),
      bestChunk: (key, query) => this.bestChunk(key, query)
    };
    return expandGraph(store, seedKeys, filters, limit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch {
      return;
    }
  }
}

export function openSearchIndex(path: string): SearchIndex {
  if (typeof path !== 'string' || path.length === 0) {
    throw invalidInput('a search database path is required');
  }
  const memory = path === ':memory:';
  if (!memory) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (cause) {
      throw recoveryRequired(`search database directory for ${path} cannot be created`, cause);
    }
  }
  let database: Database.Database;
  try {
    database = new Database(path);
  } catch (cause) {
    throw recoveryRequired(`search database at ${path} cannot be opened`, cause);
  }
  try {
    initializeDatabase(database);
  } catch (error) {
    const corrupt = !memory && isCorrupt(error);
    try {
      database.close();
    } catch {
    }
    if (!corrupt) {
      throw recoveryRequired(`search database at ${path} cannot be initialized`, error);
    }
    removeDatabaseFiles(path);
    try {
      database = new Database(path);
      initializeDatabase(database);
    } catch (cause) {
      throw recoveryRequired(`search database at ${path} cannot be rebuilt`, cause);
    }
  }
  return new SearchIndexImpl(database);
}
