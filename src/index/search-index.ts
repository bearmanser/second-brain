import Database from 'better-sqlite3';
import type { NoteType } from '../types.js';
import type { Chunk } from './chunker.js';

export interface IndexedNote {
  path: string;
  id: string | null;
  title: string;
  type: NoteType;
  project: string | null;
  tags: string[];
  created: string | null;
  updated: string | null;
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface ChunkHit {
  path: string;
  heading: string | null;
  text: string;
  rank: number;
}

export interface SearchFilters {
  project?: string;
  types?: readonly NoteType[];
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE notes (
  path TEXT PRIMARY KEY,
  id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  project TEXT,
  tags_json TEXT NOT NULL,
  created TEXT,
  updated TEXT,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL
);
CREATE INDEX notes_id_idx ON notes(id);
CREATE INDEX notes_project_idx ON notes(project);
CREATE TABLE chunks (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  heading TEXT,
  text TEXT NOT NULL
);
CREATE INDEX chunks_path_idx ON chunks(path);
CREATE VIRTUAL TABLE chunks_fts USING fts5(title, tags, heading, text, tokenize = 'unicode61 remove_diacritics 2');
`;

const TERM = /[\p{L}\p{N}][\p{L}\p{N}_]*/gu;
const MAX_TERMS = 64;

export function literalMatch(query: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(TERM)) {
    const key = match[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(match[0]);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.length === 0 ? null : terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

interface NoteRow {
  path: string;
  id: string | null;
  title: string;
  type: string;
  project: string | null;
  tags_json: string;
  created: string | null;
  updated: string | null;
  hash: string;
  size: number;
  mtime_ms: number;
}

function toNote(row: NoteRow): IndexedNote {
  return {
    path: row.path,
    id: row.id,
    title: row.title,
    type: row.type as NoteType,
    project: row.project,
    tags: JSON.parse(row.tags_json) as string[],
    created: row.created,
    updated: row.updated,
    hash: row.hash,
    size: row.size,
    mtimeMs: row.mtime_ms
  };
}

export class SearchIndex {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): SearchIndex {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS notes;');
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    return new SearchIndex(db);
  }

  private deleteRows(path: string): void {
    this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)').run(path);
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(path);
  }

  upsert(note: IndexedNote, chunks: Chunk[]): void {
    this.db.transaction(() => {
      this.deleteRows(note.path);
      this.db
        .prepare(
          `INSERT INTO notes (path, id, title, type, project, tags_json, created, updated, hash, size, mtime_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(note.path, note.id, note.title, note.type, note.project, JSON.stringify(note.tags), note.created,
          note.updated, note.hash, note.size, note.mtimeMs);
      const insertChunk = this.db.prepare('INSERT INTO chunks (path, heading, text) VALUES (?, ?, ?)');
      const insertFts = this.db.prepare('INSERT INTO chunks_fts (rowid, title, tags, heading, text) VALUES (?, ?, ?, ?, ?)');
      for (const chunk of chunks) {
        const info = insertChunk.run(note.path, chunk.heading, chunk.text);
        insertFts.run(info.lastInsertRowid, note.title, note.tags.join(' '), chunk.heading ?? '', chunk.text);
      }
    })();
  }

  remove(path: string): void {
    this.db.transaction(() => this.deleteRows(path))();
  }

  get(path: string): IndexedNote | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE path = ?').get(path) as NoteRow | undefined;
    return row === undefined ? undefined : toNote(row);
  }

  byId(id: string): IndexedNote[] {
    return (this.db.prepare('SELECT * FROM notes WHERE id = ? ORDER BY path').all(id) as NoteRow[]).map(toNote);
  }

  all(): IndexedNote[] {
    return (this.db.prepare('SELECT * FROM notes ORDER BY path').all() as NoteRow[]).map(toNote);
  }

  duplicateIds(): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT id, json_group_array(path) AS paths
         FROM (SELECT id, path FROM notes WHERE id IS NOT NULL ORDER BY path)
         GROUP BY id HAVING COUNT(*) > 1 ORDER BY id`
      )
      .all() as { id: string; paths: string }[];
    return new Map(rows.map((row) => [row.id, JSON.parse(row.paths) as string[]]));
  }

  search(query: string, filters: SearchFilters, limit: number): ChunkHit[] {
    const match = literalMatch(query);
    if (match === null) return [];
    const conditions = ['chunks_fts MATCH ?'];
    const params: unknown[] = [match];
    if (filters.project !== undefined) {
      conditions.push('n.project = ?');
      params.push(filters.project);
    }
    if (filters.types !== undefined && filters.types.length > 0) {
      conditions.push(`n.type IN (${filters.types.map(() => '?').join(', ')})`);
      params.push(...filters.types);
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT c.path AS path, c.heading AS heading, c.text AS text, bm25(chunks_fts, 8.0, 6.0, 3.0, 1.0) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN notes n ON n.path = c.path
         WHERE ${conditions.join(' AND ')}
         ORDER BY rank ASC, c.path ASC, c.rowid ASC
         LIMIT ?`
      )
      .all(...params) as ChunkHit[];
  }

  close(): void {
    this.db.close();
  }
}
