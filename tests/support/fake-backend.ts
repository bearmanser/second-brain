import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { BrainError } from '../../src/contracts/errors.js';
import type { BackendHit, BackendPort, BackendSearch, PlannedWrite, ScopeConfig } from '../../src/core/types.js';
import { slugify } from '../../src/notes/identity.js';

export type FakeBackendFault =
  | 'before_write'
  | 'after_write'
  | 'search_unavailable'
  | 'embedding_unavailable';

export interface FakeBackendOptions {
  root: string;
  projects?: readonly string[];
}

interface MaterialisedNote {
  relative_path: string;
  permalink: string;
  revision_id: string;
  logical_id: string;
  kind: string;
  status: string;
  excerpt: string;
  searchable: string;
}

const FAKE_SERVER_VERSION = '4.0.0b1';
const FAKE_TOOLS = [
  'read_note',
  'search_notes',
  'write_note',
  'list_memory_projects',
  'create_memory_project'
];
const EXCERPT_MAX_CHARS = 240;

const unavailable = (message: string): BrainError =>
  new BrainError({ code: 'BACKEND_UNAVAILABLE', message });

const conflict = (message: string): BrainError => new BrainError({ code: 'CONFLICT', message });

const invalidInput = (message: string): BrainError =>
  new BrainError({ code: 'INVALID_INPUT', message });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalString = (source: Record<string, unknown>, key: string): string =>
  typeof source[key] === 'string' ? (source[key] as string) : '';

const splitFrontmatter = (raw: string): Record<string, unknown> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) return {};
  try {
    return asRecord(parse(match[1]));
  } catch {
    return {};
  }
};

const toPosix = (value: string): string => value.split(sep).join('/');

export class FakeBackend implements BackendPort {
  readonly root: string;
  private readonly configuredProjects: string[];
  private readonly scopeMappings = new Map<string, { backend_project: string; relative_root: string }>();
  readonly create_calls: PlannedWrite[] = [];
  fail_once?: FakeBackendFault;
  on_create?: (write: PlannedWrite) => void | Promise<void>;
  call_count = 0;
  private connected = false;

