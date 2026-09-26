import { conflict, invalidInput, limitExceeded, notFound } from './errors.js';
import type { SearchIndex } from './index/search-index.js';
import type { Sync } from './index/sync.js';
import type { Projects } from './projects.js';
import type { Store } from './store.js';
import { LIMITS, type FeedbackSummary, type NoteType, type Verdict } from './types.js';
import { parseNote, renderNote, type ParsedNote } from './vault/note-file.js';
import { assertNotePath, dirOf, noteDirectory, projectOfPath, sanitizeFileStem, stemOf, withCollisionSuffix } from './vault/paths.js';
import { sha256, type Vault } from './vault/vault.js';

export interface NoteRef {
  id?: string;
  path?: string;
}

export interface CaptureInput {
  title: string;
  body: string;
  type?: NoteType;
  tags?: string[];
  project?: string;
  idempotency_key?: string;
}

export interface UpdateInput extends NoteRef {
  expected_hash: string;
  title?: string;
  body?: string;
  type?: NoteType;
  tags?: string[];
  project?: string;
}

export interface DeleteInput extends NoteRef {
  expected_hash: string;
}

export interface FeedbackInput extends NoteRef {
  verdict: Verdict;
  reason?: string;
}

export interface WriteResult {
  id: string;
  path: string;
  hash: string;
}

export interface NoteView {
  id: string | null;
  path: string;
  project: string | null;
  title: string;
  type: NoteType;
  tags: string[];
  created: string;
  updated: string;
  hash: string;
  body: string;
  feedback: FeedbackSummary;
  demoted: boolean;
}

export interface NotesDeps {
  vault: Vault;
  index: SearchIndex;
  sync: Sync;
  store: Store;
  projects: Projects;
  now: () => Date;
  newId: () => string;
}

const STALE_HASH = 'the note changed since it was read; read it again and retry with its current hash';
const H1_START = /^(?:[ \t]*\r?\n)*# /;

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > LIMITS.titleChars || /[\r\n]/.test(trimmed)) {
    throw invalidInput(`title must be 1-${LIMITS.titleChars} characters on a single line`);
  }
  return trimmed;
}

function validateBody(body: string): string {
  if (H1_START.test(body)) throw invalidInput('body must not start with an H1; the title is written as the H1');
  return body;
}

function validateTags(tags: readonly string[]): string[] {
  if (tags.length > LIMITS.tagsMax) throw invalidInput(`at most ${LIMITS.tagsMax} tags are allowed`);
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length === 0 || trimmed.length > LIMITS.tagChars) throw invalidInput(`tags must be 1-${LIMITS.tagChars} characters`);
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function sized(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.noteWriteBytes) {
    throw limitExceeded(`the note would exceed ${LIMITS.noteWriteBytes} bytes`);
  }
  return raw;
}

export class Notes {
  constructor(private readonly deps: NotesDeps) {}

  resolvePath(ref: NoteRef): string {
    if ((ref.id === undefined) === (ref.path === undefined)) throw invalidInput('give exactly one of id or path');
    if (ref.path !== undefined) {
      const path = assertNotePath(ref.path);
      if (!this.deps.vault.exists(path)) throw notFound(`note not found: ${path}`);
      return path;
    }
    const id = ref.id as string;
    const lookup = (): string[] =>
      this.deps.index.byId(id).map((note) => note.path).filter((path) => this.deps.vault.exists(path));
    let paths = lookup();
    if (paths.length === 0) {
      this.deps.sync.scan();
      paths = lookup();
    }
    if (paths.length === 0) throw notFound(`note not found: ${id}`);
    if (paths.length > 1) throw conflict(`id ${id} is used by more than one note (${paths.join(', ')}); address it by path`);
    return paths[0];
  }

  private load(path: string): { raw: string; parsed: ParsedNote } {
    const raw = this.deps.vault.read(path);
    const parsed = parseNote(raw);
    if (parsed.isProject) throw invalidInput(`${path} is a project note, not a note`);
    return { raw, parsed };
  }

  private freePath(directory: string, title: string, project: string | null, current: string | null): string {
    const join = (stem: string): string => (directory === '' ? `${stem}.md` : `${directory}/${stem}.md`);
    const stem = withCollisionSuffix(sanitizeFileStem(title), (candidate) => {
      const path = join(candidate);
      if (path === current) return false;
      return (project !== null && candidate === project) || this.deps.vault.exists(path);
    });
    return join(stem);
  }

  private persist(path: string, raw: string, id: string): WriteResult {
    this.deps.vault.write(path, raw);
    this.deps.sync.indexFile(path);
    return { id, path, hash: sha256(raw) };
  }

