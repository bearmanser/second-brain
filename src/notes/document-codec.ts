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

interface MarkdownNode {
  type?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

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

interface LineInfo {
  text: string;
  headingDepth: number | undefined;
  headingTitle: string | undefined;
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

function topLevelNodes(source: string): MarkdownNode[] {
  return fromMarkdown(source).children as unknown as MarkdownNode[];
}

function nodeRange(node: MarkdownNode): [number, number] | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
}

function headingTitleOf(source: string, node: MarkdownNode): string | undefined {
  if (node.type !== 'heading') return undefined;
  const range = nodeRange(node);
  if (range === undefined) return undefined;
  return normalizeSectionTitle(
    source.slice(range[0], range[1]).replace(/^#{1,6}[ \t]*/, '').replace(/\s*#+\s*$/, '').trim()
  );
}

function collectCodeRanges(nodes: MarkdownNode[]): [number, number][] {
  const ranges: [number, number][] = [];
  const walk = (list: MarkdownNode[]): void => {
    for (const node of list) {
      if (node.type === 'code') {
        const range = nodeRange(node);
        if (range !== undefined) ranges.push(range);
      }
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return ranges;
}

function isInside(ranges: [number, number][], offset: number): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function lineIndexAt(offset: number, starts: number[]): number {
  let index = 0;
  for (let candidate = 0; candidate < starts.length; candidate += 1) {
    if (starts[candidate] <= offset) index = candidate;
    else break;
  }
  return index;
}

function analyzeSource(source: string): LineInfo[] {
  const lines = source.split('\n');
  const starts = lineStarts(lines);
  const children = topLevelNodes(source);
  const headings: { title: string; depth: number; line: number }[] = [];
  for (const node of children) {
    const title = headingTitleOf(source, node);
    if (title === undefined) continue;
    const depth = node.depth ?? 1;
    if (depth > 2) continue;
    const range = nodeRange(node);
    if (range === undefined) continue;
    headings.push({ title, depth, line: lineIndexAt(range[0], starts) });
  }
  headings.sort((left, right) => left.line - right.line);
  const infos: LineInfo[] = [];
  let cursor = -1;
  for (let line = 0; line < lines.length; line += 1) {
    while (cursor + 1 < headings.length && headings[cursor + 1].line <= line) cursor += 1;
    const heading = cursor >= 0 ? headings[cursor] : undefined;
    const isHeadingLine = heading !== undefined && heading.line === line;
    infos.push({
      text: lines[line],
      headingDepth: isHeadingLine ? heading.depth : undefined,
      headingTitle: isHeadingLine ? heading.title : undefined
    });
  }
  return infos;
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

export function parseSources(section: string): ParsedSources {
  const lines = section.split('\n');
  const starts = lineStarts(lines);
  const children = topLevelNodes(section);
  let headingStart: number | undefined;
  let headingEnd: number | undefined;
  for (const node of children) {
    const title = headingTitleOf(section, node);
    if (title !== SOURCE_SECTION_TITLE) continue;
    if ((node.depth ?? 1) > 2) continue;
    const range = nodeRange(node);
    if (range === undefined) continue;
    headingStart = range[0];
    headingEnd = range[1];
    break;
  }
  if (headingStart === undefined || headingEnd === undefined) {
    return { evidence: [], human: [...lines] };
  }
  let endOffset = section.length;
  for (const node of children) {
    const title = headingTitleOf(section, node);
    if (title === undefined) continue;
    if ((node.depth ?? 1) > 2) continue;
    const range = nodeRange(node);
    if (range === undefined) continue;
    if (range[0] > headingStart) {
      endOffset = range[0];
      break;
    }
  }
  const codeRanges = collectCodeRanges(children);
  const headingLine = lineIndexAt(headingStart, starts);
  const endLine = endOffset >= section.length ? lines.length : lineIndexAt(endOffset, starts);
  const evidence: Evidence[] = [];
  const human: string[] = lines.slice(0, headingLine).filter((text) => SOURCE_ENTRY_PATTERN.test(text));
  let start = headingLine + 1;
  if (start < endLine && lines[start].trim() === '') start += 1;
  for (let line = start; line < endLine; line += 1) {
    const text = lines[line];
    if (isInside(codeRanges, starts[line])) {
      human.push(text);
      continue;
    }
    const match = SOURCE_ENTRY_PATTERN.exec(text);
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
    human.push(text);
  }
  human.push(...lines.slice(endLine).filter((text) => SOURCE_ENTRY_PATTERN.test(text)));
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

interface GeneratedSkeleton {
  sections: SectionBlock[];
}

interface SectionBlock {
  title: string | undefined;
  start: number;
  lines: LineInfo[];
}

function sectionBlocks(infos: LineInfo[]): SectionBlock[] {
  const blocks: SectionBlock[] = [{ title: undefined, start: 0, lines: [] }];
  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    if (info.headingDepth !== undefined) {
      blocks.push({ title: info.headingDepth === 2 ? info.headingTitle : undefined, start: index, lines: [] });
    }
    blocks[blocks.length - 1].lines.push(info);
  }
  return blocks;
}

function contentCounts(block: SectionBlock): Map<string, number> {
  const counts = new Map<string, number>();
  for (const info of block.lines.slice(1)) {
    if (info.text.trim().length === 0) continue;
    counts.set(info.text, (counts.get(info.text) ?? 0) + 1);
  }
  return counts;
}

function generatedSkeleton(previous: NoteInput): GeneratedSkeleton {
  return { sections: sectionBlocks(analyzeSource(renderNoteBody(previous))).filter((block) => block.title !== undefined) };
}

function subtractGenerated(
  body: string,
  previous: NoteInput
): { general: string[]; sections: Record<string, string[]> } {
  const skeleton = generatedSkeleton(previous);
  const blocks = sectionBlocks(analyzeSource(body));
  const generated = new Map<number, Map<string, number>>();
  let lastMatched = -1;
  for (const section of skeleton.sections) {
    const expected = contentCounts(section);
    let chosen = -1;
    let bestOverlap = -1;
    let bestDistance = Infinity;
    for (let index = lastMatched + 1; index < blocks.length; index += 1) {
      const candidate = blocks[index];
      if (candidate.title !== section.title) continue;
      const present = contentCounts(candidate);
      let overlap = 0;
      for (const [text, count] of expected) overlap += Math.min(count, present.get(text) ?? 0);
      const distance = Math.abs(candidate.start - section.start);
      if (distance < bestDistance || (distance === bestDistance && overlap > bestOverlap)) {
        chosen = index;
        bestOverlap = overlap;
        bestDistance = distance;
      }
    }
    if (chosen < 0) continue;
    generated.set(chosen, expected);
    lastMatched = chosen;
  }
  const generalLines: string[] = [];
  const sectionLines = new Map<string, string[]>();
  let headingRemoved = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const counts = generated.get(index);
    if (counts === undefined) {
      for (const info of block.lines) {
        if (info.headingDepth === 1 && !headingRemoved) {
          headingRemoved = true;
          continue;
        }
        generalLines.push(info.text);
      }
      continue;
    }
    const title = block.title;
    if (title === undefined) continue;
    const remaining = sectionLines.get(title) ?? [];
    for (const info of block.lines.slice(1)) {
      const count = counts.get(info.text) ?? 0;
      if (info.text.trim().length > 0 && count > 0) {
        counts.set(info.text, count - 1);
        continue;
      }
      remaining.push(info.text);
    }
    sectionLines.set(title, remaining);
  }
  const sections: Record<string, string[]> = {};
  for (const [title, lines] of sectionLines) {
    const text = trimBlock(lines.join('\n'));
    if (text.length > 0) sections[title] = [text];
  }
  const generalText = trimBlock(generalLines.join('\n'));
  return { general: generalText.length > 0 ? [generalText] : [], sections };
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
  const { general, sections } = subtractGenerated(base.body, options.previous);
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
