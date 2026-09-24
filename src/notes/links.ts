import { fromMarkdown } from 'mdast-util-from-markdown';
import { isMap, isScalar, isSeq, parseDocument as parseYamlDocument } from 'yaml';

export type LinkSyntax = 'wikilink' | 'markdown';

export interface LinkReference {
  target: string;
  fragment?: string;
  label?: string;
  embed: boolean;
  start: number;
  end: number;
  syntax: LinkSyntax;
}

export type LinkReferenceInput = {
  target: string;
  fragment?: string;
  syntax?: LinkSyntax;
};

export const RELATIONSHIP_KINDS = ['related', 'supersedes', 'depends_on', 'implements'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export interface RelationshipEdge {
  kind: RelationshipKind;
  reference: LinkReference;
}

export interface ResolvedRelationship {
  kind: RelationshipKind;
  source: string;
  target: string;
  fragment?: string;
  id?: string;
}

export interface Backlink {
  kind: RelationshipKind;
  source: string;
  target: string;
}

export type SupersessionValidation =
  | { ok: true }
  | { ok: false; reason: 'self-supersession'; path: string }
  | { ok: false; reason: 'supersession-cycle'; cycle: string[] };

interface MarkdownNode {
  type?: string;
  url?: string;
  alt?: string | null;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

interface SplitSource {
  frontmatter: string;
  frontmatterStart: number;
  body: string;
  bodyStart: number;
}

interface FrontmatterReference {
  property: string;
  reference: LinkReference;
}

const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'data',
  'file',
  'ftp',
  'ftps',
  'http',
  'https',
  'javascript',
  'mailto',
  'obsidian',
  'tel'
]);

const FRONTMATTER_DELIMITER = /^\uFEFF?---[ \t]*$/;
const MARKDOWN_PATTERN = /(!?)\[([^\]]*)\]\(([^()\s]+)\)/g;

export function isExternalTarget(target: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(target.trim());
  return match !== null && EXTERNAL_SCHEMES.has(match[1].toLowerCase());
}

function lineEnd(text: string, from: number): number {
  const index = text.indexOf('\n', from);
  return index === -1 ? text.length : index;
}

function lineText(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/\r$/, '');
}

