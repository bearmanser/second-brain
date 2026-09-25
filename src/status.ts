import type { SearchIndex } from './index/search-index.js';
import type { Problem, Sync } from './index/sync.js';
import type { Projects } from './projects.js';
import { VERSION } from './types.js';

export interface StatusResult {
  version: string;
  notes: number;
  projects: { name: string; key: string; repositories: string[]; notes: number }[];
  problems: Problem[];
}

export function status(deps: { index: SearchIndex; projects: Projects; sync: Sync }): StatusResult {
  const notes = deps.index.all();
  const counts = new Map<string, number>();
  for (const note of notes) if (note.project !== null) counts.set(note.project, (counts.get(note.project) ?? 0) + 1);
  return {
    version: VERSION,
    notes: notes.length,
    projects: deps.projects.list().map((project) => ({
      name: project.name,
      key: project.key,
      repositories: project.repositories,
      notes: counts.get(project.name) ?? 0
    })),
    problems: deps.sync.problems()
  };
}
