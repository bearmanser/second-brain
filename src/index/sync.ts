import { isBrainError } from '../errors.js';
import { parseNote, type ParsedNote } from '../vault/note-file.js';
import { isProjectNotePath, projectOfPath, stemOf } from '../vault/paths.js';
import { sha256, type Vault } from '../vault/vault.js';
import { chunkNote } from './chunker.js';
import type { SearchIndex } from './search-index.js';

export interface Problem {
  path: string;
  problem: string;
}

export class Sync {
  private readonly fileProblems = new Map<string, string>();

  constructor(
    private readonly vault: Vault,
    private readonly index: SearchIndex
  ) {}

  scan(): void {
    const seen = new Set<string>();
    for (const file of this.vault.list()) {
      seen.add(file.path);
      const row = this.index.get(file.path);
      if (row !== undefined && row.size === file.size && row.mtimeMs === file.mtimeMs) continue;
      this.indexFile(file.path);
    }
    for (const note of this.index.all()) if (!seen.has(note.path)) this.index.remove(note.path);
    for (const path of [...this.fileProblems.keys()]) if (!seen.has(path)) this.fileProblems.delete(path);
  }

  indexFile(path: string): void {
    let raw: string;
    let stat: { size: number; mtimeMs: number };
    try {
      raw = this.vault.read(path);
      stat = this.vault.stat(path);
    } catch (error) {
      if (isBrainError(error) && error.code === 'NOT_FOUND') {
        this.removeFile(path);
        return;
      }
      throw error;
    }
    let parsed: ParsedNote;
    try {
      parsed = parseNote(raw);
    } catch (error) {
      this.index.remove(path);
      this.fileProblems.set(path, isBrainError(error) ? error.message : 'the note could not be parsed');
      return;
    }
    if (parsed.isProject) {
      this.index.remove(path);
      if (isProjectNotePath(path)) this.fileProblems.delete(path);
      else this.fileProblems.set(path, 'type: project is only valid at Projects/<Name>/<Name>.md');
      return;
    }
    this.fileProblems.delete(path);
    const title = parsed.title ?? stemOf(path);
    this.index.upsert(
      {
        path,
        id: parsed.id,
        title,
        type: parsed.type,
        project: projectOfPath(path),
        tags: parsed.tags,
        created: parsed.created,
        updated: parsed.updated,
        hash: sha256(raw),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      },
      chunkNote(title, parsed.body)
    );
  }

  removeFile(path: string): void {
    this.index.remove(path);
    this.fileProblems.delete(path);
  }

  problems(): Problem[] {
    const problems: Problem[] = [...this.fileProblems].map(([path, problem]) => ({ path, problem }));
    for (const [id, paths] of this.index.duplicateIds()) {
      for (const path of paths) {
        problems.push({ path, problem: `duplicate id ${id} (also: ${paths.filter((other) => other !== path).join(', ')})` });
      }
    }
    return problems.sort((left, right) => left.path.localeCompare(right.path));
  }
}
