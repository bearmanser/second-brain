import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import { noteInputSchema, scopeIdSchema, uuidSchema } from '../contracts/content.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import {
  NOTE_KINDS,
  LIFECYCLES,
  type Lifecycle,
  type NoteInput,
  type NoteKind,
  type PlannedWrite,
  type ScopeConfig,
  type StoredRevision
} from '../core/types.js';
import { permalinkFor, revisionDirectory, storageTitle } from './identity.js';
import {
  EVIDENCE_SECTION_TITLE,
  NOTE_REGISTRY,
  RELATED_SECTION_TITLE,
  RESERVED_FRONTMATTER_KEYS,
  markdownSection,
  normalizeSectionTitle,
  reservedSections,
  type SectionSpec
} from './registry.js';

type MarkdownTree = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownTree['children'][number];

export { makeEtag } from './identity.js';

const timestampSchema = z.iso.datetime();
const lifecycleSchema = z.enum(LIFECYCLES);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

function invalid(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function unsupportedSchema(message: string): BrainError {
  return new BrainError({ code: 'UNSUPPORTED_SCHEMA', message });
}

function limitExceeded(message: string): BrainError {
  return new BrainError({ code: 'LIMIT_EXCEEDED', message });
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimBlankLines(value: string): string {
  const lines = value.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

function parseYamlValue(text: string, context: string): unknown {
  let document;
  try {
    document = parseDocument(text, { schema: 'core' });
  } catch (cause) {
    throw invalid(`${context}: invalid YAML`, cause);
  }
  if (document.errors.length > 0) {
    throw invalid(`${context}: ${document.errors[0].code}`);
  }
  if (document.warnings.length > 0) {
    throw invalid(`${context}: unsupported YAML construct (${document.warnings[0].code})`);
  }
  let tagged = false;
  visit(document, {
    Node: (_key, node) => {
      if ((node as { tag?: unknown }).tag !== undefined) tagged = true;
    }
  });
  if (tagged) {
    throw invalid(`${context}: explicit YAML tags are not supported`);
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw invalid(`${context}: YAML aliases are not supported`, cause);
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) {
    throw invalid(`${context}: expected a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw invalid(`frontmatter ${key} must be a string`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalid(`frontmatter ${key} must be a string`);
  }
  return value;
}

function requireTimestamp(source: Record<string, unknown>, key: string): string {
  const value = requireString(source, key);
  if (!timestampSchema.safeParse(value).success) {
    throw invalid(`frontmatter ${key} must be a UTC RFC3339 timestamp`);
  }
  return value;
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw invalid('managed note is missing a frontmatter block');
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) {
    throw invalid('managed note has an unterminated frontmatter block');
  }
  return {
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines.slice(close + 1).join('\n')
  };
}

interface HeadingRef {
  title: string;
  start: number;
  contentStart: number;
}

function collectHeadings(tree: MarkdownTree, source: string): HeadingRef[] {
  const headings: HeadingRef[] = [];
  for (const node of tree.children) {
    if (node.type !== 'heading' || node.depth !== 2) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = source.slice(start, end).replace(/^#{1,6}[ \t]*/, '');
    headings.push({ title: normalizeSectionTitle(raw), start, contentStart: end });
  }
  return headings;
}

function parseYamlListSection(content: string, title: string): unknown[] {
  const tree = fromMarkdown(content);
  const fences = tree.children.filter(
    (node): node is Extract<MarkdownNode, { type: 'code' }> => node.type === 'code' && node.lang === 'yaml'
  );
  const others = tree.children.filter((node) => !(node.type === 'code' && node.lang === 'yaml'));
  if (fences.length !== 1) {
    throw invalid(`## ${title} must contain exactly one fenced yaml block`);
  }
  if (others.length > 0) {
    throw invalid(`## ${title} contains content outside its fenced yaml block`);
  }
  const value = parseYamlValue(fences[0].value, `## ${title}`);
  if (!Array.isArray(value)) {
    throw invalid(`## ${title} must contain a YAML list`);
  }
  return value;
}

function parseParents(value: unknown): { revision_id: string; raw_hash: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid('frontmatter brain_parents must be a list');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw invalid('frontmatter brain_parents entries must be strings');
    }
    const separator = entry.lastIndexOf('@');
    const revisionId = separator === -1 ? '' : entry.slice(0, separator);
    const rawHash = separator === -1 ? '' : entry.slice(separator + 1);
    if (!uuidSchema.safeParse(revisionId).success || !hashSchema.safeParse(rawHash).success) {
      throw invalid('frontmatter brain_parents entries must be UUID@sha256');
    }
    return { revision_id: revisionId, raw_hash: rawHash };
  });
}

function parseApproval(
  frontmatter: Record<string, unknown>
): { principal_id: string; rationale: string; payload_hash: string } | undefined {
  const principalId = optionalString(frontmatter, 'brain_approved_by');
  const rationale = optionalString(frontmatter, 'brain_approval_rationale');
  const payloadHash = optionalString(frontmatter, 'brain_approval_payload_hash');
  if (principalId === undefined && rationale === undefined && payloadHash === undefined) {
    return undefined;
  }
  if (principalId === undefined || rationale === undefined || payloadHash === undefined) {
    throw invalid('frontmatter approval fields must be present together');
  }
  if (!uuidSchema.safeParse(principalId).success) {
    throw invalid('frontmatter brain_approved_by must be a UUID');
  }
  if (!hashSchema.safeParse(payloadHash).success) {
    throw invalid('frontmatter brain_approval_payload_hash must be a sha256 digest');
  }
  return { principal_id: principalId, rationale, payload_hash: payloadHash };
}

function pickExtraFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
    extra[key] = value;
  }
  return extra;
}