  constructor(options: FakeBackendOptions) {
    this.root = options.root;
    this.configuredProjects = [...(options.projects ?? [])];
    for (const project of this.configuredProjects) {
      this.scopeMappings.set(project, { backend_project: project, relative_root: '' });
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async probe(): Promise<{ server_version: string; tools: string[] }> {
    this.record();
    return { server_version: FAKE_SERVER_VERSION, tools: [...FAKE_TOOLS] };
  }

  registerScope(scope: ScopeConfig): void {
    const existing = this.scopeMappings.get(scope.id);
    if (
      existing !== undefined &&
      existing.relative_root !== '' &&
      (existing.backend_project !== scope.backend_project || existing.relative_root !== scope.relative_root)
    ) {
      throw invalidInput(`fake backend scope ${scope.id} is already registered differently`);
    }
    this.scopeMappings.set(scope.id, {
      backend_project: scope.backend_project,
      relative_root: scope.relative_root
    });
    if (!this.configuredProjects.includes(scope.backend_project)) {
      this.configuredProjects.push(scope.backend_project);
    }
  }

  async ensureProject(project: string, projectPath: string): Promise<{ created: boolean }> {
    this.record();
    if (this.configuredProjects.includes(project)) return { created: false };
    mkdirSync(projectPath, { recursive: true });
    this.configuredProjects.push(project);
    return { created: true };
  }

  async create(write: PlannedWrite): Promise<{ permalink: string; relative_path?: string }> {
    this.record();
    this.assertProject(write.backend_project);
    this.create_calls.push(write);
    if (this.fail_once === 'before_write') {
      this.fail_once = undefined;
      throw unavailable('fake backend lost the request before writing');
    }
    const relativePath = `${write.directory}/${slugify(write.storage_title)}.md`;
    const absolutePath = join(this.root, write.backend_project, relativePath);
    if (existsSync(absolutePath)) {
      throw conflict(`fake backend already materialised ${relativePath}`);
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, this.renderDocument(write), 'utf8');
    if (this.on_create !== undefined) await this.on_create(write);
    if (this.fail_once === 'after_write') {
      this.fail_once = undefined;
      throw unavailable('fake backend wrote the note but lost the response');
    }
    return { permalink: write.permalink, relative_path: relativePath };
  }

  async search(input: BackendSearch): Promise<{ hits: BackendHit[]; has_more: boolean }> {
    this.record();
    this.assertProject(input.project);
    this.applyReadFault();
    const query = input.query.toLowerCase();
    const matches = this.readMaterialised(input.project).filter(
      (note) =>
        input.kinds.includes(note.kind as BackendSearch['kinds'][number]) &&
        input.statuses.includes(note.status as BackendSearch['statuses'][number]) &&
        note.searchable.includes(query)
    );
    const start = Math.max(0, (input.page - 1) * input.page_size);
    const page = matches.slice(start, start + input.page_size);
    return {
      hits: page.map((note, index) => ({
        permalink: note.permalink,
        relative_path: note.relative_path,
        revision_id: note.revision_id,
        logical_id: note.logical_id,
        rank: matches.length - (start + index),
        matched_text: note.excerpt
      })),
      has_more: start + input.page_size < matches.length
    };
  }

  async isIndexed(project: string, revision_id: string): Promise<boolean> {
    this.record();
    this.assertProject(project);
    this.applyReadFault();
    return this.readMaterialised(project).some((note) => note.revision_id === revision_id);
  }

  materialisedPaths(project: string): string[] {
    return this.readMaterialised(project).map((note) => note.relative_path);
  }

  private record(): void {
    if (!this.connected) {
      throw unavailable('fake backend is not connected');
    }
    this.call_count += 1;
  }

  private applyReadFault(): void {
    if (this.fail_once === 'search_unavailable') {
      this.fail_once = undefined;
      throw unavailable('fake backend search is unavailable');
    }
    if (this.fail_once === 'embedding_unavailable') {
      this.fail_once = undefined;
      throw new BrainError({
        code: 'EMBEDDINGS_UNAVAILABLE',
        message: 'fake backend embedding model is unavailable'
      });
    }
  }

  private assertProject(project: string): void {
    if (this.configuredProjects.length > 0 && !this.configuredProjects.includes(project)) {
      throw invalidInput(`fake backend does not know the project ${project}`);
    }
  }

  private renderDocument(write: PlannedWrite): string {
    const frontmatter = stringify(write.metadata, {
      lineWidth: 0,
      aliasDuplicateObjects: false,
      defaultKeyType: 'PLAIN'
    }).replace(/\n$/, '');
    return `---\n${frontmatter}\n---\n\n${write.body}`;
  }

  private readMaterialised(project: string): MaterialisedNote[] {
    const projectRoot = join(this.root, project);
    const notes: MaterialisedNote[] = [];
    for (const absolutePath of this.walk(projectRoot)) {
      let raw: string;
      try {
        raw = readFileSync(absolutePath, 'utf8');
      } catch {
        continue;
      }
      const frontmatter = splitFrontmatter(raw);
      const kind = optionalString(frontmatter, 'type');
      const status = optionalString(frontmatter, 'brain_status');
      if (kind.length === 0 || status.length === 0) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
      const title = optionalString(frontmatter, 'brain_title') || optionalString(frontmatter, 'title');
      notes.push({
        relative_path: toPosix(relative(projectRoot, absolutePath)),
        permalink: optionalString(frontmatter, 'permalink'),
        revision_id: optionalString(frontmatter, 'brain_revision_id'),
        logical_id: optionalString(frontmatter, 'brain_id'),
        kind,
        status,
        excerpt: body.trim().replace(/\s+/g, ' ').slice(0, EXCERPT_MAX_CHARS),
        searchable: `${title}\n${body}`.toLowerCase()
      });
    }
    notes.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
    return notes;
  }

  private walk(directory: string): string[] {
    if (!existsSync(directory)) return [];
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...this.walk(absolutePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(absolutePath);
      }
    }
    return found;
  }
}
