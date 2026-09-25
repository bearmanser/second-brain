export interface Chunk {
  heading: string | null;
  text: string;
}

export const CHUNK_MAX_CHARS = 1200;

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

interface FenceState {
  open: string | null;
}

function fenceStep(line: string, state: FenceState): boolean {
  const match = FENCE.exec(line);
  if (state.open !== null) {
    if (match !== null && match[1][0] === state.open[0] && match[1].length >= state.open.length) state.open = null;
    return true;
  }
  if (match !== null) {
    state.open = match[1];
    return true;
  }
  return false;
}

function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const state: FenceState = { open: null };
  const flush = (): void => {
    if (current.length > 0) out.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (fenceStep(line, state)) {
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}

function splitLong(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > CHUNK_MAX_CHARS) {
      if (current.length > 0) out.push(current);
      current = '';
      for (let start = 0; start < line.length; start += CHUNK_MAX_CHARS) out.push(line.slice(start, start + CHUNK_MAX_CHARS));
      continue;
    }
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > CHUNK_MAX_CHARS) {
      out.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function pack(parts: string[]): string[] {
  const out: string[] = [];
  let current = '';
  const add = (piece: string): void => {
    if (current.length === 0) {
      current = piece;
    } else if (current.length + 2 + piece.length <= CHUNK_MAX_CHARS) {
      current = `${current}\n\n${piece}`;
    } else {
      out.push(current);
      current = piece;
    }
  };
  for (const part of parts) {
    if (part.length <= CHUNK_MAX_CHARS) add(part);
    else for (const piece of splitLong(part)) add(piece);
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function chunkNote(title: string, body: string): Chunk[] {
  const sections: { heading: string | null; lines: string[] }[] = [
    { heading: title.length > 0 ? title : null, lines: [] }
  ];
  const state: FenceState = { open: null };
  for (const line of body.split(/\r?\n/)) {
    const current = sections[sections.length - 1];
    if (fenceStep(line, state)) {
      current.lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      sections.push({ heading: heading[2].trim() || null, lines: [line] });
      continue;
    }
    current.lines.push(line);
  }
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const text of pack(blocks(section.lines))) {
      if (text.trim().length > 0) chunks.push({ heading: section.heading, text });
    }
  }
  return chunks.length > 0 ? chunks : [{ heading: title.length > 0 ? title : null, text: '' }];
}
