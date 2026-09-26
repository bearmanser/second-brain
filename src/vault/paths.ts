import { invalidInput } from '../errors.js';
import { LIMITS } from '../types.js';

const FORBIDDEN_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const ENCODED = /%(2e|2f|5c|00)/i;

export function sanitizeFileStem(title: string): string {
  const cleaned = title.replace(FORBIDDEN_FILENAME, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  const cut = Array.from(cleaned).slice(0, LIMITS.filenameChars).join('').trim().replace(/[. ]+$/, '');
  return cut.length > 0 ? cut : 'Untitled';
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

export function isIgnoredPath(path: string): boolean {
  const first = path.split('/')[0];
  return first === '.obsidian' || first === '.trash';
}

export function assertNotePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw invalidInput('path must be a vault-relative .md path');
  }
  if (
    path.includes('\\') ||
    path.includes('\u0000') ||
    ENCODED.test(path) ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw invalidInput(`path is not a safe vault-relative path: ${path}`);
  }
  if (!path.endsWith('.md')) throw invalidInput(`path must end in .md: ${path}`);
  if (isIgnoredPath(path)) throw invalidInput(`path is inside .obsidian/ or .trash/: ${path}`);
  return path;
}

export function projectOfPath(path: string): string | null {
  const segments = path.split('/');
  return segments.length >= 3 && segments[0] === 'Projects' ? segments[1] : null;
}

export function isProjectNotePath(path: string): boolean {
  const segments = path.split('/');
  return segments.length === 3 && segments[0] === 'Projects' && segments[2] === `${segments[1]}.md`;
}

export function projectNotePath(project: string): string {
  return `Projects/${project}/${project}.md`;
}

export function noteDirectory(project: string | null): string {
  return project === null ? 'Notes' : `Projects/${project}`;
}

export function withCollisionSuffix(stem: string, taken: (candidate: string) => boolean): string {
  if (!taken(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})`;
    if (!taken(candidate)) return candidate;
  }
}

export function stemOf(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.md$/, '');
}

export function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}