function resolveKind(frontmatter: Record<string, unknown>): NoteKind {
  const raw = requireString(frontmatter, 'type');
  if (!(NOTE_KINDS as readonly string[]).includes(raw)) {
    throw invalid(`frontmatter type is not a supported note kind: ${raw}`);
  }
  return raw as NoteKind;
}

function assembleContent(
  kind: NoteKind,
  sections: Map<string, string>
): Record<string, unknown> {
  const content: Record<string, unknown> = { kind };
  for (const spec of NOTE_REGISTRY[kind].sections) {
    const section = sections.get(normalizeSectionTitle(spec.title));
    if (section === undefined) continue;
    if (spec.form === 'yaml_list') {
      content[spec.field] = parseYamlListSection(section, spec.title);
    } else {
      if (section.length === 0) {
        throw invalid(`## ${spec.title} must not be empty`);
      }
      content[spec.field] = section;
    }
  }
  return content;
}

export function decodeRevision(raw: string): StoredRevision {
  const normalized = normalizeLineEndings(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const { frontmatter: frontmatterText, body } = splitFrontmatter(normalized);
  const frontmatter = asRecord(parseYamlValue(frontmatterText, 'frontmatter'), 'frontmatter');

  const schemaVersion = frontmatter.brain_schema_version;
  if (schemaVersion === undefined) {
    throw invalid('frontmatter brain_schema_version is required');
  }
  if (schemaVersion !== 1) {
    if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > 1) {
      throw unsupportedSchema(`brain_schema_version ${schemaVersion} is newer than this gateway supports`);
    }
    throw invalid('frontmatter brain_schema_version must be the integer 1');
  }

  const kind = resolveKind(frontmatter);
  const reserved = reservedSections(kind);
  const markdown = markdownSection(kind);
  const tree = fromMarkdown(body);
  const headings = collectHeadings(tree, body);

  const sectionText = new Map<string, string>();
  const ranges: [number, number][] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (markdown !== undefined && heading.title === normalizeSectionTitle(markdown.title)) {
      sectionText.set(heading.title, trimBlankLines(body.slice(heading.contentStart)));
      ranges.push([heading.start, body.length]);
      break;
    }
    const spec = reserved.get(heading.title);
    if (spec === undefined) continue;
    if (sectionText.has(heading.title)) {
      throw invalid(`duplicate reserved heading: ## ${heading.title}`);
    }
    const end = index + 1 < headings.length ? headings[index + 1].start : body.length;
    sectionText.set(heading.title, trimBlankLines(body.slice(heading.contentStart, end)));
    ranges.push([heading.start, end]);
  }

  ranges.sort((left, right) => left[0] - right[0]);
  const extras: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      extras.push(trimBlankLines(body.slice(cursor, start)));
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < body.length) {
    extras.push(trimBlankLines(body.slice(cursor)));
  }
  const extraMarkdown = extras.filter((entry) => entry.length > 0).join('\n\n');

  const content = assembleContent(kind, sectionText);
  const evidenceSection = sectionText.get(EVIDENCE_SECTION_TITLE);
  const relatedSection = sectionText.get(RELATED_SECTION_TITLE);
  const evidence = evidenceSection === undefined ? [] : parseYamlListSection(evidenceSection, EVIDENCE_SECTION_TITLE);
  const relatedIds = relatedSection === undefined ? [] : parseYamlListSection(relatedSection, RELATED_SECTION_TITLE);

  const tagsValue = frontmatter.tags;
  if (tagsValue !== undefined && !Array.isArray(tagsValue)) {
    throw invalid('frontmatter tags must be a list');
  }

  const scope = requireString(frontmatter, 'brain_scope');
  if (!scopeIdSchema.safeParse(scope).success) {
    throw invalid('frontmatter brain_scope must match ^[a-z][a-z0-9-]{0,63}$');
  }
  const statusText = requireString(frontmatter, 'brain_status');
  if (!lifecycleSchema.safeParse(statusText).success) {
    throw invalid(`frontmatter brain_status is not a supported lifecycle: ${statusText}`);
  }
  const status = statusText as Lifecycle;
  const id = requireString(frontmatter, 'brain_id');
  const revisionId = requireString(frontmatter, 'brain_revision_id');
  const operationId = requireString(frontmatter, 'brain_operation_id');
  for (const [key, value] of [
    ['brain_id', id],
    ['brain_revision_id', revisionId],
    ['brain_operation_id', operationId]
  ] as const) {
    if (!uuidSchema.safeParse(value).success) {
      throw invalid(`frontmatter ${key} must be a UUID`);
    }
  }
  const createdAt = requireTimestamp(frontmatter, 'created');
  const modifiedAt = requireTimestamp(frontmatter, 'modified');
  const replacementId = optionalString(frontmatter, 'brain_replacement_id');
  if (replacementId !== undefined && !uuidSchema.safeParse(replacementId).success) {
    throw invalid('frontmatter brain_replacement_id must be a UUID');
  }

  const candidate: NoteInput = {
    title: requireString(frontmatter, 'brain_title'),
    tags: Array.isArray(tagsValue) ? (tagsValue as string[]) : [],
    content: content as NoteInput['content'],
    evidence: evidence as NoteInput['evidence'],
    related_ids: relatedIds as NoteInput['related_ids']
  };

  let note: NoteInput;
  try {
    note = noteInputSchema.parse(candidate);
  } catch (cause) {
    if (isBrainError(cause)) throw cause;
    throw invalid('managed note content does not match its declared type', cause);
  }

  return {
    id,
    revision_id: revisionId,
    parents: parseParents(frontmatter.brain_parents),
    scope,
    status,
    note,
    created_at: createdAt,
    modified_at: modifiedAt,
    operation_id: operationId,
    approval: parseApproval(frontmatter),
    replacement_id: replacementId,
    extra_frontmatter: pickExtraFrontmatter(frontmatter),
    extra_markdown: extraMarkdown
  };
}

