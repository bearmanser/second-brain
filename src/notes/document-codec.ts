import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument as parseYamlDocument, stringify, visit } from 'yaml';
import { BrainError } from '../contracts/errors.js';
import { EVIDENCE_KINDS, type Evidence, type NoteInput } from '../core/types.js';
import { NOTE_REGISTRY } from './registry.js';
import {
  BRAIN_SCHEMA_VERSION,
  DEFAULT_TYPE_FOR_KIND,
  DOCUMENT_STATUSES,
  SOURCE_SECTION_TITLE,
  type CurrentDocument,
  type DocumentStatus
} from './document.js';

type YamlNode = { tag?: unknown };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const RECOGNIZED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'brain_schema_version',
  'type',
  'status',
  'project',
  'aliases',
  'tags',
  'created',
  'updated'
]);
const SOURCE_ENTRY_PATTERN =
  /^- \*\*([a-z_]+)\*\* (?:\[([^\]]*)\]\(<?([^>\s)]+)>?\)|`([^`]+)`)(?: \(observed ([^)]+)\))? \u2014 (.*)$/;
const FRONTMATTER_DELIMITER_PATTERN = /^---[ \t]*$/;

export interface DocumentMetadata {
  path: string;
  id?: string;
  type?: string;
  status?: DocumentStatus;
  project?: string;
  aliases?: string[];
  tags?: string[];
  created?: string;
  updated?: string;
  properties?: Record<string, unknown>;
}

export interface ParsedSources {
  evidence: Evidence[];
  human: string[];
}

function invalid(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function unsupported(message: string): BrainError {
  return new BrainError({ code: 'UNSUPPORTED_SCHEMA', message });
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

interface SplitDocument {
  frontmatter: string | undefined;
  body: string;
}

function lineContent(text: string, start: number, end: number): string {
  return (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\r$/, '');
}

function splitFrontmatter(raw: string): SplitDocument {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const firstBreak = text.indexOf('\n');
  const firstLine = lineContent(text, 0, firstBreak);
  if (!FRONTMATTER_DELIMITER_PATTERN.test(firstLine)) return { frontmatter: undefined, body: text };
  let cursor = firstBreak === -1 ? text.length : firstBreak + 1;
  while (cursor <= text.length) {
    const nextBreak = text.indexOf('\n', cursor);
    const line = lineContent(text, cursor, nextBreak);
    if (FRONTMATTER_DELIMITER_PATTERN.test(line)) {
      const bodyStart = nextBreak === -1 ? text.length : nextBreak + 1;
      return {
        frontmatter: text.slice(firstBreak + 1, cursor),
        body: text.slice(bodyStart)
      };
    }
    if (nextBreak === -1) break;
    cursor = nextBreak + 1;
  }
  throw invalid('document has an unterminated frontmatter block');
}

function parseFrontmatter(text: string): Record<string, unknown> {
  let document;
  try {
    document = parseYamlDocument(text, { schema: 'core' });
  } catch (cause) {
    throw invalid('frontmatter is not valid YAML', cause);
  }
  if (document.errors.length > 0) {
    throw invalid(`frontmatter: ${document.errors[0].code}`);
  }
  if (document.warnings.length > 0) {
    throw invalid(`frontmatter: unsupported YAML construct (${document.warnings[0].code})`);
  }
  let tagged = false;
  visit(document, {
    Node: (_key: unknown, node: unknown) => {
      if ((node as YamlNode).tag !== undefined) tagged = true;
    }
  });
  if (tagged) throw invalid('frontmatter: explicit YAML tags are not supported');
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw invalid('frontmatter: YAML aliases are not supported', cause);
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    throw invalid('frontmatter must be a YAML mapping');
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`frontmatter ${key} must be a string`);
  return value;
}

function readStringList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`frontmatter ${key} must be a list`);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw invalid(`frontmatter ${key} entries must be strings`);
    return entry;
  });
}

function readTimestamp(source: Record<string, unknown>, key: string): string | undefined {
  const value = readString(source, key);
  if (value === undefined) return undefined;
  if (!DATE_ONLY_PATTERN.test(value) && !RFC3339_PATTERN.test(value)) {
    throw invalid(`frontmatter ${key} must be an ISO date or an RFC3339 timestamp with a timezone`);
  }
  return value;
}

function readStatus(source: Record<string, unknown>): DocumentStatus {
  const value = source.status;
  if (value === undefined) return 'candidate';
  if (typeof value !== 'string' || !(DOCUMENT_STATUSES as readonly string[]).includes(value)) {
    throw invalid('frontmatter status is not a supported document status');
  }
  return value as DocumentStatus;
}

function readSchemaVersion(source: Record<string, unknown>): void {
  const value = source.brain_schema_version;
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid('frontmatter brain_schema_version must be an integer');
  }
  if (value !== BRAIN_SCHEMA_VERSION) {
    throw unsupported(
      `brain_schema_version ${value} is not the supported readable document version ${BRAIN_SCHEMA_VERSION}`
    );
  }
}

function pickProperties(source: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (RECOGNIZED_FRONTMATTER_KEYS.has(key)) continue;
    properties[key] = value;
  }
  return properties;
}

function firstHeading(body: string): string | undefined {
  const tree = fromMarkdown(body);
  for (const node of tree.children) {
    if (node.type !== 'heading' || node.depth !== 1) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const value = body
      .slice(start, end)
      .replace(/^#{1,6}[ \t]*/, '')
      .replace(/\s*#+\s*$/, '')
      .trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

function titleFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const withoutExtension = base.endsWith('.md') ? base.slice(0, -3) : base;
  return withoutExtension.length > 0 ? withoutExtension : 'Untitled';
}

export function parseDocument(raw: string, path: string): CurrentDocument {
  const { frontmatter, body } = splitFrontmatter(raw);
  const source = frontmatter === undefined ? {} : parseFrontmatter(frontmatter);
  readSchemaVersion(source);
  const id = readString(source, 'id');
  if (id !== undefined && !UUID_PATTERN.test(id)) {
    throw invalid('frontmatter id must be a UUID');
  }
  const type = readString(source, 'type') ?? 'note';
  const status = readStatus(source);
  const project = readString(source, 'project');
  const aliases = readStringList(source, 'aliases');
  const tags = readStringList(source, 'tags');
  const created = readTimestamp(source, 'created');
  const updated = readTimestamp(source, 'updated');
  const properties = pickProperties(source);
  const title = firstHeading(body) ?? titleFromPath(path);
  return {
    ...(id === undefined ? {} : { id }),
    path,
    title,
    type,
    status,
    ...(project === undefined ? {} : { project }),
    aliases,
    tags,
    ...(created === undefined ? {} : { created }),
    ...(updated === undefined ? {} : { updated }),
    properties,
    body
  };
}

export function renderDocument(document: CurrentDocument): string {
  const frontmatter: Record<string, unknown> = {};
  if (document.id !== undefined) frontmatter.id = document.id;
  frontmatter.brain_schema_version = BRAIN_SCHEMA_VERSION;
  frontmatter.type = document.type;
  frontmatter.status = document.status;
  if (document.project !== undefined) frontmatter.project = document.project;
  if (document.created !== undefined) frontmatter.created = document.created;
  if (document.updated !== undefined) frontmatter.updated = document.updated;
  if (document.aliases.length > 0) frontmatter.aliases = [...document.aliases];
  if (document.tags.length > 0) frontmatter.tags = [...document.tags];
  for (const key of Object.keys(document.properties).sort()) {
    frontmatter[key] = document.properties[key];
  }
  const yaml = stringify(frontmatter, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    defaultKeyType: 'PLAIN'
  }).replace(/\n$/, '');
  return `---\n${yaml}\n---\n\n${document.body.replace(/^\n+/, '')}`;
}

function renderReference(entry: Evidence): string {
  const ref = singleLine(entry.ref);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    const target = /[\s)>]/.test(ref) ? `<${ref}>` : ref;
    return `[${ref}](${target})`;
  }
  return `\`${ref.replace(/`/g, "'")}\``;
}