function splitFrontmatter(raw: string): SplitSource {
  const firstBreak = raw.indexOf('\n');
  const firstLine = lineText(raw, 0, firstBreak === -1 ? raw.length : firstBreak);
  if (!FRONTMATTER_DELIMITER.test(firstLine)) {
    return { frontmatter: '', frontmatterStart: 0, body: raw, bodyStart: 0 };
  }
  let cursor = firstBreak === -1 ? raw.length : firstBreak + 1;
  while (cursor <= raw.length) {
    const nextBreak = raw.indexOf('\n', cursor);
    const end = nextBreak === -1 ? raw.length : nextBreak;
    if (FRONTMATTER_DELIMITER.test(lineText(raw, cursor, end))) {
      const bodyStart = nextBreak === -1 ? raw.length : nextBreak + 1;
      return {
        frontmatter: raw.slice(firstBreak + 1, cursor),
        frontmatterStart: firstBreak + 1,
        body: raw.slice(bodyStart),
        bodyStart
      };
    }
    if (nextBreak === -1) break;
    cursor = nextBreak + 1;
  }
  return { frontmatter: '', frontmatterStart: 0, body: raw, bodyStart: 0 };
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function overlapsAny(ranges: readonly [number, number][], start: number, end: number): boolean {
  for (const [rangeStart, rangeEnd] of ranges) {
    if (start < rangeEnd && rangeStart < end) return true;
  }
  return false;
}

function unescapeInner(value: string): string {
  return value.replace(/\\([|#[\]]|\\)/g, '$1');
}

function stripEscapeBeforePipe(head: string): string {
  let trailing = 0;
  while (trailing < head.length && head[head.length - 1 - trailing] === '\\') trailing += 1;
  return trailing % 2 === 1 ? head.slice(0, -1) : head;
}

function splitWikilinkInner(
  inner: string
): { target: string; fragment?: string; label?: string } | undefined {
  const pipe = inner.indexOf('|');
  const head = pipe === -1 ? inner : stripEscapeBeforePipe(inner.slice(0, pipe));
  const aliasRaw = pipe === -1 ? undefined : inner.slice(pipe + 1);
  const hash = head.indexOf('#');
  const targetRaw = hash === -1 ? head : head.slice(0, hash);
  const fragmentRaw = hash === -1 ? undefined : head.slice(hash + 1);
  const target = unescapeInner(targetRaw).trim();
  if (target.length === 0) return undefined;
  const fragment = fragmentRaw === undefined ? undefined : unescapeInner(fragmentRaw).trim();
  const label = aliasRaw === undefined ? undefined : unescapeInner(aliasRaw).trim();
  return {
    target,
    ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
    ...(label === undefined || label.length === 0 ? {} : { label })
  };
}

function findWikilinkClose(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === ']' && text[cursor + 1] === ']') return cursor;
    cursor += 1;
  }
  return -1;
}

function scanWikilinks(
  text: string,
  base: number,
  excluded: readonly [number, number][],
  output: LinkReference[]
): void {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('[[', index);
    if (open === -1) break;
    const bang = open > 0 && text[open - 1] === '!';
    if (bang && isEscaped(text, open - 1)) {
      index = open + 1;
      continue;
    }
    if (isEscaped(text, open)) {
      index = open + 1;
      continue;
    }
    const close = findWikilinkClose(text, open + 2);
    if (close === -1) {
      index = open + 1;
      continue;
    }
    const start = base + (bang ? open - 1 : open);
    const end = base + close + 2;
    if (!overlapsAny(excluded, start, end)) {
      const inner = splitWikilinkInner(text.slice(open + 2, close));
      if (inner !== undefined) {
        output.push({
          ...inner,
          embed: bang,
          start,
          end,
          syntax: 'wikilink'
        });
      }
    }
    index = close + 2;
  }
}

function scanMarkdownSyntax(text: string, base: number, output: LinkReference[]): void {
  const pattern = new RegExp(MARKDOWN_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = match[3];
    if (isExternalTarget(url)) continue;
    const hash = url.indexOf('#');
    const target = hash === -1 ? url : url.slice(0, hash);
    if (target.length === 0) continue;
    const fragment = hash === -1 ? undefined : url.slice(hash + 1);
    const label = match[2].length > 0 ? match[2] : undefined;
    output.push({
      target,
      ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
      ...(label === undefined ? {} : { label }),
      embed: match[1] === '!',
      start: base + match.index,
      end: base + match.index + match[0].length,
      syntax: 'markdown'
    });
  }
}

function nodeRange(node: MarkdownNode): [number, number] | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
}

function walk(nodes: MarkdownNode[], visit: (node: MarkdownNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children !== undefined) walk(node.children, visit);
  }
}

function textContent(nodes: MarkdownNode[] | undefined): string | undefined {
  if (nodes === undefined) return undefined;
  let text = '';
  for (const node of nodes) {
    if (typeof node.value === 'string') text += node.value;
    if (node.children !== undefined) text += textContent(node.children) ?? '';
  }
  return text.length > 0 ? text : undefined;
}

function markdownReference(node: MarkdownNode, base: number): LinkReference | undefined {
  const url = node.url;
  if (url === undefined || url.length === 0) return undefined;
  if (isExternalTarget(url)) return undefined;
  const range = nodeRange(node);
  if (range === undefined) return undefined;
  const hash = url.indexOf('#');
  const target = hash === -1 ? url : url.slice(0, hash);
  if (target.length === 0) return undefined;
  const fragment = hash === -1 ? undefined : url.slice(hash + 1);
  const label = node.type === 'image' ? node.alt ?? undefined : textContent(node.children);
  return {
    target,
    ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
    ...(label === undefined || label.length === 0 ? {} : { label }),
    embed: node.type === 'image',
    start: base + range[0],
    end: base + range[1],
    syntax: 'markdown'
  };
}

function labelSpan(node: MarkdownNode): [number, number] | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const child of node.children ?? []) {
    const range = nodeRange(child);
    if (range === undefined) continue;
    if (start === undefined || range[0] < start) start = range[0];
    if (end === undefined || range[1] > end) end = range[1];
  }
  return start === undefined || end === undefined ? undefined : [start, end];
}

