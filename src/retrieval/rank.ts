import type { Head, NoteKind, Phase } from '../core/types.js';

export interface EligibleHit {
  head: Head;
  rank: number;
  matched_section: string;
  reasons: string[];
}

export const DEFAULT_MAX_CANDIDATES_PER_NOTE = 2;

export interface OrderableCandidate {
  chunk_key: string;
  document_key: string;
  candidate_position: number;
  line_from: number;
  line_to: number;
  start_offset: number;
  end_offset: number;
  relevance_score?: number;
}

export function rankCandidateChunks<T extends OrderableCandidate>(candidates: readonly T[]): T[] {
  const scored = candidates.filter(
    (candidate) => typeof candidate.relevance_score === 'number' && Number.isFinite(candidate.relevance_score)
  );
  const unscored = candidates.filter(
    (candidate) => typeof candidate.relevance_score !== 'number' || !Number.isFinite(candidate.relevance_score)
  );
  scored.sort(
    (left, right) =>
      (right.relevance_score as number) - (left.relevance_score as number) ||
      left.candidate_position - right.candidate_position
  );
  return [...scored, ...unscored];
}

export function selectDistinctCandidateChunks<T extends OrderableCandidate>(
  candidates: readonly T[],
  maxPerNote: number = DEFAULT_MAX_CANDIDATES_PER_NOTE
): T[] {
  const limit = Number.isFinite(maxPerNote) ? Math.max(0, Math.trunc(maxPerNote)) : candidates.length;
  const keptByNote = new Map<string, Array<{ chunk_key: string; start_offset: number; end_offset: number }>>();
  const selected: T[] = [];
  for (const candidate of candidates) {
    const kept = keptByNote.get(candidate.document_key) ?? [];
    if (kept.some((entry) => entry.chunk_key === candidate.chunk_key)) continue;
    if (kept.length >= limit) continue;
    const overlaps = kept.some(
      (entry) => candidate.start_offset < entry.end_offset && entry.start_offset < candidate.end_offset
    );
    if (overlaps) continue;
    kept.push({ chunk_key: candidate.chunk_key, start_offset: candidate.start_offset, end_offset: candidate.end_offset });
    keptByNote.set(candidate.document_key, kept);
    selected.push(candidate);
  }
  return selected;
}

const PHASE_KINDS: Partial<Record<Phase, readonly NoteKind[]>> = {
  debugging: ['lesson', 'playbook'],
  planning: ['decision'],
  handoff: ['session']
};

const MAX_RANK_DISTANCE = 2;

export function phaseKinds(phase: Phase): readonly NoteKind[] {
  return PHASE_KINDS[phase] ?? [];
}

export function rankEligible(hits: EligibleHit[], phase: Phase): EligibleHit[] {
  const ordered = hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => right.hit.rank - left.hit.rank || left.index - right.index)
    .map((entry) => entry.hit);
  const preferred = phaseKinds(phase);
  if (preferred.length === 0) return ordered;

  const remaining = [...ordered];
  const ranked: EligibleHit[] = [];
  while (remaining.length > 0) {
    const windowSize = Math.min(MAX_RANK_DISTANCE + 1, remaining.length);
    let pick = 0;
    for (let index = 1; index < windowSize; index += 1) {
      if (preferred.includes(remaining[index].head.source.kind)) {
        pick = index;
        break;
      }
    }
    ranked.push(remaining.splice(pick, 1)[0]);
  }
  return ranked;
}
