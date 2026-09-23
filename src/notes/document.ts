import { NOTE_KINDS, type NoteKind } from '../core/types.js';

export const BRAIN_SCHEMA_VERSION = 2;

export const DOCUMENT_STATUSES = ['candidate', 'active', 'superseded', 'archived'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DEFAULT_TYPE_FOR_KIND = {
  lesson: 'lesson',
  decision: 'decision',
  playbook: 'playbook',
  fact: 'fact',
  preference: 'preference',
  session: 'session',
  note: 'note'
} as const;

export const HUMAN_DOCUMENT_TYPES = [
  'project',
  'architecture',
  'research',
  'concept',
  'task',
  'person',
  'meeting',
  'reference',
  'daily'
] as const;
export type HumanDocumentType = (typeof HUMAN_DOCUMENT_TYPES)[number];

export const SOURCE_SECTION_TITLE = 'Sources';

export interface CurrentDocument {
  id?: string;
  path: string;
  title: string;
  type: string;
  status: DocumentStatus;
  project?: string;
  aliases: string[];
  tags: string[];
  created?: string;
  updated?: string;
  properties: Record<string, unknown>;
  body: string;
}

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(value);
}

export function contentKindForType(type: string): NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(type) ? (type as NoteKind) : 'note';
}
