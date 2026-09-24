import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectHubPath, projectProperty } from '../projects/hub.js';

export interface ProjectIndexInput {
  id: string;
  display_name: string;
  relative_root: string;
  repository_identity?: string;
}

export interface ProjectIndexOptions {
  today?: string;
}

export type ProjectIndexWrite = 'created' | 'unchanged' | 'conflict';

export function projectIndexPath(project: ProjectIndexInput): string {
  return projectHubPath(project.relative_root);
}

export function projectIndexDocument(
  project: ProjectIndexInput,
  options: ProjectIndexOptions = {}
): string {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  return [
    '---',
    'type: project',
    'status: active',
    `project: "${projectProperty(project.relative_root)}"`,
    `created: ${today}`,
    `updated: ${today}`,
    'aliases: []',
    'tags: []',
    '---',
    '',
    `# ${project.display_name}`,
    '',
    '## Overview',
    '',
    '## Notes',
    '',
    '![[Views/Project notes.base]]',
    '',
    '## Sources',
    '',
    '## Related notes',
    ''
  ].join('\n');
}

export function writeProjectIndex(
  vaultRoot: string,
  project: ProjectIndexInput,
  options: ProjectIndexOptions = {}
): ProjectIndexWrite {
  const relative = projectIndexPath(project);
  const absolute = join(vaultRoot, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  try {
    writeFileSync(absolute, projectIndexDocument(project, options), {
      encoding: 'utf8',
      flag: 'wx'
    });
    return 'created';
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const info = lstatSync(absolute);
    return info.isFile() && !info.isSymbolicLink() ? 'unchanged' : 'conflict';
  }
}