function stringifyYaml(value: unknown): string {
  return stringify(value, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    defaultKeyType: 'PLAIN'
  }).replace(/\n$/, '');
}

function sectionBlock(spec: SectionSpec, value: unknown): string {
  const text = normalizeLineEndings(String(value));
  return `## ${spec.title}\n\n${text}`;
}

function listBlock(title: string, value: unknown[]): string {
  return `## ${title}\n\n\`\`\`yaml\n${stringifyYaml(value)}\n\`\`\``;
}

function buildFrontmatter(revision: StoredRevision, scope: ScopeConfig): {
  frontmatter: Record<string, unknown>;
  directory: string;
  storedTitle: string;
  permalink: string;
} {
  if (revision.scope !== scope.id) {
    throw invalid(`revision scope ${revision.scope} does not match configured scope ${scope.id}`);
  }
  for (const [key, value] of [
    ['id', revision.id],
    ['revision_id', revision.revision_id],
    ['operation_id', revision.operation_id]
  ] as const) {
    if (!uuidSchema.safeParse(value).success) {
      throw invalid(`revision ${key} must be a UUID`);
    }
  }
  if (!scopeIdSchema.safeParse(revision.scope).success) {
    throw invalid('revision scope must match ^[a-z][a-z0-9-]{0,63}$');
  }
  if (!lifecycleSchema.safeParse(revision.status).success) {
    throw invalid('revision status is not a supported lifecycle');
  }
  if (!timestampSchema.safeParse(revision.created_at).success || !timestampSchema.safeParse(revision.modified_at).success) {
    throw invalid('revision timestamps must be UTC RFC3339 strings');
  }
  parseParents(revision.parents.map((parent) => `${parent.revision_id}@${parent.raw_hash}`));
  if (revision.approval !== undefined) {
    parseApproval({
      brain_approved_by: revision.approval.principal_id,
      brain_approval_rationale: revision.approval.rationale,
      brain_approval_payload_hash: revision.approval.payload_hash
    });
  }
  if (revision.replacement_id !== undefined && !uuidSchema.safeParse(revision.replacement_id).success) {
    throw invalid('revision replacement_id must be a UUID');
  }
  for (const key of Object.keys(revision.extra_frontmatter)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) {
      throw invalid(`extra frontmatter must not redeclare the reserved field ${key}`);
    }
  }
  try {
    noteInputSchema.parse(revision.note);
  } catch (cause) {
    if (isBrainError(cause)) throw cause;
    throw invalid('revision note does not match the content contracts', cause);
  }

  const kind = revision.note.content.kind;
  const directory = revisionDirectory(kind, revision.id);
  const storedTitle = storageTitle(revision.note.title, revision.revision_id);
  const permalink = permalinkFor(scope.backend_project, directory, storedTitle);

  const frontmatter: Record<string, unknown> = {
    title: storedTitle,
    type: kind,
    permalink,
    tags: [...revision.note.tags],
    created: revision.created_at,
    modified: revision.modified_at,
    brain_schema_version: 1,
    brain_id: revision.id,
    brain_revision_id: revision.revision_id,
    brain_title: revision.note.title,
    brain_scope: revision.scope,
    brain_status: revision.status,
    brain_operation_id: revision.operation_id,
    brain_parents: revision.parents.map((parent) => `${parent.revision_id}@${parent.raw_hash}`)
  };
  if (revision.approval !== undefined) {
    frontmatter.brain_approved_by = revision.approval.principal_id;
    frontmatter.brain_approval_rationale = revision.approval.rationale;
    frontmatter.brain_approval_payload_hash = revision.approval.payload_hash;
  }
  if (revision.replacement_id !== undefined) {
    frontmatter.brain_replacement_id = revision.replacement_id;
  }
  for (const [key, value] of Object.entries(revision.extra_frontmatter)) {
    frontmatter[key] = value;
  }
  return { frontmatter, directory, storedTitle, permalink };
}

