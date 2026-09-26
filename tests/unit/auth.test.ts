import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { generateBearerToken, verifyBearer } from '../../src/auth.js';

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

test('verifies matching bearer tokens', () => {
  const token = 'abc-123';
  expect(verifyBearer(`Bearer ${token}`, digest(token))).toBe(true);
  expect(verifyBearer(`bearer ${token}`, digest(token))).toBe(true);
  expect(verifyBearer('Bearer wrong', digest(token))).toBe(false);
  expect(verifyBearer(undefined, digest(token))).toBe(false);
  expect(verifyBearer('Basic abc', digest(token))).toBe(false);
  expect(verifyBearer(`Bearer ${token}`, 'not-a-digest')).toBe(false);
});

test('generates a token and its digest', () => {
  const { token, token_sha256 } = generateBearerToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(token_sha256).toBe(digest(token));
  expect(generateBearerToken().token).not.toBe(token);
});
