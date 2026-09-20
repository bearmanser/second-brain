import { createHash } from 'node:crypto';
import type { NoteKind } from '../core/types.js';
import { KIND_FOLDERS } from './registry.js';

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'note';
}

export function slugifyPath(value: string): string {
  return value
    .split('/')
    .map((segment) => slugify(segment))
    .join('/');
}

export function storageTitle(noteTitle: string, revisionId: string): string {
  return `${noteTitle} r${revisionId}`;
}

export function revisionDirectory(kind: NoteKind, id: string): string {
  return `${KIND_FOLDERS[kind]}/${id}`;
}

export function revisionFileName(noteTitle: string, revisionId: string): string {
  return `${slugify(storageTitle(noteTitle, revisionId))}.md`;
}

export function permalinkFor(backendProject: string, directory: string, title: string): string {
  return `${slugifyPath(backendProject)}/${slugifyPath(directory)}/${slugify(title)}`;
}

export function relativePathFor(
  relativeRoot: string,
  kind: NoteKind,
  id: string,
  noteTitle: string,
  revisionId: string
): string {
  const segments = [relativeRoot, revisionDirectory(kind, id), revisionFileName(noteTitle, revisionId)]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0);
  return segments.join('/');
}

export function hashRaw(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function makeEtag(revisionId: string, rawHash: string): string {
  return createHash('sha256').update(`${revisionId}:${rawHash}`).digest('hex');
}
