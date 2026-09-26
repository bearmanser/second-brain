import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { SearchIndex } from './index/search-index.js';
import { Sync } from './index/sync.js';
import { NOTE_TYPES, type NoteType } from './types.js';
import { renderProjectNote, splitFrontmatter } from './vault/note-file.js';
import { isProjectNotePath, projectNotePath, sanitizeFileStem, stemOf, withCollisionSuffix } from './vault/paths.js';
import { Vault } from './vault/vault.js';

export interface ImportOptions {
  from: string;
  to: string;
  journal: string;
  dryRun?: boolean;
}

export interface ImportReport {
  written: string[];
  skipped: { path: string; reason: string }[];
  notCopied: string[];
  linksRewritten: number;
  unresolvedLinks: string[];
}

interface OldNote {
  id: string | null;
  type: NoteType;
  tags: string[];
  created: string;
  updated: string;
  title: string | null;
  content: string;
  archived: boolean;
  hub: boolean;
}

interface SourceNote {
  oldPath: string;
  project: string;
  id: string | null;
  raw: string;
  parsed: OldNote;
}

const LINK = /(!?\[\[)([^\]]+)(\]\])/g;
const H1 = /^# (.+?)[ \t]*$/m;

function readOld(raw: string, mtimeMs: number): OldNote {
  const { frontmatter, content } = splitFrontmatter(raw);
  let data: Record<string, unknown> = {};
  if (frontmatter !== null && frontmatter.trim().length > 0) {
    const parsed: unknown = parseYaml(frontmatter);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  }
  const heading = H1.exec(content);
  const rawType = data.type;
  const type: NoteType =
    typeof rawType === 'string' && (NOTE_TYPES as readonly string[]).includes(rawType) ? (rawType as NoteType) : 'note';
  const fallback = new Date(mtimeMs).toISOString();
  return {
    id: typeof data.id === 'string' ? data.id : null,
    type,
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    created: typeof data.created === 'string' ? data.created : fallback,
    updated: typeof data.updated === 'string' ? data.updated : fallback,
    title: heading === null ? null : heading[1],
    content,
    archived: data.status === 'archived',
    hub: rawType === 'project'
  };
}

function writeTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) writeTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

function walkFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function readJournal(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(file)) return out;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT display_name, repository_identity FROM projects_v2').all() as {
      display_name: string;
      repository_identity: string;
    }[];
    for (const row of rows) {
      const list = out.get(row.display_name) ?? [];
      list.push(row.repository_identity);
      out.set(row.display_name, list);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the project journal at ${file}: ${message}`);
  } finally {
    db?.close();
  }
  return out;
}

function addMapping(mapping: Map<string, string>, oldPath: string, newPath: string): void {
  const target = newPath.replace(/\.md$/, '');
  const source = oldPath.replace(/\.md$/, '');
  mapping.set(source, target);
  mapping.set(`${source}.md`, target);
}

function replaceLinks(
  content: string,
  mapping: Map<string, string>,
  stems: Map<string, string[]>,
  report: ImportReport,
  unresolved: Set<string>
): string {
  return content.replace(LINK, (whole: string, open: string, target: string, close: string) => {
    const bar = target.indexOf('|');
    const alias = bar < 0 ? '' : target.slice(bar);
    const bare = bar < 0 ? target : target.slice(0, bar);
    const hashIndex = bare.indexOf('#');
    const hash = hashIndex < 0 ? '' : bare.slice(hashIndex);
    const name = (hashIndex < 0 ? bare : bare.slice(0, hashIndex)).trim();
    let replacement = mapping.get(name);
    if (replacement === undefined) {
      const candidates = stems.get(stemOf(name).toLowerCase());
      if (candidates !== undefined && candidates.length === 1) replacement = candidates[0];
    }
    if (replacement === undefined) {
      unresolved.add(name);
      return whole;
    }
    if (replacement !== name) report.linksRewritten += 1;
    return `${open}${replacement}${hash}${alias}${close}`;
  });
}

function importedRaw(parsed: OldNote, content: string): string {
  const data: Record<string, unknown> = { id: parsed.id, type: parsed.type, tags: parsed.tags, created: parsed.created, updated: parsed.updated };
  if (parsed.id === null) delete data.id;
  // splitFrontmatter leaves the blank line that separates frontmatter from the body as content's leading `\n`;
  // re-add the `\n` it consumed as the `---` line terminator so the body stays byte-identical.
  return `---\n${stringify(data).trimEnd()}\n---\n${content}`;
}

export function runImport(options: ImportOptions): ImportReport {
  const report: ImportReport = { written: [], skipped: [], notCopied: [], linksRewritten: 0, unresolvedLinks: [] };
  const unresolved = new Set<string>();
  if (existsSync(options.to) && readdirSync(options.to).length > 0) {
    throw new Error(`the target vault is not empty: ${options.to}`);
  }

  const projectsRoot = join(options.from, 'Projects');
  const projectNames = existsSync(projectsRoot)
    ? readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
    : [];

  const notes: SourceNote[] = [];
  const hubs = new Map<string, string>();
  for (const project of projectNames) {
    for (const file of walkFiles(join(projectsRoot, project), `Projects/${project}`)) {
      if (!file.endsWith('.md')) {
        report.notCopied.push(file);
        continue;
      }
      const absolute = join(options.from, file);
      const raw = readFileSync(absolute, 'utf8');
      const parsed = readOld(raw, statSync(absolute).mtimeMs);
      if (parsed.hub || isProjectNotePath(file)) {
        hubs.set(project, file);
        continue;
      }
      notes.push({ oldPath: file, project, id: parsed.id, raw, parsed });
    }
  }

  const kept: SourceNote[] = [];
  for (const note of notes) {
    if (note.parsed.archived) {
      report.skipped.push({ path: note.oldPath, reason: 'archived' });
      continue;
    }
    kept.push(note);
  }

  const byId = new Map<string, string[]>();
  for (const note of kept) {
    if (note.id === null) continue;
    const list = byId.get(note.id) ?? [];
    list.push(note.oldPath);
    byId.set(note.id, list);
  }
  for (const [id, paths] of byId) {
    if (paths.length > 1) throw new Error(`duplicate id ${id} in ${paths.join(', ')}`);
  }

  const mapping = new Map<string, string>();
  const stems = new Map<string, string[]>();
  const planned = new Set<string>();
  const destinations = new Map<string, string>();
  for (const name of projectNames) addMapping(mapping, projectNotePath(name), projectNotePath(name));

  // Pass 1: build the complete old->new map before rewriting any link, so a
  // path-qualified link resolves even when its target is processed later.
  for (const note of kept) {
    const directory = `Projects/${note.project}`;
    const title = note.parsed.title ?? stemOf(note.oldPath);
    const stem = withCollisionSuffix(sanitizeFileStem(title), (candidate) => {
      const path = `${directory}/${candidate}.md`;
      return candidate === note.project || planned.has(path) || existsSync(join(options.to, path));
    });
    const path = `${directory}/${stem}.md`;
    planned.add(path);
    destinations.set(note.oldPath, path);
    addMapping(mapping, note.oldPath, path);
    const key = stemOf(note.oldPath).toLowerCase();
    stems.set(key, [...(stems.get(key) ?? []), path.replace(/\.md$/, '')]);
  }

  const outputs: { path: string; raw: string }[] = [];
  // Pass 2: rewrite links against the complete map and assemble each note.
  for (const note of kept) {
    const path = destinations.get(note.oldPath)!;
    const content = replaceLinks(splitFrontmatter(note.raw).content, mapping, stems, report, unresolved);
    outputs.push({ path, raw: importedRaw(note.parsed, content) });
  }

  const journal = readJournal(options.journal);
  for (const name of projectNames) {
    const oldHub = hubs.get(name);
    let previous: string | undefined;
    if (oldHub !== undefined) {
      const content = replaceLinks(splitFrontmatter(readFileSync(join(options.from, oldHub), 'utf8')).content, mapping, stems, report, unresolved);
      previous = `---\ntype: project\n---${content}`;
    }
    outputs.push({ path: projectNotePath(name), raw: renderProjectNote(name, journal.get(name) ?? [], previous) });
  }

  if (!options.dryRun) {
    for (const output of outputs) {
      const absolute = join(options.to, output.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, output.raw);
    }
    const obsidian = join(options.from, '.obsidian');
    if (existsSync(obsidian)) writeTree(obsidian, join(options.to, '.obsidian'));
  }
  report.written.push(...outputs.map((output) => output.path).sort());

  for (const entry of readdirSync(options.from, { withFileTypes: true })) {
    if (entry.name === 'Projects' || entry.name === '.obsidian') continue;
    report.notCopied.push(entry.name);
  }
  report.notCopied.sort();
  report.unresolvedLinks = [...unresolved].sort();

  if (!options.dryRun) {
    const vault = new Vault(options.to);
    const index = SearchIndex.open(':memory:');
    const sync = new Sync(vault, index);
    sync.scan();
    const problems = sync.problems();
    if (problems.length > 0) {
      report.written.forEach((path) => unlinkSync(join(options.to, path)));
      throw new Error(`the imported vault has problems: ${problems.map((problem) => `${problem.path}: ${problem.problem}`).join('; ')}`);
    }
    index.close();
  }
  return report;
}

export function formatReport(report: ImportReport): string {
  const lines = [
    `written: ${report.written.length}`,
    ...report.written.map((path) => `  + ${path}`),
    `skipped: ${report.skipped.length}`,
    ...report.skipped.map((entry) => `  - ${entry.path} (${entry.reason})`),
    `not copied: ${report.notCopied.length}`,
    ...report.notCopied.map((path) => `  ! ${path}`),
    `links rewritten: ${report.linksRewritten}`,
    `unresolved links: ${report.unresolvedLinks.length}`,
    ...report.unresolvedLinks.map((target) => `  ? ${target}`)
  ];
  return `${lines.join('\n')}\n`;
}
