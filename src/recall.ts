import { invalidInput } from './errors.js';
import { literalMatch, type ChunkHit, type IndexedNote, type SearchIndex } from './index/search-index.js';
import type { Projects } from './projects.js';
import type { Store } from './store.js';
import { LIMITS, type FeedbackSummary, type NoteType } from './types.js';

export interface RecallInput {
  query: string;
  project?: string;
  types?: NoteType[];
  limit?: number;
}

export interface RecallItem {
  id: string | null;
  path: string;
  project: string | null;
  title: string;
  type: NoteType;
  tags: string[];
  heading: string | null;
  excerpt: string;
  feedback: FeedbackSummary;
  demoted: boolean;
}

const CANDIDATE_CHUNKS = 200;

function excerpt(text: string): string {
  const characters = Array.from(text);
  return characters.length <= LIMITS.excerptChars ? text : characters.slice(0, LIMITS.excerptChars).join('');
}

export function recall(
  deps: { index: SearchIndex; store: Store; projects: Projects },
  input: RecallInput
): { items: RecallItem[] } {
  if (literalMatch(input.query) === null) throw invalidInput('query must contain at least one word');
  const limit = input.limit ?? LIMITS.recallDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.recallMax) {
    throw invalidInput(`limit must be between 1 and ${LIMITS.recallMax}`);
  }
  const project = input.project === undefined ? undefined : deps.projects.resolve(input.project).name;
  const best = new Map<string, ChunkHit>();
  for (const hit of deps.index.search(input.query, { project, types: input.types }, CANDIDATE_CHUNKS)) {
    if (!best.has(hit.path)) best.set(hit.path, hit);
  }
  const ranked: { hit: ChunkHit; note: IndexedNote; demoted: boolean }[] = [];
  for (const hit of best.values()) {
    const note = deps.index.get(hit.path);
    if (note === undefined) continue;
    ranked.push({ hit, note, demoted: note.id !== null && deps.store.isDemoted(note.id, note.hash) });
  }
  ranked.sort(
    (left, right) =>
      Number(left.demoted) - Number(right.demoted) || left.hit.rank - right.hit.rank || left.note.path.localeCompare(right.note.path)
  );
  return {
    items: ranked.slice(0, limit).map(({ hit, note, demoted }) => ({
      id: note.id,
      path: note.path,
      project: note.project,
      title: note.title,
      type: note.type,
      tags: note.tags,
      heading: hit.heading,
      excerpt: excerpt(hit.text),
      feedback: note.id === null ? {} : deps.store.feedbackSummary(note.id),
      demoted
    }))
  };
}
