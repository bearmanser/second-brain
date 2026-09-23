import { createHmac, timingSafeEqual } from 'node:crypto';
import { BrainError } from '../contracts/errors.js';
import { CURSOR_TTL_MS, SCOPE_ID_PATTERN } from '../core/limits.js';

export interface CursorPayloadV2 {
  version: 2;
  scope: string;
  id: string;
  revision_id: string;
  raw_hash: string;
  offset: number;
  expires_at: string;
}

export interface CursorPayloadV1 {
  principal_id: string;
  scope: string;
  id: string;
  revision_id: string;
  raw_hash: string;
  offset: number;
  expires_at: string;
}

export const CURSOR_FIELDS_V2 = [
  'version',
  'scope',
  'id',
  'revision_id',
  'raw_hash',
  'offset',
  'expires_at'
] as const;

export const CURSOR_FIELDS_V1 = [
  'principal_id',
  'scope',
  'id',
  'revision_id',
  'raw_hash',
  'offset',
  'expires_at'
] as const;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MIN_SECRET_BYTES = 32;
const STORED_CURSOR_SIGNATURE_BYTES = 16;

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

function canonicalBodyV2(payload: CursorPayloadV2): Buffer {
  const ordered: Record<string, unknown> = {};
  for (const field of CURSOR_FIELDS_V2) ordered[field] = payload[field];
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function canonicalBodyV1(payload: CursorPayloadV1): Buffer {
  const ordered: Record<string, unknown> = {};
  for (const field of CURSOR_FIELDS_V1) ordered[field] = payload[field];
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

export interface CursorStore {
  storeReadCursor(payload_json: string, expires_at: string): number;
  updateReadCursor(cursor_id: number, payload_json: string, expires_at: string): void;
  deleteReadCursor(cursor_id: number): void;
  getReadCursor(cursor_id: number): string | undefined;
}

export interface StoredCursorReservation {
  cursor_id: number;
  token: string;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`read cursor ${field} is invalid`);
  }
  return value;
}

function requireOffset(record: Record<string, unknown>): number {
  const offset = record.offset;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw invalid('read cursor offset is invalid');
  }
  return offset;
}

function requireExpiry(value: string): string {
  if (!isUtcInstant(value)) {
    throw invalid('read cursor expires_at must be a valid UTC RFC3339 instant');
  }
  return value;
}

function parseV2(value: unknown): CursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('read cursor body is not an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_FIELDS_V2.length ||
    !CURSOR_FIELDS_V2.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  ) {
    throw invalid('read cursor body has unexpected fields');
  }
  if (record.version !== 2) throw invalid('read cursor version is invalid');
  const scope = requireString(record, 'scope');
  if (!SCOPE_ID_PATTERN.test(scope)) throw invalid('read cursor scope is invalid');
  const rawHash = requireString(record, 'raw_hash');
  if (!HASH_PATTERN.test(rawHash)) throw invalid('read cursor raw_hash is invalid');
  return {
    version: 2,
    scope,
    id: requireString(record, 'id'),
    revision_id: requireString(record, 'revision_id'),
    raw_hash: rawHash,
    offset: requireOffset(record),
    expires_at: requireExpiry(requireString(record, 'expires_at'))
  };
}

function parseV1(value: unknown): CursorPayloadV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('read cursor body is not an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_FIELDS_V1.length ||
    !CURSOR_FIELDS_V1.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  ) {
    throw invalid('read cursor body has unexpected fields');
  }
  const rawHash = requireString(record, 'raw_hash');
  if (!HASH_PATTERN.test(rawHash)) throw invalid('read cursor raw_hash is invalid');
  return {
    principal_id: requireString(record, 'principal_id'),
    scope: requireString(record, 'scope'),
    id: requireString(record, 'id'),
    revision_id: requireString(record, 'revision_id'),
    raw_hash: rawHash,
    offset: requireOffset(record),
    expires_at: requireExpiry(requireString(record, 'expires_at'))
  };
}

function checkExpiry(expiresAt: string, now: Date): void {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw invalid('read cursor expiry is invalid');
  const reference = now.getTime();
  if (reference > expiry) throw invalid('read cursor has expired');
  if (expiry - reference > CURSOR_TTL_MS) throw invalid('read cursor expiry is out of range');
}

