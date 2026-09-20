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
