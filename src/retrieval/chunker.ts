import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { CurrentDocument } from '../notes/document.js';
import { extractLinks } from '../notes/links.js';
import { countReferenceTokens } from './budget.js';

export const CHUNK_TARGET_TOKENS = 256;
export const CHUNK_OVERLAP_TOKENS = 32;

export interface SearchChunk {
  chunk_key: string;
  document_key: string;
  id?: string;
  path: string;
  title: string;
  heading: string | null;
  line_from: number;
  line_to: number;
  start_offset: number;
  end_offset: number;
  text: string;
  source_hash: string;
  reference_tokens: string[];
}

interface MarkdownNode {
  type?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

interface BodyBlock {
  type: string;
  start: number;
  end: number;
  heading?: string;
}

interface Section {
  heading: string | null;
  blocks: BodyBlock[];
}

interface Segment {
  start: number;
  end: number;
  heading: string | null;
  section: number;
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function bodyOffset(raw: string, body: string): number {
  if (body.length === 0) return raw.length;
  if (raw.endsWith(body)) return raw.length - body.length;
  const index = raw.indexOf(body);
  return index >= 0 ? index : 0;
}

function nodesOf(body: string): MarkdownNode[] {
  try {
    return fromMarkdown(body).children as unknown as MarkdownNode[];
  } catch {
    return [];
  }
}

function nodeRange(node: MarkdownNode): [number, number] | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
}

function headingText(body: string, start: number, end: number): string {
  return body
    .slice(start, end)
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/\s*#+\s*$/, '')
    .replace(/[\r\n]+$/, '')
    .trim();
}

function bodyBlocks(body: string, offset: number): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  for (const node of nodesOf(body)) {
    const range = nodeRange(node);
    if (range === undefined || range[1] <= range[0]) continue;
    const type = node.type ?? 'paragraph';
    const block: BodyBlock = {
      type,
      start: offset + range[0],
      end: offset + range[1]
    };
    if (type === 'heading') block.heading = headingText(body, range[0], range[1]);
    blocks.push(block);
  }
  blocks.sort((left, right) => left.start - right.start || left.end - right.end);
  return blocks;
}

function sectionsOf(blocks: BodyBlock[], title: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const block of blocks) {
    if (block.type === 'heading') {
      current = { heading: block.heading ?? null, blocks: [block] };
      sections.push(current);
      continue;
    }
    if (current === undefined) {
      current = { heading: title.length > 0 ? title : null, blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  return sections;
}

function overlapBoundary(raw: string, start: number, end: number, maxTokens: number): number {
  let low = start;
  let high = end - 1;
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (countReferenceTokens(raw.slice(middle, end)) <= maxTokens) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

function fitOverlapStart(
  raw: string,
  minimum: number,
  maximum: number,
  end: number,
  maxTokens: number
): number {
  let low = minimum;
  let high = maximum;
  let best = maximum;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (countReferenceTokens(raw.slice(middle, end)) <= maxTokens) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

function splitOversized(raw: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let cursor = start;
  while (cursor < end) {
    let low = cursor + 1;
    let high = end;
    let best = end;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (countReferenceTokens(raw.slice(cursor, middle)) <= CHUNK_TARGET_TOKENS) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    let stop = best;
    if (stop < end) {
      const newline = raw.lastIndexOf('\n', stop - 1);
      if (newline > cursor) stop = newline + 1;
    }
    if (stop <= cursor) stop = Math.min(cursor + 1, end);
    parts.push([cursor, Math.min(stop, end)]);
    if (stop >= end) break;
    const overlap = overlapBoundary(raw, cursor, stop, CHUNK_OVERLAP_TOKENS);
    cursor = overlap > cursor ? overlap : stop;
  }
  return parts;
}

function segmentSection(
  raw: string,
  section: Section,
  sectionIndex: number,
  output: Segment[]
): void {
  const blocks = section.blocks;
  let index = 0;
  while (index < blocks.length) {
    const start = blocks[index].start;
    let last = index;
    let end = blocks[index].end;
    while (last + 1 < blocks.length) {
      const candidateEnd = blocks[last + 1].end;
      if (countReferenceTokens(raw.slice(start, candidateEnd)) > CHUNK_TARGET_TOKENS) break;
      last += 1;
      end = blocks[last].end;
    }
    if (last === index && countReferenceTokens(raw.slice(start, end)) > CHUNK_TARGET_TOKENS) {
      for (const [partStart, partEnd] of splitOversized(raw, start, end)) {
        output.push({ start: partStart, end: partEnd, heading: section.heading, section: sectionIndex });
      }
      index += 1;
      continue;
    }
    output.push({ start, end, heading: section.heading, section: sectionIndex });
    index = last + 1;
  }
}

function lineStarts(raw: string): number[] {
  const starts = [0];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best + 1;
}

function referenceTokensIn(
  references: ReadonlyArray<{ target: string; fragment?: string; start: number }>,
  start: number,
  end: number
): string[] {
  const tokens: string[] = [];
  for (const reference of references) {
    if (reference.start < start || reference.start >= end) continue;
    const token =
      reference.fragment === undefined || reference.fragment.length === 0
        ? reference.target
        : `${reference.target}#${reference.fragment}`;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

export function chunkDocument(document: CurrentDocument, raw: string): SearchChunk[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const documentKey = document.id ?? document.path;
  const sourceHash = sha256(raw);
  const offset = bodyOffset(raw, document.body);
  const body = raw.slice(offset);
  const references = extractLinks(raw);
  const starts = lineStarts(raw);
  const build = (start: number, end: number, heading: string | null): SearchChunk => ({
    chunk_key: `${documentKey}#${start}-${end}`,
    document_key: documentKey,
    ...(document.id === undefined ? {} : { id: document.id }),
    path: document.path,
    title: document.title,
    heading,
    line_from: lineAt(starts, start),
    line_to: lineAt(starts, Math.max(start, end - 1)),
    start_offset: start,
    end_offset: end,
    text: raw.slice(start, end),
    source_hash: sourceHash,
    reference_tokens: referenceTokensIn(references, start, end)
  });
  if (body.trim().length === 0) {
    return splitOversized(raw, 0, raw.length).map(([start, end]) => build(start, end, null));
  }
  const sections = sectionsOf(bodyBlocks(body, offset), document.title);
  const segments: Segment[] = [];
  sections.forEach((section, index) => segmentSection(raw, section, index, segments));
  const chunks: SearchChunk[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let start = segment.start;
    if (index > 0 && segments[index - 1].section === segment.section) {
      const previous = segments[index - 1];
      const overlap = overlapBoundary(raw, previous.start, previous.end, CHUNK_OVERLAP_TOKENS);
      if (overlap > previous.start && overlap < segment.end) {
        start =
          countReferenceTokens(raw.slice(overlap, segment.end)) <= CHUNK_TARGET_TOKENS
            ? overlap
            : fitOverlapStart(raw, overlap, segment.start, segment.end, CHUNK_TARGET_TOKENS);
      }
    }
    if (start >= segment.end) start = segment.start;
    const chunk = build(start, segment.end, segment.heading);
    if (chunk.text.length === 0) continue;
    chunks.push(chunk);
  }
  return chunks;
}
