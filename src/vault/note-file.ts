import { isMap, parseDocument, stringify, type Document } from 'yaml';
import { invalidInput } from '../errors.js';
import { NOTE_TYPES, type NoteType } from '../types.js';

export interface ParsedNote {
  id: string | null;
  type: NoteType;
  tags: string[];
  created: string | null;
  updated: string | null;
  title: string | null;
  body: string;
  isProject: boolean;
  repositories: string[];
}

export interface NoteFields {
  id: string;
  type: NoteType;
  tags: string[];
  created: string;
  updated: string;
  title: string;
  body: string;
}

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;
const H1 = /^# (.+?)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(raw: string): { frontmatter: string | null; content: string } {
  const text = raw.replace(/^\uFEFF/, '');
  const match = FRONTMATTER.exec(text);
  if (match === null) return { frontmatter: null, content: text };
  return { frontmatter: match[1] ?? '', content: text.slice(match[0].length) };
}

function frontmatterDocument(frontmatter: string): Document {
  const doc = parseDocument(frontmatter);
  if (doc.errors.length > 0) throw invalidInput(`invalid frontmatter: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw invalidInput('frontmatter must be a YAML mapping');
  return doc;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function titleAndBody(content: string): { title: string | null; body: string } {
  const text = content.replace(LEADING_BLANK_LINES, '');
  const match = H1.exec(text);
  if (match === null) return { title: null, body: text.replace(/\r\n/g, '\n') };
  return {
    title: match[1].trim(),
    body: text.slice(match[0].length).replace(LEADING_BLANK_LINES, '').replace(/\r\n/g, '\n')
  };
}

export function parseNote(raw: string): ParsedNote {
  const { frontmatter, content } = splitFrontmatter(raw);
  const data =
    frontmatter === null ? {} : ((frontmatterDocument(frontmatter).toJS() ?? {}) as Record<string, unknown>);
  const rawType = data.type;
  const isProject = rawType === 'project';
  const type =
    typeof rawType === 'string' && (NOTE_TYPES as readonly string[]).includes(rawType) ? (rawType as NoteType) : 'note';
  const { title, body } = titleAndBody(content);
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id.trim() : null;
  return {
    id,
    type,
    tags: strings(data.tags),
    created: timestamp(data.created),
    updated: timestamp(data.updated),
    title,
    body,
    isProject,
    repositories: isProject ? strings(data.repositories) : []
  };
}

function managedYaml(values: Record<string, unknown>, previous: string | undefined): string {
  const frontmatter = previous === undefined ? null : splitFrontmatter(previous).frontmatter;
  if (frontmatter === null) return stringify(values);
  const doc = frontmatterDocument(frontmatter);
  if (doc.contents === null) return stringify(values);
  for (const [key, value] of Object.entries(values)) doc.set(key, value);
  return String(doc);
}

export function renderNote(fields: NoteFields, previous?: string): string {
  const yaml = managedYaml(
    { id: fields.id, type: fields.type, tags: fields.tags, created: fields.created, updated: fields.updated },
    previous
  );
  const body = fields.body.replace(/\s+$/, '');
  return `---\n${yaml}---\n\n# ${fields.title}\n${body.length > 0 ? `\n${body}\n` : ''}`;
}

export function renderProjectNote(name: string, repositories: string[], previous?: string): string {
  const yaml = managedYaml({ type: 'project', repositories }, previous);
  const content = previous === undefined ? '' : splitFrontmatter(previous).content.replace(LEADING_BLANK_LINES, '');
  return `---\n${yaml}---\n\n${content.length > 0 ? content : `# ${name}\n`}`;
}
