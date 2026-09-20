import type { Head, NoteKind, Phase } from '../core/types.js';

export interface EligibleHit {
  head: Head;
  rank: number;
  matched_section: string;
  reasons: string[];
}

const PHASE_KINDS: Partial<Record<Phase, readonly NoteKind[]>> = {
  debugging: ['lesson', 'playbook'],
  planning: ['decision'],
  handoff: ['session']
};

const WINDOW_SIZE = 3;

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

  const ranked: EligibleHit[] = [];
  for (let start = 0; start < ordered.length; start += WINDOW_SIZE) {
    const bucket = ordered.slice(start, start + WINDOW_SIZE);
    const first: EligibleHit[] = [];
    const rest: EligibleHit[] = [];
    for (const hit of bucket) {
      if (preferred.includes(hit.head.source.kind)) {
        first.push(hit);
      } else {
        rest.push(hit);
      }
    }
    ranked.push(...first, ...rest);
  }
  return ranked;
}
