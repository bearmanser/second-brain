import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument as parseYamlDocument, stringify, visit } from 'yaml';
import { BrainError } from '../contracts/errors.js';
import { EVIDENCE_KINDS, type Evidence, type NoteInput } from '../core/types.js';
import { NOTE_REGISTRY, RELATED_SECTION_TITLE, normalizeSectionTitle } from './registry.js';
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
const FRONTMATTER_DELIMITER_PATTERN = /^---[ \t]*$/;
const SECTION_BOUNDARY_PATTERN = /^ {0,3}#{1,2}[ \t]/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);
const SOURCE_ENTRY_PATTERN =
  /^- \*\*([a-z_]+)\*\* (?:\[((?:\\.|[^\]])*)\]\(<((?:\\.|[^>])*)>\)|\[((?:\\.|[^\]])*)\]\(((?:\\.|[^)\s])+)\)|`((?:\\.|[^`])*)`)(?: \(observed ((?:\\.|[^)])*)\))? \u2014 (.*)$/;

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

export interface RevisionMetadata {
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

export interface NoteBodyExtras {
  human?: string[];
  sectionHuman?: Record<string, string[]>;
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

function trimBlock(value: string): string {
  return value.replace(/^\n+/, '').replace(/\n+$/, '');
}

function escapeField(value: string, extra = ''): string {
  let out = value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  for (const character of extra) out = out.split(character).join(`\\${character}`);
  return out;
}

function unescapeField(value: string): string {
  return value.replace(
    /\\(.)/g,
    (_match, character: string) =>
      character === 'n' ? '\n' : character === 'r' ? '\r' : character === 't' ? '\t' : character
  );
}

function isSafeLink(ref: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(ref);
  if (match === null) return false;
  return LINK_SCHEMES.has(match[1].toLowerCase());
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
  return `---\n${yaml}\n---\n${document.body}`;
}

function renderReference(entry: Evidence): string {
  if (isSafeLink(entry.ref)) {
    const label = escapeField(entry.ref, '[]*_');
    const target = escapeField(entry.ref, '<>');
    return `[${label}](<${target}>)`;
  }
  return `\`${escapeField(entry.ref, '`')}\``;
}

export function renderSources(evidence: readonly Evidence[]): string {
  const lines = evidence.map((entry) => {
    const observed =
      entry.observed_at === undefined ? '' : ` (observed ${escapeField(entry.observed_at, '()')})`;
    return `- **${entry.kind}** ${renderReference(entry)}${observed} \u2014 ${escapeField(entry.description)}`;
  });
  return `## ${SOURCE_SECTION_TITLE}\n\n${lines.join('\n')}`;
}

interface FenceState {
  marker: string;
  length: number;
}

function headingTitle(line: string): string | undefined {
  const match = HEADING_PATTERN.exec(line);
  return match === null ? undefined : normalizeSectionTitle(match[2]);
}

function isSourceHeading(line: string): boolean {
  return HEADING_PATTERN.test(line) && headingTitle(line) === SOURCE_SECTION_TITLE;
}

function updateFence(state: FenceState | null, line: string): FenceState | null {
  const match = FENCE_OPEN_PATTERN.exec(line);
  if (state === null) {
    return match === null ? null : { marker: match[1][0], length: match[1].length };
  }
  if (match === null) return state;
  if (match[1][0] === state.marker && match[1].length >= state.length) return null;
  return state;
}

function findSourceHeadingIndex(lines: string[]): number {
  let fence: FenceState | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence === null && isSourceHeading(line)) return index;
    fence = updateFence(fence, line);
  }
  return -1;
}

function collectSourceLines(
  lines: string[],
  start: number,
  stopAtBoundary: boolean,
  evidence: Evidence[],
  human: string[]
): void {
  let fence: FenceState | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence === null && stopAtBoundary && SECTION_BOUNDARY_PATTERN.test(line)) return;
    if (fence !== null) {
      human.push(line);
      fence = updateFence(fence, line);
      continue;
    }
    const match = SOURCE_ENTRY_PATTERN.exec(line);
    const kind = match?.[1];
    if (match !== null && kind !== undefined && (EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      const observed = match[7];
      evidence.push({
        kind: kind as Evidence['kind'],
        ref: unescapeField(match[3] ?? match[5] ?? match[6] ?? ''),
        description: unescapeField(match[8] ?? ''),
        ...(observed === undefined ? {} : { observed_at: unescapeField(observed) })
      });
      continue;
    }
    human.push(line);
    fence = updateFence(fence, line);
  }
}

export function parseSources(section: string): ParsedSources {
  const lines = section.split('\n');
  const evidence: Evidence[] = [];
  const human: string[] = [];
  const headingIndex = findSourceHeadingIndex(lines);
  if (headingIndex === -1) return { evidence, human: [...lines] };
  let start = headingIndex + 1;
  if (start < lines.length && lines[start].trim() === '') start += 1;
  collectSourceLines(lines, start, true, evidence, human);
  return { evidence, human };
}

