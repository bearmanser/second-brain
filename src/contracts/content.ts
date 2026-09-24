import { z } from 'zod';
import {
  EVIDENCE_MAX_ITEMS,
  ETAG_PATTERN,
  INPUT_BODY_MAX_BYTES,
  RELATED_IDS_MAX_ITEMS,
  SCOPE_ID_PATTERN,
  TAGS_MAX_ITEMS,
  TITLE_MAX_CODE_POINTS
} from '../core/limits.js';
import { EVIDENCE_KINDS, NOTE_KINDS } from '../core/types.js';
import { isProjectIdentifier } from '../projects/registry.js';

const text = z.string().trim().min(1).max(8000);
const texts = z.array(text).max(32);

export const notePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => {
      if (value.trim() !== value) return false;
      if (value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false;
      if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
      const segments = value.split('/');
      if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        return false;
      }
      if (segments.some((segment) => segment.startsWith('.'))) return false;
      return segments[segments.length - 1].endsWith('.md');
    },
    { message: 'note path must be a safe vault-relative Markdown path' }
  );

export const uuidSchema = z.uuid();

export const scopeIdSchema = z.string().regex(SCOPE_ID_PATTERN, {
  message: 'scope id must match ^[a-z][a-z0-9-]{0,63}$'
});

export const projectIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => isProjectIdentifier(value), {
    message: 'project identifier is malformed'
  });

export const etagSchema = z.string().regex(ETAG_PATTERN, {
  message: 'etag must be a lowercase hexadecimal sha256 digest'
});

export const cursorSchema = z.string().min(1);

export const remoteUrlSchema = z.string().min(1).max(2048);

export const titleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= TITLE_MAX_CODE_POINTS, {
    message: `title must be at most ${TITLE_MAX_CODE_POINTS} Unicode code points`
  });

export const withinInputBodyLimit = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= INPUT_BODY_MAX_BYTES;

export const HUMAN_ORGANIZATION_TYPES = [
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

export type HumanOrganizationType = (typeof HUMAN_ORGANIZATION_TYPES)[number];

export const DOCUMENT_TYPES = [...NOTE_KINDS, ...HUMAN_ORGANIZATION_TYPES] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

export const STRUCTURED_CONTENT_KINDS = NOTE_KINDS;

export const noteContentSchemaV1 = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('lesson'),
    situation: text,
    lesson: text,
    applicability: text,
    limitations: texts.optional()
  }),
  z.strictObject({
    kind: z.literal('decision'),
    context: text,
    decision: text,
    rationale: text,
    alternatives: texts.optional(),
    consequences: texts.optional(),
    reconsider_when: text.optional()
  }),
  z.strictObject({
    kind: z.literal('playbook'),
    use_when: text,
    prerequisites: texts,
    steps: texts.min(1),
    verification: texts.min(1),
    cautions: texts.optional()
  }),
  z.strictObject({
    kind: z.literal('fact'),
    claim: text,
    applicability: text,
    valid_until: z.iso.datetime().optional()
  }),
  z.strictObject({
    kind: z.literal('preference'),
    preference: text,
    applicability: text,
    source_statement_ref: text,
    exceptions: texts.optional()
  }),
  z.strictObject({
    kind: z.literal('session'),
    task: text,
    state: text,
    next_actions: texts,
    session_id: text,
    blockers: texts.optional(),
    branch: text.optional(),
    repository_ref: text.optional()
  }),
  z.strictObject({
    kind: z.literal('note'),
    summary: text,
    body_markdown: z.string().min(1).max(32000)
  })
]);

export const evidenceSchemaV1 = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  ref: text,
  description: text,
  observed_at: z.iso.datetime().optional()
});

const noteInputBaseV1 = z.strictObject({
  title: titleSchema,
  tags: z.array(text).max(TAGS_MAX_ITEMS),
  content: noteContentSchemaV1,
  evidence: z.array(evidenceSchemaV1).max(EVIDENCE_MAX_ITEMS),
  related_ids: z.array(uuidSchema).max(RELATED_IDS_MAX_ITEMS)
});

export const noteInputSchemaV1 = noteInputBaseV1.refine(withinInputBodyLimit, {
  message: 'note input exceeds the 256 KiB input body limit'
});

export const noteContentSchemaV2 = noteContentSchemaV1;

export const evidenceSchema = evidenceSchemaV1;

export const noteInputSchemaV2 = noteInputBaseV1
  .extend({
    type: documentTypeSchema.optional(),
    source: text.optional()
  })
  .refine(
    (value) => {
      if (value.type === undefined) return true;
      if ((NOTE_KINDS as readonly string[]).includes(value.type)) {
        return value.content.kind === value.type;
      }
      return value.content.kind === 'note';
    },
    {
      message:
        'a human organization type requires flexible note content; a structured kind must match content.kind'
    }
  )
  .refine(withinInputBodyLimit, {
    message: 'note input exceeds the 256 KiB input body limit'
  });

export const noteContentSchema = noteContentSchemaV1;

export const noteInputSchema = noteInputSchemaV1;

export const noteReferenceSchema = z.union([
  z.strictObject({ id: uuidSchema }),
  z.strictObject({ path: notePathSchema }),
  z.strictObject({ title: titleSchema })
]);

export type NoteReferenceInput = z.infer<typeof noteReferenceSchema>;

export type NoteContent = z.infer<typeof noteContentSchemaV1>;
export type NoteInputV1 = z.infer<typeof noteInputSchemaV1>;
export type NoteInputV2 = z.infer<typeof noteInputSchemaV2>;