export function renderSources(evidence: readonly Evidence[]): string {
  const lines = evidence.map((entry) => {
    const observed =
      entry.observed_at === undefined ? '' : ` (observed ${singleLine(entry.observed_at)})`;
    return `- **${entry.kind}** ${renderReference(entry)}${observed} \u2014 ${singleLine(entry.description)}`;
  });
  return `## ${SOURCE_SECTION_TITLE}\n\n${lines.join('\n')}`;
}

export function parseSources(section: string): ParsedSources {
  const evidence: Evidence[] = [];
  const human: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      human.push('');
      continue;
    }
    if (trimmed.replace(/^#{1,6}[ \t]*/, '').trim() === SOURCE_SECTION_TITLE && trimmed.startsWith('#')) {
      continue;
    }
    const match = SOURCE_ENTRY_PATTERN.exec(trimmed);
    const kind = match?.[1];
    if (match === null || kind === undefined || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      human.push(line);
      continue;
    }
    const ref = match[3] ?? match[4] ?? '';
    const observed = match[5];
    evidence.push({
      kind: kind as Evidence['kind'],
      ref,
      description: match[6] ?? '',
      ...(observed === undefined ? {} : { observed_at: observed })
    });
  }
  while (human.length > 0 && human[0].trim() === '') human.shift();
  while (human.length > 0 && human[human.length - 1].trim() === '') human.pop();
  return { evidence, human };
}

function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${singleLine(item)}`).join('\n');
}

export function renderNoteBody(note: NoteInput): string {
  const content = note.content as unknown as Record<string, unknown>;
  const blocks: string[] = [`# ${singleLine(note.title)}`];
  for (const spec of NOTE_REGISTRY[note.content.kind].sections) {
    const value = content[spec.field];
    if (value === undefined) continue;
    const text = spec.form === 'yaml_list' ? renderList(value as string[]) : String(value);
    blocks.push(`## ${spec.title}\n\n${text}`);
  }
  if (note.evidence.length > 0) blocks.push(renderSources(note.evidence));
  if (note.related_ids.length > 0) {
    blocks.push(`## Related\n\n${note.related_ids.map((id) => `- [[${id}]]`).join('\n')}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function documentFromNote(note: NoteInput, meta: DocumentMetadata): CurrentDocument {
  return {
    ...(meta.id === undefined ? {} : { id: meta.id }),
    path: meta.path,
    title: note.title,
    type: meta.type ?? DEFAULT_TYPE_FOR_KIND[note.content.kind],
    status: meta.status ?? 'candidate',
    ...(meta.project === undefined ? {} : { project: meta.project }),
    aliases: meta.aliases === undefined ? [] : [...meta.aliases],
    tags: meta.tags === undefined ? [...note.tags] : [...meta.tags],
    ...(meta.created === undefined ? {} : { created: meta.created }),
    ...(meta.updated === undefined ? {} : { updated: meta.updated }),
    properties: { ...(meta.properties ?? {}) },
    body: renderNoteBody(note)
  };
}
