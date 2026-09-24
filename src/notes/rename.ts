import { createHash } from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument as parseYamlDocument } from 'yaml';
import { BrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import { parseDocument } from './document-codec.js';
import { extractLinks, isExternalTarget, type LinkReference } from './links.js';
import { resolveLink, type LinkCatalogue } from './link-resolver.js';
import { collisionKey } from './paths.js';

export interface RenameFileSnapshot {
  path: string;
  raw: string;
  hash: string;
}

export interface RenameMove {
  from: string;
  to: string;
}

export interface RenameEdit {
  path: string;
  expected_hash: string;
  raw: string;
}

export type RenameUnresolvedReason = 'unresolved' | 'ambiguous' | 'unsupported' | 'manual';

export interface RenameUnresolved {
  path: string;
  target: string;
  reason: RenameUnresolvedReason;
  paths?: string[];
}

export interface RenameConflict {
  path: string;
  reason: 'target_occupied' | 'source_missing' | 'unsafe_path';
}

export interface RenamePlan {
  from: string;
  to: string;
  source_hash: string;
  moves: RenameMove[];
  edits: RenameEdit[];
  unresolved: RenameUnresolved[];
  conflicts: RenameConflict[];
  idempotency_key: string;
}

export interface RenamePlanInput {
  from: string;
  to: string;
  files: RenameFileSnapshot[];
  idempotency_key?: string;
}

export interface RenameReceipt {
  operation_id: string;
  from: string;
  to: string;
  moved: boolean;
  edited: string[];
  indexed: string[];
  verified: boolean;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function renameSegments(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw invalidInput('a rename path must be a non-empty string');
  }
  if (relativePath.includes('\0')) throw invalidInput('a rename path contains a null byte');
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw invalidInput('a rename path must be relative');
  }
  if (relativePath.includes('\\')) throw invalidInput('a rename path must use forward slashes');
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw invalidInput('a rename path must not contain empty segments');
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw invalidInput('path traversal is not allowed');
    if (segment.startsWith('.')) throw invalidInput('a rename path must not be hidden');
    if (/[\u0000-\u001f\u007f]/u.test(segment)) {
      throw invalidInput('a rename path contains a control character');
    }
  }
  return segments;
}

function splitExtension(path: string): { stem: string; extension: string } {
  const slash = path.lastIndexOf('/');
  const leaf = slash === -1 ? path : path.slice(slash + 1);
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0) return { stem: path, extension: '' };
  const absoluteDot = slash + 1 + dot;
  return { stem: path.slice(0, absoluteDot), extension: path.slice(absoluteDot) };
}

export function caseSafeTemporaryPath(to: string): string {
  const { stem, extension } = splitExtension(to);
  return `${stem}.case-rename-tmp${extension}`;
}

function stripNoteExtension(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function relativePath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const fromParts = fromDir.length === 0 ? [] : fromDir.split('/');
  const toParts = toPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  const segments = [...Array<string>(up).fill('..'), ...toParts.slice(common)];
  const joined = segments.join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

interface TextPlan {
  raw: string;
  unresolved: RenameUnresolved[];
}

function boundaryIndex(inner: string): number {
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '#' || character === '|') return index;
  }
  return inner.length;
}

function replaceReferenceTarget(span: string, reference: LinkReference, newTarget: string): string {
  if (reference.syntax === 'wikilink') {
    const open = span.indexOf('[[');
    if (open === -1) return span;
    const innerStart = open + 2;
    const innerEnd = span.endsWith(']]') ? span.length - 2 : span.length;
    const inner = span.slice(innerStart, innerEnd);
    const boundary = boundaryIndex(inner);
    return span.slice(0, innerStart) + newTarget + inner.slice(boundary) + span.slice(innerEnd);
  }
  const marker = span.indexOf('](');
  if (marker === -1) return span;
  const start = marker + 2;
  const end = span.indexOf(')', start);
  if (end === -1) return span;
  const url = newTarget + (reference.fragment === undefined ? '' : `#${reference.fragment}`);
  return span.slice(0, start) + url + span.slice(end);
}

function targetText(reference: LinkReference, resolvedPath: string, sourceAfter: string): string {
  if (reference.syntax === 'wikilink') {
    if (reference.target.startsWith('.')) {
      return stripNoteExtension(relativePath(sourceAfter, resolvedPath));
    }
    return stripNoteExtension(resolvedPath);
  }
  if (reference.target.startsWith('/')) return `/${encodePath(resolvedPath)}`;
  return encodePath(relativePath(sourceAfter, resolvedPath));
}

function identifierOf(raw: string, path: string): string | undefined {
  try {
    return parseDocument(raw, path).id;
  } catch {
    return undefined;
  }
}

