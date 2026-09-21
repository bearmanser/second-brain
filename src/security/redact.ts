import { BrainError } from '../contracts/errors.js';

export const REDACTED = '[REDACTED]';
export const REDACTED_BEARER = `Bearer ${REDACTED}`;
export const REDACTED_PRIVATE_KEY = '[REDACTED PRIVATE KEY]';
export const REDACTED_CYCLE = '[REDACTED CYCLE]';
export const REDACTED_DEPTH = '[REDACTED DEPTH]';
export const REDACTION_CAVEAT =
  'Redaction is best-effort: it removes known credential patterns but cannot guarantee that no sensitive data remains.';

export const CREDENTIAL_KEY_PATTERN =
  /(authorization|authorisation|proxy-authorization|password|passwd|passphrase|secret|token|api[-_]?key|x-api-key|credential|cookie|set-cookie|private[-_]?key|client[-_]?secret|access[-_]?key|session[-_]?key)/i;

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_PATTERN = /\bBearer[ ]+[A-Za-z0-9\-._~+/]+=*/gi;
const ASSIGNMENT_PATTERN =
  /\b(password|passwd|passphrase|secret|token|api[-_]?key|x-api-key|client[-_]?secret|access[-_]?key|refresh[-_]?token)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&#"']+)/gi;
const RECOGNIZABLE_SECRET_PATTERN =
  /\b(sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,})\b/;
const RECOGNIZABLE_SECRET_REDACTION_PATTERN =
  /\b(sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,})\b/g;

const MAX_DEPTH = 8;

export const CREDENTIAL_KINDS = [
  'private_key',
  'bearer_token',
  'credential_assignment',
  'recognizable_secret'
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function detectCredentials(value: string): CredentialKind[] {
  const kinds: CredentialKind[] = [];
  if (value.match(PRIVATE_KEY_PATTERN)) kinds.push('private_key');
  if (value.match(BEARER_PATTERN)) kinds.push('bearer_token');
  if (value.match(ASSIGNMENT_PATTERN)) kinds.push('credential_assignment');
  if (RECOGNIZABLE_SECRET_PATTERN.test(value)) kinds.push('recognizable_secret');
  return kinds;
}

export function containsCredentials(value: string): boolean {
  return detectCredentials(value).length > 0;
}

export function assertNoCredentials(value: string, field = 'value'): void {
  const kinds = detectCredentials(value);
  if (kinds.length > 0) {
    throw new BrainError({
      code: 'INVALID_INPUT',
      message: `${field} rejected because it contains an obvious credential (${kinds.join(', ')})`
    });
  }
}

export function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED_PRIVATE_KEY)
    .replace(BEARER_PATTERN, REDACTED_BEARER)
    .replace(ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(RECOGNIZABLE_SECRET_REDACTION_PATTERN, REDACTED);
}

export interface RedactedError {
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  operation_id?: string;
}

export function redactError(error: unknown): RedactedError {
  if (error instanceof BrainError) {
    const redacted: RedactedError = {
      name: error.name,
      code: error.code,
      retryable: error.retryable,
      message: redactString(error.message)
    };
    if (error.operation_id !== undefined) redacted.operation_id = error.operation_id;
    return redacted;
  }
  if (error instanceof Error) {
    return { name: error.name, message: redactString(error.message) };
  }
  return { name: 'Error', message: redactString(String(error)) };
}

export function redactValue(value: unknown, depth = 0, stack = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return REDACTED_DEPTH;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value);
  if (stack.has(value)) return REDACTED_CYCLE;
  stack.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactValue(item, depth + 1, stack));
  } else {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = CREDENTIAL_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, depth + 1, stack);
    }
    result = record;
  }
  stack.delete(value);
  return result;
}
