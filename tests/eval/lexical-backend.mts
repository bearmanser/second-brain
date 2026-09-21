import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import type { BackendHit, BackendSearch } from '../../src/core/types.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'under',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did',
  'not', 'but', 'its', 'our', 'their', 'they', 'you', 'your', 'all', 'any',
  'can', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'onto',
  'about', 'after', 'before', 'when', 'while', 'which', 'there', 'here',
  'than', 'then', 'them', 'they', 'what', 'who', 'how', 'why', 'use', 'used',
  'using', 'one', 'two', 'per', 'via', 'instead', 'through', 'only'
]);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}

interface LexicalNote {
  relative_path: string;
  permalink: string;
  revision_id: string;
  logical_id: string;
  kind: string;
  status: string;
  title: string;
  body: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === 'string' ? (source[key] as string) : '';
}

function splitFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) return {};
  try {
    return asRecord(parse(match[1]));
  } catch {
    return {};
  }
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(absolute);
  }
  return found;
}

function scanNotes(root: string, project: string): LexicalNote[] {
  const projectRoot = join(root, project);
  const notes: LexicalNote[] = [];
  for (const absolute of walk(projectRoot)) {
    const raw = readFileSync(absolute, 'utf8');
    const frontmatter = splitFrontmatter(raw);
    const kind = stringField(frontmatter, 'type');
    const status = stringField(frontmatter, 'brain_status');
    if (kind.length === 0 || status.length === 0) continue;
    notes.push({
      relative_path: relative(projectRoot, absolute).split(sep).join('/'),
      permalink: stringField(frontmatter, 'permalink'),
      revision_id: stringField(frontmatter, 'brain_revision_id'),
      logical_id: stringField(frontmatter, 'brain_id'),
      kind,
      status,
      title: stringField(frontmatter, 'brain_title') || stringField(frontmatter, 'title'),
      body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    });
  }
  return notes;
}

export interface LexicalSearchOptions {
  title_weight?: number;
  max_body_hits?: number;
}

export function lexicalHits(
  root: string,
  input: BackendSearch
): { hits: BackendHit[]; has_more: boolean } {
  const terms = [...new Set(tokenize(input.query))];
  if (terms.length === 0) return { hits: [], has_more: false };
  const kindSet = new Set<string>(input.kinds);
  const statusSet = new Set<string>(input.statuses);
  const scored = scanNotes(root, input.project)
    .filter((note) => kindSet.has(note.kind) && statusSet.has(note.status))
    .map((note) => {
      const titleTokens = tokenize(note.title);
      const bodyTokens = tokenize(note.body);
      let score = 0;
      for (const term of terms) {
        if (titleTokens.includes(term)) score += 3;
        const occurrences = bodyTokens.filter((token) => token === term).length;
        if (occurrences > 0) score += Math.min(occurrences, 3);
      }
      return { note, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.note.relative_path.localeCompare(right.note.relative_path)
    );

  const start = Math.max(0, (input.page - 1) * input.page_size);
  const page = scored.slice(start, start + input.page_size);
  return {
    hits: page.map((entry) => ({
      permalink: entry.note.permalink,
      relative_path: entry.note.relative_path,
      revision_id: entry.note.revision_id,
      logical_id: entry.note.logical_id,
      rank: entry.score,
      matched_text: entry.note.body.trim().replace(/\s+/g, ' ').slice(0, 240)
    })),
    has_more: start + input.page_size < scored.length
  };
}

export function makeLexicalSearch(
  root: string
): (input: BackendSearch) => Promise<{ hits: BackendHit[]; has_more: boolean }> {
  return async (input: BackendSearch) => lexicalHits(root, input);
}