function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${singleLine(item)}`).join('\n');
}

export function renderNoteBody(note: NoteInput, extras: NoteBodyExtras = {}): string {
  const content = note.content as unknown as Record<string, unknown>;
  const sectionHuman: Record<string, string[]> = { ...(extras.sectionHuman ?? {}) };
  const takeSection = (title: string): string[] => {
    const value = sectionHuman[title];
    delete sectionHuman[title];
    return value ?? [];
  };
  const withHuman = (base: string, blocks: string[]): string => {
    const extra = trimBlock(blocks.join('\n\n'));
    return extra.length === 0 ? base : `${base}\n\n${extra}`;
  };
  const blocks: string[] = [`# ${singleLine(note.title)}`];
  for (const spec of NOTE_REGISTRY[note.content.kind].sections) {
    const value = content[spec.field];
    if (value === undefined) continue;
    const text = spec.form === 'yaml_list' ? renderList(value as string[]) : String(value);
    blocks.push(withHuman(`## ${spec.title}\n\n${text}`, takeSection(spec.title)));
  }
  const sourceExtra = takeSection(SOURCE_SECTION_TITLE);
  if (note.evidence.length > 0 || sourceExtra.length > 0) {
    blocks.push(withHuman(renderSources(note.evidence), sourceExtra));
  }
  const relatedExtra = takeSection(RELATED_SECTION_TITLE);
  if (note.related_ids.length > 0 || relatedExtra.length > 0) {
    const generated = note.related_ids.map((id) => `- [[${id}]]`).join('\n');
    blocks.push(withHuman(`## ${RELATED_SECTION_TITLE}\n\n${generated}`, relatedExtra));
  }
  const leftovers = Object.values(sectionHuman).flat();
  const human = [...(extras.human ?? []), ...leftovers]
    .map((block) => trimBlock(block))
    .filter((block) => block.length > 0);
  if (human.length > 0) blocks.push(human.join('\n\n'));
  return `\n${blocks.join('\n\n')}\n`;
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

interface HeadingRef {
  title: string;
  depth: number;
  start: number;
  end: number;
}

function collectLevelOneAndTwoHeadings(body: string): HeadingRef[] {
  const tree = fromMarkdown(body);
  const refs: HeadingRef[] = [];
  for (const node of tree.children) {
    if (node.type !== 'heading' || (node.depth !== 1 && node.depth !== 2)) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const title = normalizeSectionTitle(
      body.slice(start, end).replace(/^#{1,6}[ \t]*/, '').replace(/\s*#+\s*$/, '').trim()
    );
    refs.push({ title, depth: node.depth, start, end });
  }
  return refs;
}

interface GeneratedRemoval {
  start: number;
  end: number;
  title: string;
  depth: number;
}

function subtractGenerated(
  body: string,
  generated: string
): { general: string[]; sections: Record<string, string[]> } {
  const headings = collectLevelOneAndTwoHeadings(generated);
  const removals: GeneratedRemoval[] = [];
  let cursor = 0;
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = index + 1 < headings.length ? headings[index + 1].start : generated.length;
    const block = generated.slice(heading.start, end);
    const found = body.indexOf(block, cursor);
    if (found === -1) continue;
    removals.push({
      start: found,
      end: found + block.length,
      title: heading.title,
      depth: heading.depth
    });
    cursor = found + block.length;
  }
  const general: string[] = [];
  const sections: Record<string, string[]> = {};
  const prefix = removals.length > 0 ? body.slice(0, removals[0].start) : body;
  const prefixText = trimBlock(prefix);
  if (prefixText.length > 0) general.push(prefixText);
  for (let index = 0; index < removals.length; index += 1) {
    const removal = removals[index];
    const nextStart = index + 1 < removals.length ? removals[index + 1].start : body.length;
    const segment = trimBlock(body.slice(removal.end, nextStart));
    if (segment.length === 0) continue;
    if (removal.depth === 1) {
      general.push(segment);
      continue;
    }
    const existing = sections[removal.title];
    if (existing === undefined) sections[removal.title] = [segment];
    else existing.push(segment);
  }
  return { general, sections };
}

export interface RevisionOptions {
  previous: NoteInput;
  meta?: RevisionMetadata;
}

export function reviseDocument(
  base: CurrentDocument,
  note: NoteInput,
  options: RevisionOptions
): CurrentDocument {
  const meta = options.meta ?? {};
  const generated = renderNoteBody(options.previous);
  const { general, sections } = subtractGenerated(base.body, generated);
  const id = meta.id ?? base.id;
  const project = meta.project ?? base.project;
  const created = meta.created ?? base.created;
  const updated = meta.updated ?? base.updated;
  return {
    ...(id === undefined ? {} : { id }),
    path: base.path,
    title: note.title,
    type: meta.type ?? base.type,
    status: meta.status ?? base.status,
    ...(project === undefined ? {} : { project }),
    aliases: meta.aliases === undefined ? [...base.aliases] : [...meta.aliases],
    tags: meta.tags === undefined ? [...base.tags] : [...meta.tags],
    ...(created === undefined ? {} : { created }),
    ...(updated === undefined ? {} : { updated }),
    properties: { ...base.properties, ...(meta.properties ?? {}) },
    body: renderNoteBody(note, { human: general, sectionHuman: sections })
  };
}