function planText(
  raw: string,
  sourcePath: string,
  from: string,
  to: string,
  catalogue: LinkCatalogue,
  post: LinkCatalogue
): TextPlan {
  const unresolved: RenameUnresolved[] = [];
  const replacements: Replacement[] = [];
  const movedSource = sourcePath === from;
  const sourceAfter = movedSource ? to : sourcePath;
  for (const reference of extractLinks(raw)) {
    if (isExternalTarget(reference.target)) continue;
    const before = resolveLink(reference, sourcePath, catalogue);
    if (before.state !== 'resolved') {
      unresolved.push({
        path: sourcePath,
        target: reference.target,
        reason: before.state,
        ...(before.state === 'ambiguous' ? { paths: before.paths } : {})
      });
      continue;
    }
    const expected = before.path === from ? to : before.path;
    const after = resolveLink(reference, sourceAfter, post);
    if (after.state === 'resolved' && after.path === expected) continue;
    const span = raw.slice(reference.start, reference.end);
    const text = replaceReferenceTarget(span, reference, targetText(reference, expected, sourceAfter));
    if (text !== span) replacements.push({ start: reference.start, end: reference.end, text });
  }
  return { raw: applyReplacements(raw, replacements), unresolved };
}

function applyReplacements(raw: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return raw;
  const ordered = [...replacements].sort((left, right) => right.start - left.start || right.end - left.end);
  let output = raw;
  for (const replacement of ordered) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

interface CanvasNode {
  type?: unknown;
  file?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

function canvasIndent(raw: string): number | undefined {
  const match = /\n([ \t]+)\S/.exec(raw);
  if (match === null) return undefined;
  const indent = match[1].replace(/\t/g, '  ').length;
  return indent >= 1 && indent <= 8 ? indent : undefined;
}

function planCanvas(
  raw: string,
  sourcePath: string,
  from: string,
  to: string,
  catalogue: LinkCatalogue,
  post: LinkCatalogue
): TextPlan {
  const unresolved: RenameUnresolved[] = [];
  let data: { nodes?: unknown };
  try {
    data = JSON.parse(raw) as { nodes?: unknown };
  } catch {
    return { raw, unresolved: [{ path: sourcePath, target: from, reason: 'unsupported' }] };
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.nodes)) {
    return { raw, unresolved };
  }
  for (const entry of data.nodes) {
    if (entry === null || typeof entry !== 'object') continue;
    const node = entry as CanvasNode;
    if (node.type === 'file' && typeof node.file === 'string') {
      const hash = node.file.indexOf('#');
      const target = hash === -1 ? node.file : node.file.slice(0, hash);
      const fragment = hash === -1 ? undefined : node.file.slice(hash + 1);
      const outcome = resolveLink({ target }, sourcePath, catalogue);
      if (outcome.state === 'resolved' && outcome.path === from) {
        node.file = fragment === undefined ? to : `${to}#${fragment}`;
      }
      continue;
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      const planned = planText(node.text, sourcePath, from, to, catalogue, post);
      node.text = planned.raw;
      unresolved.push(...planned.unresolved);
    }
  }
  const indent = canvasIndent(raw);
  const serialized =
    indent === undefined ? JSON.stringify(data) : JSON.stringify(data, null, indent);
  return { raw: raw.endsWith('\n') ? `${serialized}\n` : serialized, unresolved };
}

function planBase(
  raw: string,
  sourcePath: string,
  from: string,
  to: string,
  catalogue: LinkCatalogue,
  post: LinkCatalogue
): TextPlan {
  const unresolved: RenameUnresolved[] = [];
  let document: ReturnType<typeof parseYamlDocument>;
  try {
    document = parseYamlDocument(raw, { schema: 'core' });
  } catch {
    return { raw, unresolved: [{ path: sourcePath, target: from, reason: 'unsupported' }] };
  }
  if (document.errors.length > 0) {
    return { raw, unresolved: [{ path: sourcePath, target: from, reason: 'unsupported' }] };
  }
  const fromStem = stripNoteExtension(from);
  const visitScalar = (node: unknown): void => {
    if (isSeq(node)) {
      for (const item of node.items) visitScalar(item);
      return;
    }
    if (isMap(node)) {
      for (const item of node.items) visitScalar(item.value);
      return;
    }
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const value = node.value;
    const planned = planText(value, sourcePath, from, to, catalogue, post);
    if (planned.raw !== value) {
      node.value = planned.raw;
      return;
    }
    if (value.trim() === from || value.trim() === fromStem) {
      node.value = value.replace(from, to);
      return;
    }
    if (value.includes(from) || value.includes(fromStem)) {
      unresolved.push({ path: sourcePath, target: from, reason: 'unsupported' });
      return;
    }
    unresolved.push(...planned.unresolved);
  };
  if (isMap(document.contents)) visitScalar(document.contents);
  return { raw: document.toString(), unresolved };
}

function planObsidian(raw: string, sourcePath: string, from: string, catalogue: LinkCatalogue): RenameUnresolved[] {
  const unresolved: RenameUnresolved[] = [];
  const report = (target: string): void => {
    const outcome = resolveLink({ target }, sourcePath, catalogue);
    if (outcome.state === 'resolved' && outcome.path === from) {
      unresolved.push({ path: sourcePath, target, reason: 'manual' });
    }
  };
  try {
    const data = JSON.parse(raw) as unknown;
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value === from || stripNoteExtension(value) === stripNoteExtension(from)) report(value);
        for (const reference of extractLinks(value)) report(reference.target);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value as Record<string, unknown>)) walk(entry);
      }
    };
    walk(data);
  } catch {
    for (const reference of extractLinks(raw)) report(reference.target);
  }
  return unresolved;
}

