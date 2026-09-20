import { createHmac, timingSafeEqual } from 'node:crypto';
import { BrainError } from '../contracts/errors.js';
import { CURSOR_TTL_MS } from '../core/limits.js';
import type { RequestContext } from '../core/types.js';

export interface CursorPayload {
  principal_id: string;
  scope: string;
  id: string;
  revision_id: string;
  raw_hash: string;
  offset: number;
  expires_at: string;
}

export const CURSOR_FIELDS = [
  'principal_id',
  'scope',
  'id',
  'revision_id',
  'raw_hash',
  'offset',
  'expires_at'
] as const;

type CursorField = (typeof CURSOR_FIELDS)[number];

const STRING_FIELDS: readonly CursorField[] = [
  'principal_id',
  'scope',
  'id',
  'revision_id',
  'raw_hash',
  'expires_at'
];

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MIN_SECRET_BYTES = 32;

function invalid(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function requireSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.length < MIN_SECRET_BYTES) {
    throw invalid(`read cursor signing secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

function isUtcInstant(value: string): boolean {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const [datePart, timePart] = value.slice(0, -1).split('T');
  const [clock, fraction = ''] = timePart.split('.');
  const normalized = `${datePart}T${clock}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
  return normalized === new Date(parsed).toISOString();
}

function canonicalBody(payload: CursorPayload): Buffer {
  const ordered: Record<string, unknown> = {};
  for (const field of CURSOR_FIELDS) {
    ordered[field] = payload[field];
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function encodeBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw invalid('read cursor is not a valid base64url token');
  }
  return Buffer.from(value, 'base64url');
}

function signatureOf(body: Buffer, secret: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function parsePayload(value: unknown): CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('read cursor body is not an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_FIELDS.length ||
    !CURSOR_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  ) {
    throw invalid('read cursor body has unexpected fields');
  }
  const strings: Record<string, string> = {};
  for (const field of STRING_FIELDS) {
    const entry = record[field];
    if (typeof entry !== 'string' || entry.length === 0) {
      throw invalid(`read cursor ${field} is invalid`);
    }
    strings[field] = entry;
  }
  if (!isUtcInstant(strings.expires_at)) {
    throw invalid('read cursor expires_at must be a valid UTC RFC3339 instant');
  }
  const offset = record.offset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw invalid('read cursor offset is invalid');
  }
  return {
    principal_id: strings.principal_id,
    scope: strings.scope,
    id: strings.id,
    revision_id: strings.revision_id,
    raw_hash: strings.raw_hash,
    offset,
    expires_at: strings.expires_at
  };
}

export function signCursor(payload: CursorPayload, secret: Uint8Array): string {
  requireSecret(secret);
  const body = canonicalBody(payload);
  const signature = signatureOf(body, secret);
  return `${encodeBase64Url(body)}.${encodeBase64Url(signature)}`;
}

export function verifyCursor(
  cursor: string,
  secret: Uint8Array,
  ctx: RequestContext,
  now: Date
): CursorPayload {
  requireSecret(secret);
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw invalid('read cursor is missing');
  }
  const parts = cursor.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw invalid('read cursor is not a signed token');
  }
  const body = decodeBase64Url(parts[0]);
  const provided = decodeBase64Url(parts[1]);
  const expected = signatureOf(body, secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw invalid('read cursor signature is invalid');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString('utf8'));
  } catch {
    throw invalid('read cursor body is not valid JSON');
  }
  const payload = parsePayload(decoded);
  if (payload.principal_id !== ctx.principal.id) {
    throw invalid('read cursor belongs to another principal');
  }
  const expiry = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiry)) {
    throw invalid('read cursor expiry is invalid');
  }
  const reference = now.getTime();
  if (reference > expiry) {
    throw invalid('read cursor has expired');
  }
  if (expiry - reference > CURSOR_TTL_MS) {
    throw invalid('read cursor expiry is out of range');
  }
  return payload;
}
