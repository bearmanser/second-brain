import { z } from 'zod';

export const LAYA_PROTOCOL_VERSION = 1;
export const LAYA_MAX_LINE_BYTES = 256 * 1024;
export const LAYA_MAX_BATCH_ITEMS = 8;
export const LAYA_MAX_WAITING_BATCHES = 4;
export const LAYA_MAX_CANDIDATES = 30;
export const LAYA_DEADLINE_MS = 4000;
export const LAYA_MAX_RESTARTS = 3;
export const LAYA_RESTART_WINDOW_MS = 5 * 60 * 1000;
export const LAYA_MAX_QUERY_CHARS = 8000;
export const LAYA_MAX_TITLE_CHARS = 1024;
export const LAYA_MAX_HEADING_CHARS = 1024;
export const LAYA_MAX_EXCERPT_CHARS = 8000;
export const LAYA_MAX_CHUNK_KEY_CHARS = 512;
export const LAYA_MAX_INPUT_TOKENS = 65536;
export const LAYA_PROBABILITY_TOLERANCE = 0.002;
const EXACT_SUM_TOLERANCE = 1e-12;

export const LAYA_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const LAYA_WORKER_ERROR_CODES = [
  'invalid_json',
  'line_too_long',
  'invalid_request',
  'unsupported_version',
  'input_too_long',
  'inference_failed'
] as const;
export type LayaWorkerErrorCode = (typeof LAYA_WORKER_ERROR_CODES)[number];

export type LayaProtocolErrorCode =
  | 'invalid_json'
  | 'line_too_long'
  | 'invalid_message'
  | 'invalid_probabilities'
  | 'score_mismatch';

export class LayaProtocolError extends Error {
  readonly code: LayaProtocolErrorCode;

  constructor(code: LayaProtocolErrorCode) {
    super(`laya protocol violation: ${code}`);
    this.name = 'LayaProtocolError';
    this.code = code;
  }
}

export interface LayaProbabilities {
  A: number;
  B: number;
  C: number;
}

export interface LayaScore {
  chunk_key: string;
  probabilities: LayaProbabilities;
  input_tokens: number;
  truncated: boolean;
}

export interface LayaCandidate {
  chunk_key: string;
  title: string;
  heading?: string | null;
  excerpt: string;
}

export interface LayaWireItem {
  chunk_key: string;
  title: string;
  heading: string | null;
  excerpt: string;
}

export interface LayaScoreInput {
  request_id: string;
  query: string;
  candidates: readonly LayaCandidate[];
  signal?: AbortSignal;
}

export interface LayaScoreResult {
  scores: LayaScore[];
  model_fingerprint: string;
  question_version: string;
}

export interface LayaRuntimeIdentifiers {
  laya: string;
  python?: string;
  torch?: string;
  transformers?: string;
  device: string;
  threads?: number;
  max_len?: number;
  head_max_len?: number;
}

const nonBlank = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => value.trim().length > 0, { message: 'value must not be blank' });

export const layaCandidateSchema = z.strictObject({
  chunk_key: nonBlank(LAYA_MAX_CHUNK_KEY_CHARS),
  title: z.string().max(LAYA_MAX_TITLE_CHARS),
  heading: z.string().max(LAYA_MAX_HEADING_CHARS).nullable().optional(),
  excerpt: z.string().max(LAYA_MAX_EXCERPT_CHARS)
});

export const layaScoreInputSchema = z
  .strictObject({
    request_id: z.string().regex(LAYA_ID_PATTERN),
    query: nonBlank(LAYA_MAX_QUERY_CHARS),
    candidates: z.array(layaCandidateSchema).max(LAYA_MAX_CANDIDATES),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional()
  })
  .superRefine((input, ctx) => {
    const keys = new Set<string>();
    for (const candidate of input.candidates) {
      if (keys.has(candidate.chunk_key)) ctx.addIssue({ code: 'custom', message: 'duplicate chunk_key' });
      keys.add(candidate.chunk_key);
    }
  });

const probabilityValue = z.number();

const scoreSchema = z.strictObject({
  chunk_key: z.string().min(1).max(LAYA_MAX_CHUNK_KEY_CHARS),
  probabilities: z.strictObject({ A: probabilityValue, B: probabilityValue, C: probabilityValue }),
  input_tokens: z.int().min(1).max(LAYA_MAX_INPUT_TOKENS),
  truncated: z.boolean()
});

const runtimeSchema = z.strictObject({
  laya: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  python: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  torch: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  transformers: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  device: z.string().regex(/^[a-z]{1,16}(:[0-9]{1,3})?$/),
  threads: z.int().min(1).max(1024).optional(),
  max_len: z.int().min(1).max(LAYA_MAX_INPUT_TOKENS).optional(),
  head_max_len: z.int().min(1).max(LAYA_MAX_INPUT_TOKENS).optional()
});