function scanBody(body: string, base: number, output: LinkReference[]): void {
  const excluded: [number, number][] = [];
  const references: LinkReference[] = [];
  let tree: { children?: MarkdownNode[] } | undefined;
  try {
    tree = fromMarkdown(body) as unknown as { children?: MarkdownNode[] };
  } catch {
    tree = undefined;
  }
  if (tree?.children !== undefined) {
    walk(tree.children, (node) => {
      const range = nodeRange(node);
      if (range === undefined) return;
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
        excluded.push([base + range[0], base + range[1]]);
        return;
      }
      if (node.type === 'link' || node.type === 'image') {
        const reference = markdownReference(node, base);
        if (reference !== undefined) references.push(reference);
        const label = node.type === 'image' ? undefined : labelSpan(node);
        if (label === undefined) {
          excluded.push([base + range[0], base + range[1]]);
        } else {
          excluded.push([base + range[0], base + label[0]]);
          excluded.push([base + label[1], base + range[1]]);
        }
      }
    });
  }
  scanWikilinks(body, base, excluded, output);
  output.push(...references);
}

function scanYamlScalar(
  node: unknown,
  property: string,
  text: string,
  base: number,
  output: FrontmatterReference[]
): void {
  if (isScalar(node)) {
    if (typeof node.value !== 'string') return;
    const range = node.range;
    if (range === null || range === undefined) return;
    const slice = text.slice(range[0], range[1]);
    const found: LinkReference[] = [];
    scanWikilinks(slice, base + range[0], [], found);
    scanMarkdownSyntax(slice, base + range[0], found);
    for (const reference of found) output.push({ property, reference });
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) scanYamlScalar(item, property, text, base, output);
  }
}

function scanFrontmatter(split: SplitSource): FrontmatterReference[] {
  if (split.frontmatter.length === 0) return [];
  let document: ReturnType<typeof parseYamlDocument>;
  try {
    document = parseYamlDocument(split.frontmatter, { schema: 'core' });
  } catch {
    return [];
  }
  if (document.errors.length > 0 || !isMap(document.contents)) return [];
  const output: FrontmatterReference[] = [];
  for (const item of document.contents.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') continue;
    scanYamlScalar(item.value, item.key.value, split.frontmatter, split.frontmatterStart, output);
  }
  return output;
}

export function extractLinks(raw: string): LinkReference[] {
  if (typeof raw !== 'string') return [];
  const split = splitFrontmatter(raw);
  const body: LinkReference[] = [];
  scanBody(split.body, split.bodyStart, body);
  const references = [...body, ...scanFrontmatter(split).map((entry) => entry.reference)];
  references.sort((left, right) => left.start - right.start || left.end - right.end);
  return references;
}

export function extractRelationships(raw: string): RelationshipEdge[] {
  if (typeof raw !== 'string') return [];
  const split = splitFrontmatter(raw);
  const edges: RelationshipEdge[] = [];
  for (const entry of scanFrontmatter(split)) {
    if (!(RELATIONSHIP_KINDS as readonly string[]).includes(entry.property)) continue;
    edges.push({ kind: entry.property as RelationshipKind, reference: entry.reference });
  }
  return edges;
}

export function deriveBacklinks(
  edges: ReadonlyArray<{ kind: RelationshipKind; source: string; target: string }>
): Backlink[] {
  return edges.map((edge) => ({ kind: edge.kind, source: edge.target, target: edge.source }));
}

export function validateSupersessionGraph(
  edges: ReadonlyArray<{ kind?: RelationshipKind; source: string; target: string }>
): SupersessionValidation {
  const supersedes = edges.filter((edge) => edge.kind === undefined || edge.kind === 'supersedes');
  for (const edge of supersedes) {
    if (edge.source === edge.target) {
      return { ok: false, reason: 'self-supersession', path: edge.source };
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of supersedes) {
    const targets = adjacency.get(edge.source);
    if (targets === undefined) adjacency.set(edge.source, [edge.target]);
    else targets.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const findCycle = (node: string): string[] | undefined => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      return [...stack.slice(index), node];
    }
    if (visited.has(node)) return undefined;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = findCycle(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };
  for (const node of adjacency.keys()) {
    const cycle = findCycle(node);
    if (cycle !== undefined) return { ok: false, reason: 'supersession-cycle', cycle };
  }
  return { ok: true };
}

export function aliasLink(path: string, alias: string): string {
  return `[[${path}|${alias}]]`;
}