  capture(input: CaptureInput): WriteResult {
    const title = validateTitle(input.title);
    const body = validateBody(input.body);
    const type = input.type ?? 'note';
    const tags = validateTags(input.tags ?? []);
    const project = input.project === undefined ? null : this.deps.projects.resolve(input.project).name;
    const payloadHash = sha256(JSON.stringify({ title, body, type, tags, project }));
    const now = this.deps.now().toISOString();
    const key = input.idempotency_key;
    if (key !== undefined) {
      const reserved = this.deps.store.getIdempotency(key);
      if (reserved !== undefined) {
        if (reserved.payload_hash !== payloadHash) throw conflict('idempotency_key was already used with a different payload');
        if (this.deps.vault.exists(reserved.path)) {
          return { id: reserved.note_id, path: reserved.path, hash: sha256(this.deps.vault.read(reserved.path)) };
        }
        const raw = sized(renderNote({ id: reserved.note_id, type, tags, title, body, created: now, updated: now }));
        return this.persist(reserved.path, raw, reserved.note_id);
      }
    }
    const id = this.deps.newId();
    const path = this.freePath(noteDirectory(project), title, project, null);
    const raw = sized(renderNote({ id, type, tags, title, body, created: now, updated: now }));
    if (key !== undefined) {
      this.deps.store.reserveIdempotency({ key, payload_hash: payloadHash, note_id: id, path, created_at: now });
    }
    return this.persist(path, raw, id);
  }

  update(input: UpdateInput): WriteResult {
    if (input.title === undefined && input.body === undefined && input.type === undefined && input.tags === undefined &&
      input.project === undefined) {
      throw invalidInput('give at least one of title, body, type, tags, project');
    }
    const path = this.resolvePath(input);
    const raw = this.deps.vault.read(path);
    if (sha256(raw) !== input.expected_hash) throw conflict(STALE_HASH);
    const { parsed } = this.load(path);
    const currentTitle = parsed.title ?? stemOf(path);
    const title = input.title === undefined ? currentTitle : validateTitle(input.title);
    const body = input.body === undefined ? parsed.body : validateBody(input.body);
    const project = input.project === undefined ? projectOfPath(path) : this.deps.projects.resolve(input.project).name;
    const directory = input.project === undefined ? dirOf(path) : noteDirectory(project);
    const target =
      directory !== dirOf(path) || title !== currentTitle ? this.freePath(directory, title, project, path) : path;
    const id = parsed.id ?? this.deps.newId();
    const next = sized(
      renderNote(
        {
          id,
          type: input.type ?? parsed.type,
          tags: input.tags === undefined ? parsed.tags : validateTags(input.tags),
          title,
          body,
          created: parsed.created ?? new Date(this.deps.vault.stat(path).mtimeMs).toISOString(),
          updated: this.deps.now().toISOString()
        },
        raw
      )
    );
    this.deps.vault.write(target, next);
    if (target !== path) {
      this.deps.vault.remove(path);
      this.deps.sync.removeFile(path);
    }
    this.deps.sync.indexFile(target);
    return { id, path: target, hash: sha256(next) };
  }

  delete(input: DeleteInput): { trashed_path: string } {
    const path = this.resolvePath(input);
    const { raw, parsed } = this.load(path);
    if (sha256(raw) !== input.expected_hash) throw conflict(STALE_HASH);
    const trashed = this.deps.vault.trash(path);
    this.deps.sync.removeFile(path);
    if (parsed.id !== null) this.deps.store.deleteFeedback(parsed.id);
    return { trashed_path: trashed };
  }

  read(ref: NoteRef): NoteView {
    const path = this.resolvePath(ref);
    const stat = this.deps.vault.stat(path);
    if (stat.size > LIMITS.noteReadBytes) throw limitExceeded(`the note is larger than ${LIMITS.noteReadBytes} bytes`);
    const { raw, parsed } = this.load(path);
    const hash = sha256(raw);
    const fallback = new Date(stat.mtimeMs).toISOString();
    return {
      id: parsed.id,
      path,
      project: projectOfPath(path),
      title: parsed.title ?? stemOf(path),
      type: parsed.type,
      tags: parsed.tags,
      created: parsed.created ?? fallback,
      updated: parsed.updated ?? fallback,
      hash,
      body: parsed.body,
      feedback: parsed.id === null ? {} : this.deps.store.feedbackSummary(parsed.id),
      demoted: parsed.id !== null && this.deps.store.isDemoted(parsed.id, hash)
    };
  }

  feedback(input: FeedbackInput): { recorded: true } {
    if (input.reason !== undefined && input.reason.length > LIMITS.reasonChars) {
      throw invalidInput(`reason must be at most ${LIMITS.reasonChars} characters`);
    }
    const path = this.resolvePath(input);
    const { raw, parsed } = this.load(path);
    if (parsed.id === null) throw invalidInput(`${path} has no id yet; call brain_update on it first`);
    this.deps.store.addFeedback({
      note_id: parsed.id,
      verdict: input.verdict,
      reason: input.reason ?? null,
      note_hash: sha256(raw),
      created_at: this.deps.now().toISOString()
    });
    return { recorded: true };
  }
}