export function renderRevisionBody(revision: StoredRevision): string {
  const kind = revision.note.content.kind;
  const content = revision.note.content as unknown as Record<string, unknown>;
  const blocks: string[] = [];
  for (const spec of NOTE_REGISTRY[kind].sections) {
    if (spec.form === 'markdown') continue;
    const value = content[spec.field];
    if (value === undefined) continue;
    if (spec.form === 'yaml_list') {
      blocks.push(listBlock(spec.title, value as unknown[]));
    } else {
      blocks.push(sectionBlock(spec, value));
    }
  }
  blocks.push(listBlock(EVIDENCE_SECTION_TITLE, revision.note.evidence));
  blocks.push(listBlock(RELATED_SECTION_TITLE, revision.note.related_ids));
  if (revision.extra_markdown.trim().length > 0) {
    blocks.push(trimBlankLines(normalizeLineEndings(revision.extra_markdown)));
  }
  const markdown = markdownSection(kind);
  if (markdown !== undefined) {
    const value = normalizeLineEndings(String(content[markdown.field] ?? ''));
    blocks.push(`## ${markdown.title}\n\n${trimBlankLines(value)}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function renderRevision(revision: StoredRevision, scope: ScopeConfig): string {
  const { frontmatter } = buildFrontmatter(revision, scope);
  const body = renderRevisionBody(revision);
  return `---\n${stringifyYaml(frontmatter)}\n---\n\n${body}`;
}

export function encodeRevision(revision: StoredRevision, scope: ScopeConfig): PlannedWrite {
  const { frontmatter, directory, storedTitle, permalink } = buildFrontmatter(revision, scope);
  const body = renderRevisionBody(revision);
  const rendered = `---\n${stringifyYaml(frontmatter)}\n---\n\n${body}`;
  const renderedBytes = Buffer.byteLength(rendered, 'utf8');
  if (renderedBytes > RENDERED_NOTE_MAX_BYTES) {
    throw limitExceeded(`rendered note is ${renderedBytes} bytes and exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`);
  }
  return {
    revision,
    backend_project: scope.backend_project,
    directory,
    storage_title: storedTitle,
    permalink,
    body,
    metadata: frontmatter
  };
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return normalizeLineEndings(value);
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonicalize(source[key]);
    }
    return ordered;
  }
  return value;
}

export function payloadHash(revision: StoredRevision): string {
  const projection = canonicalize({
    content: revision.note.content,
    evidence: revision.note.evidence,
    related_ids: revision.note.related_ids,
    tags: revision.note.tags,
    title: revision.note.title,
    extra_frontmatter: revision.extra_frontmatter,
    extra_markdown: normalizeLineEndings(revision.extra_markdown)
  });
  return createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex');
}
