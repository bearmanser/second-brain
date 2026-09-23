import type { NoteKind } from '../core/types.js';

export type SectionForm = 'prose' | 'yaml_list' | 'markdown';

export interface SectionSpec {
  field: string;
  title: string;
  form: SectionForm;
}

export interface KindRegistryEntry {
  kind: NoteKind;
  folder: string;
  sections: SectionSpec[];
}

export const EVIDENCE_SECTION_TITLE = 'Evidence';
export const RELATED_SECTION_TITLE = 'Related';

export const KIND_FOLDERS: Record<NoteKind, string> = {
  lesson: 'Lessons',
  decision: 'Decisions',
  playbook: 'Playbooks',
  fact: 'Facts',
  preference: 'Preferences',
  session: 'Sessions',
  note: 'Notes'
};

export const NOTE_REGISTRY: Record<NoteKind, KindRegistryEntry> = {
  lesson: {
    kind: 'lesson',
    folder: KIND_FOLDERS.lesson,
    sections: [
      { field: 'situation', title: 'Situation', form: 'prose' },
      { field: 'lesson', title: 'Lesson', form: 'prose' },
      { field: 'applicability', title: 'Applicability', form: 'prose' },
      { field: 'limitations', title: 'Limitations', form: 'yaml_list' }
    ]
  },
  decision: {
    kind: 'decision',
    folder: KIND_FOLDERS.decision,
    sections: [
      { field: 'context', title: 'Context', form: 'prose' },
      { field: 'decision', title: 'Decision', form: 'prose' },
      { field: 'rationale', title: 'Rationale', form: 'prose' },
      { field: 'alternatives', title: 'Alternatives', form: 'yaml_list' },
      { field: 'consequences', title: 'Consequences', form: 'yaml_list' },
      { field: 'reconsider_when', title: 'Reconsider when', form: 'prose' }
    ]
  },
  playbook: {
    kind: 'playbook',
    folder: KIND_FOLDERS.playbook,
    sections: [
      { field: 'use_when', title: 'Use when', form: 'prose' },
      { field: 'prerequisites', title: 'Prerequisites', form: 'yaml_list' },
      { field: 'steps', title: 'Steps', form: 'yaml_list' },
      { field: 'verification', title: 'Verification', form: 'yaml_list' },
      { field: 'cautions', title: 'Cautions', form: 'yaml_list' }
    ]
  },
  fact: {
    kind: 'fact',
    folder: KIND_FOLDERS.fact,
    sections: [
      { field: 'claim', title: 'Claim', form: 'prose' },
      { field: 'applicability', title: 'Applicability', form: 'prose' },
      { field: 'valid_until', title: 'Valid until', form: 'prose' }
    ]
  },
  preference: {
    kind: 'preference',
    folder: KIND_FOLDERS.preference,
    sections: [
      { field: 'preference', title: 'Preference', form: 'prose' },
      { field: 'applicability', title: 'Applicability', form: 'prose' },
      { field: 'source_statement_ref', title: 'Source statement ref', form: 'prose' },
      { field: 'exceptions', title: 'Exceptions', form: 'yaml_list' }
    ]
  },
  session: {
    kind: 'session',
    folder: KIND_FOLDERS.session,
    sections: [
      { field: 'task', title: 'Task', form: 'prose' },
      { field: 'state', title: 'State', form: 'prose' },
      { field: 'next_actions', title: 'Next actions', form: 'yaml_list' },
      { field: 'session_id', title: 'Session id', form: 'prose' },
      { field: 'blockers', title: 'Blockers', form: 'yaml_list' },
      { field: 'branch', title: 'Branch', form: 'prose' },
      { field: 'repository_ref', title: 'Repository ref', form: 'prose' }
    ]
  },
  note: {
    kind: 'note',
    folder: KIND_FOLDERS.note,
    sections: [
      { field: 'summary', title: 'Summary', form: 'prose' },
      { field: 'body_markdown', title: 'Body', form: 'markdown' }
    ]
  }
};

export const RESERVED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'title',
  'type',
  'permalink',
  'tags',
  'created',
  'modified',
  'brain_schema_version',
  'brain_id',
  'brain_revision_id',
  'brain_title',
  'brain_scope',
  'brain_status',
  'brain_operation_id',
  'brain_parents',
  'brain_approved_by',
  'brain_approval_rationale',
  'brain_approval_payload_hash',
  'brain_replacement_id'
]);

export function normalizeSectionTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function reservedSections(kind: NoteKind): Map<string, SectionSpec> {
  const sections = new Map<string, SectionSpec>();
  for (const section of NOTE_REGISTRY[kind].sections) {
    sections.set(normalizeSectionTitle(section.title), section);
  }
  sections.set(EVIDENCE_SECTION_TITLE, { field: 'evidence', title: EVIDENCE_SECTION_TITLE, form: 'yaml_list' });
  sections.set(RELATED_SECTION_TITLE, { field: 'related_ids', title: RELATED_SECTION_TITLE, form: 'yaml_list' });
  return sections;
}

export function markdownSection(kind: NoteKind): SectionSpec | undefined {
  return NOTE_REGISTRY[kind].sections.find((section) => section.form === 'markdown');
}

export function sectionTitle(kind: NoteKind, field: string): string | undefined {
  const section = NOTE_REGISTRY[kind].sections.find((item) => item.field === field);
  if (section) return section.title;
  if (field === 'evidence') return EVIDENCE_SECTION_TITLE;
  if (field === 'related_ids') return RELATED_SECTION_TITLE;
  return undefined;
}

export const V1_EVIDENCE_SECTION_TITLE = EVIDENCE_SECTION_TITLE;
export const V1_RELATED_SECTION_TITLE = RELATED_SECTION_TITLE;
export const V1_NOTE_REGISTRY = NOTE_REGISTRY;
