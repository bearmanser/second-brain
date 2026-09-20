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
import { EVIDENCE_KINDS } from '../core/types.js';

const text = z.string().trim().min(1).max(8000);
const texts = z.array(text).max(32);

export const noteContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lesson'), situation: text, lesson: text,
    applicability: text, limitations: texts.optional() }),
  z.strictObject({ kind: z.literal('decision'), context: text, decision: text,
    rationale: text, alternatives: texts.optional(), consequences: texts.optional(),
    reconsider_when: text.optional() }),
  z.strictObject({ kind: z.literal('playbook'), use_when: text, prerequisites: texts,
    steps: texts.min(1), verification: texts.min(1), cautions: texts.optional() }),
  z.strictObject({ kind: z.literal('fact'), claim: text, applicability: text,
    valid_until: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ kind: z.literal('preference'), preference: text,
    applicability: text, source_statement_ref: text, exceptions: texts.optional() }),
  z.strictObject({ kind: z.literal('session'), task: text, state: text,
    next_actions: texts, session_id: text, blockers: texts.optional(),
    branch: text.optional(), repository_ref: text.optional() }),
  z.strictObject({ kind: z.literal('note'), summary: text,
    body_markdown: z.string().min(1).max(32000) })
]);

export type NoteContent = z.infer<typeof noteContentSchema>;

export const uuidSchema = z.uuid();

export const scopeIdSchema = z.string().regex(SCOPE_ID_PATTERN, {
  message: 'scope id must match ^[a-z][a-z0-9-]{0,63}$'
});

export const etagSchema = z.string().regex(ETAG_PATTERN, {
  message: 'etag must be a lowercase hexadecimal sha256 digest'
});

export const cursorSchema = z.string().min(1);

export const titleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= TITLE_MAX_CODE_POINTS, {
    message: `title must be at most ${TITLE_MAX_CODE_POINTS} Unicode code points`
  });

export const evidenceSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  ref: text,
  description: text,
  observed_at: z.iso.datetime({ offset: true }).optional()
});

export const withinInputBodyLimit = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= INPUT_BODY_MAX_BYTES;

export const noteInputSchema = z
  .strictObject({
    title: titleSchema,
    tags: z.array(text).max(TAGS_MAX_ITEMS),
    content: noteContentSchema,
    evidence: z.array(evidenceSchema).max(EVIDENCE_MAX_ITEMS),
    related_ids: z.array(uuidSchema).max(RELATED_IDS_MAX_ITEMS)
  })
  .refine(withinInputBodyLimit, {
    message: 'note input exceeds the 256 KiB input body limit'
  });