export function signCursorV2(payload: CursorPayloadV2, secret: Uint8Array): string {
  requireSecret(secret);
  const body = canonicalBodyV2(payload);
  const signature = signatureOf(body, secret);
  return `v2.${encodeBase64Url(body)}.${encodeBase64Url(signature)}`;
}

export function reserveStoredCursorV2(
  payload: CursorPayloadV2,
  secret: Uint8Array,
  store: CursorStore
): StoredCursorReservation {
  requireSecret(secret);
  const body = canonicalBodyV2(payload);
  const cursorId = store.storeReadCursor(body.toString('utf8'), payload.expires_at);
  if (!Number.isSafeInteger(cursorId) || cursorId <= 0) {
    throw invalid('read cursor store returned an invalid id');
  }
  const id = cursorId.toString(36);
  const signature = signatureOf(Buffer.from(`r2.${id}`, 'utf8'), secret).subarray(
    0,
    STORED_CURSOR_SIGNATURE_BYTES
  );
  return { cursor_id: cursorId, token: `r2.${id}.${encodeBase64Url(signature)}` };
}

export function finalizeStoredCursorV2(
  reservation: StoredCursorReservation,
  payload: CursorPayloadV2,
  store: CursorStore
): string {
  const body = canonicalBodyV2(payload);
  store.updateReadCursor(reservation.cursor_id, body.toString('utf8'), payload.expires_at);
  return reservation.token;
}

export function verifyStoredCursorV2(
  cursor: string,
  secret: Uint8Array,
  now: Date,
  store: CursorStore
): CursorPayloadV2 {
  const { id } = verifyStoredToken(cursor, 'r2', secret);
  return verifyStoredBodyV2(id, now, store);
}

export function verifyStoredCursorV1(
  cursor: string,
  secret: Uint8Array,
  now: Date,
  store: CursorStore
): CursorPayloadV1 {
  const { id } = verifyStoredToken(cursor, 'r1', secret);
  const stored = store.getReadCursor(id);
  if (stored === undefined) throw invalid('read cursor is unavailable');
  const payload = parseV1(JSON.parse(stored));
  checkExpiry(payload.expires_at, now);
  return payload;
}

function verifyStoredToken(
  cursor: string,
  prefix: string,
  secret: Uint8Array
): { id: number } {
  requireSecret(secret);
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== prefix || !/^[0-9a-z]+$/u.test(parts[1])) {
    throw invalid(`read cursor is not a ${prefix} stored token`);
  }
  const provided = decodeBase64Url(parts[2]);
  const expected = signatureOf(Buffer.from(`${prefix}.${parts[1]}`, 'utf8'), secret).subarray(
    0,
    STORED_CURSOR_SIGNATURE_BYTES
  );
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw invalid('read cursor signature is invalid');
  }
  const id = Number.parseInt(parts[1], 36);
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('read cursor id is invalid');
  return { id };
}

function verifyStoredBodyV2(id: number, now: Date, store: CursorStore): CursorPayloadV2 {
  const stored = store.getReadCursor(id);
  if (stored === undefined) throw invalid('read cursor is unavailable');
  const payload = parseV2(JSON.parse(stored));
  checkExpiry(payload.expires_at, now);
  return payload;
}

export function verifyCursorV2(
  cursor: string,
  secret: Uint8Array,
  now: Date
): CursorPayloadV2 {
  requireSecret(secret);
  if (typeof cursor !== 'string' || !cursor.startsWith('v2.')) {
    throw invalid('read cursor is not a v2 signed token');
  }
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2' || parts[1].length === 0 || parts[2].length === 0) {
    throw invalid('read cursor is not a signed token');
  }
  const body = decodeBase64Url(parts[1]);
  const provided = decodeBase64Url(parts[2]);
  const expected = signatureOf(body, secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw invalid('read cursor signature is invalid');
  }
  const payload = parseV2(JSON.parse(body.toString('utf8')));
  checkExpiry(payload.expires_at, now);
  return payload;
}

export function verifyLegacyCursor(
  cursor: string,
  secret: Uint8Array,
  now: Date
): CursorPayloadV1 {
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
  const payload = parseV1(JSON.parse(body.toString('utf8')));
  checkExpiry(payload.expires_at, now);
  return payload;
}

export function signLegacyCursor(payload: CursorPayloadV1, secret: Uint8Array): string {
  requireSecret(secret);
  const body = canonicalBodyV1(payload);
  const signature = signatureOf(body, secret);
  return `${encodeBase64Url(body)}.${encodeBase64Url(signature)}`;
}