const readySchema = z.strictObject({
  v: z.literal(LAYA_PROTOCOL_VERSION),
  type: z.literal('ready'),
  model_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  question_version: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  runtime: runtimeSchema
});

const resultSchema = z.strictObject({
  v: z.literal(LAYA_PROTOCOL_VERSION),
  type: z.literal('result'),
  id: z.string().regex(LAYA_ID_PATTERN),
  scores: z.array(z.unknown()).max(LAYA_MAX_BATCH_ITEMS)
});

const errorSchema = z.strictObject({
  v: z.literal(LAYA_PROTOCOL_VERSION),
  type: z.literal('error'),
  id: z.string().regex(LAYA_ID_PATTERN).nullable(),
  code: z.enum(LAYA_WORKER_ERROR_CODES)
});

const messageSchema = z.discriminatedUnion('type', [readySchema, resultSchema, errorSchema]);

export type LayaWorkerMessage = z.infer<typeof messageSchema>;

const diagnosticSchema = z.strictObject({
  v: z.literal(LAYA_PROTOCOL_VERSION),
  type: z.literal('diagnostic'),
  event: z.string().regex(/^[a-z][a-z_]{0,63}$/),
  error_class: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .optional()
});

export type LayaDiagnosticMessage = z.infer<typeof diagnosticSchema>;

const isNumber = (value: unknown): value is number => typeof value === 'number';

export function normalizeProbabilities(value: unknown): LayaProbabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LayaProtocolError('invalid_probabilities');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'A' || keys[1] !== 'B' || keys[2] !== 'C') {
    throw new LayaProtocolError('invalid_probabilities');
  }
  const values = [record.A, record.B, record.C];
  if (!values.every(isNumber)) throw new LayaProtocolError('invalid_probabilities');
  const [a, b, c] = values as number[];
  for (const item of [a, b, c]) {
    if (!Number.isFinite(item) || item < 0 || item > 1) throw new LayaProtocolError('invalid_probabilities');
  }
  const total = a + b + c;
  if (total <= 0 || Math.abs(total - 1) > LAYA_PROBABILITY_TOLERANCE) {
    throw new LayaProtocolError('invalid_probabilities');
  }
  if (Math.abs(total - 1) <= EXACT_SUM_TOLERANCE) return { A: a, B: b, C: c };
  return { A: a / total, B: b / total, C: c / total };
}

export function encodeScoreBatch(id: string, query: string, items: readonly LayaWireItem[]): string {
  if (!LAYA_ID_PATTERN.test(id) || items.length === 0 || items.length > LAYA_MAX_BATCH_ITEMS) {
    throw new LayaProtocolError('invalid_message');
  }
  const line = `${JSON.stringify({
    v: LAYA_PROTOCOL_VERSION,
    id,
    action: 'score',
    payload: {
      query,
      items: items.map((item) => ({
        chunk_key: item.chunk_key,
        title: item.title,
        heading: item.heading,
        excerpt: item.excerpt
      }))
    }
  })}\n`;
  if (Buffer.byteLength(line, 'utf8') > LAYA_MAX_LINE_BYTES) throw new LayaProtocolError('line_too_long');
  return line;
}

const parseLine = (line: string): unknown => {
  if (Buffer.byteLength(line, 'utf8') > LAYA_MAX_LINE_BYTES) throw new LayaProtocolError('line_too_long');
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new LayaProtocolError('invalid_json');
  }
};

export function parseWorkerMessage(line: string): LayaWorkerMessage {
  const parsed = messageSchema.safeParse(parseLine(line));
  if (!parsed.success) throw new LayaProtocolError('invalid_message');
  return parsed.data;
}

export function parseDiagnosticLine(line: string): LayaDiagnosticMessage | null {
  if (Buffer.byteLength(line, 'utf8') > LAYA_MAX_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  const parsed = diagnosticSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function validateBatchScores(expectedKeys: readonly string[], scores: unknown): LayaScore[] {
  if (!Array.isArray(scores) || scores.length !== expectedKeys.length) {
    throw new LayaProtocolError('score_mismatch');
  }
  const expected = new Set(expectedKeys);
  const byKey = new Map<string, LayaScore>();
  for (const value of scores) {
    const parsed = scoreSchema.safeParse(value);
    if (!parsed.success) throw new LayaProtocolError('score_mismatch');
    const score = parsed.data;
    if (!expected.has(score.chunk_key) || byKey.has(score.chunk_key)) {
      throw new LayaProtocolError('score_mismatch');
    }
    byKey.set(score.chunk_key, {
      chunk_key: score.chunk_key,
      probabilities: normalizeProbabilities(score.probabilities),
      input_tokens: score.input_tokens,
      truncated: score.truncated
    });
  }
  return expectedKeys.map((key) => {
    const score = byKey.get(key);
    if (score === undefined) throw new LayaProtocolError('score_mismatch');
    return score;
  });
}