function planFile(
  file: RenameFileSnapshot,
  from: string,
  to: string,
  catalogue: LinkCatalogue,
  post: LinkCatalogue
): { raw: string; unresolved: RenameUnresolved[]; editable: boolean } {
  if (file.path.startsWith('.obsidian/')) {
    return { raw: file.raw, unresolved: planObsidian(file.raw, file.path, from, catalogue), editable: true };
  }
  if (file.path.endsWith('.canvas')) {
    return { ...planCanvas(file.raw, file.path, from, to, catalogue, post), editable: true };
  }
  if (file.path.endsWith('.base')) {
    return { ...planBase(file.raw, file.path, from, to, catalogue, post), editable: true };
  }
  if (file.path.endsWith('.md') || file.path.endsWith('.markdown')) {
    return { ...planText(file.raw, file.path, from, to, catalogue, post), editable: true };
  }
  return { raw: file.raw, unresolved: [], editable: false };
}

export function planRename(input: RenamePlanInput): RenamePlan {
  if (input === null || typeof input !== 'object') {
    throw invalidInput('a rename plan requires an input object');
  }
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw invalidInput('a rename requires string source and target paths');
  }
  if (input.from === input.to) {
    throw invalidInput('a rename must change the path');
  }
  renameSegments(input.from);
  renameSegments(input.to);
  if (!Array.isArray(input.files)) throw invalidInput('rename snapshots must be an array');
  for (const file of input.files) {
    if (
      file === null ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      typeof file.raw !== 'string' ||
      typeof file.hash !== 'string' ||
      !HASH_PATTERN.test(file.hash)
    ) {
      throw invalidInput('a rename snapshot must contain a path, raw text, and sha256 hash');
    }
  }

  const { from, to } = input;
  const conflicts: RenameConflict[] = [];
  const source = input.files.find((file) => file.path === from);
  if (source === undefined) conflicts.push({ path: from, reason: 'source_missing' });

  const targetKey = collisionKey(to);
  for (const file of input.files) {
    if (file.path === from) continue;
    if (collisionKey(file.path) === targetKey) {
      conflicts.push({ path: to, reason: 'target_occupied' });
    }
  }

  const caseOnly = collisionKey(from) === collisionKey(to);
  const moves: RenameMove[] = caseOnly
    ? [
        { from, to: caseSafeTemporaryPath(to) },
        { from: caseSafeTemporaryPath(to), to }
      ]
    : [{ from, to }];

  const catalogue = new Map<string, string | undefined>();
  for (const file of input.files) {
    if (file.path.startsWith('.obsidian/')) continue;
    catalogue.set(file.path, identifierOf(file.raw, file.path));
  }
  const post = new Map(catalogue);
  post.delete(from);
  if (source !== undefined) post.set(to, identifierOf(source.raw, from));

  const edits: RenameEdit[] = [];
  const unresolved: RenameUnresolved[] = [];
  for (const file of input.files) {
    const planned = planFile(file, from, to, catalogue, post);
    unresolved.push(...planned.unresolved);
    if (planned.editable && planned.raw !== file.raw) {
      edits.push({ path: file.path, expected_hash: file.hash, raw: planned.raw });
    }
  }

  const uniqueUnresolved: RenameUnresolved[] = [];
  const seen = new Set<string>();
  for (const entry of unresolved) {
    const key = `${entry.path}\u0000${entry.target}\u0000${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueUnresolved.push(entry);
  }

  return {
    from,
    to,
    source_hash: source?.hash ?? '',
    moves,
    edits,
    unresolved: uniqueUnresolved,
    conflicts,
    idempotency_key: input.idempotency_key ?? `rename:${from}->${to}`
  };
}
