import Database from 'better-sqlite3';
import { NEGATIVE_VERDICTS, type FeedbackSummary, type Verdict } from './types.js';

export interface FeedbackRow {
  note_id: string;
  verdict: Verdict;
  reason: string | null;
  note_hash: string;
  created_at: string;
}

export interface IdempotencyRow {
  key: string;
  payload_hash: string;
  note_id: string;
  path: string;
  created_at: string;
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE feedback (
  rowid INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  note_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_note_idx ON feedback(note_id, rowid);
CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  note_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export class Store {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): Store {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version === 0) {
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`brain.db schema version ${version} is not supported by this build`);
    }
    return new Store(db);
  }

  addFeedback(row: FeedbackRow): void {
    this.db
      .prepare('INSERT INTO feedback (note_id, verdict, reason, note_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.note_id, row.verdict, row.reason, row.note_hash, row.created_at);
  }

  latestFeedback(noteId: string): FeedbackRow | undefined {
    return this.db
      .prepare(
        'SELECT note_id, verdict, reason, note_hash, created_at FROM feedback WHERE note_id = ? ORDER BY rowid DESC LIMIT 1'
      )
      .get(noteId) as FeedbackRow | undefined;
  }

  feedbackSummary(noteId: string): FeedbackSummary {
    const rows = this.db
      .prepare('SELECT verdict, COUNT(*) AS count FROM feedback WHERE note_id = ? GROUP BY verdict ORDER BY verdict')
      .all(noteId) as { verdict: Verdict; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.verdict, row.count])) as FeedbackSummary;
  }

  isDemoted(noteId: string, currentHash: string): boolean {
    const latest = this.latestFeedback(noteId);
    return latest !== undefined && NEGATIVE_VERDICTS.has(latest.verdict) && latest.note_hash === currentHash;
  }

  deleteFeedback(noteId: string): void {
    this.db.prepare('DELETE FROM feedback WHERE note_id = ?').run(noteId);
  }

  getIdempotency(key: string): IdempotencyRow | undefined {
    return this.db
      .prepare('SELECT key, payload_hash, note_id, path, created_at FROM idempotency WHERE key = ?')
      .get(key) as IdempotencyRow | undefined;
  }

  reserveIdempotency(row: IdempotencyRow): void {
    this.db
      .prepare('INSERT INTO idempotency (key, payload_hash, note_id, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.key, row.payload_hash, row.note_id, row.path, row.created_at);
  }

  close(): void {
    this.db.close();
  }
}
