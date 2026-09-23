import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_SHA256_PATTERN } from '../config/schema.js';

const SINGLE_BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

const tokenDigest = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

export function verifyBearer(header: string | undefined, expectedDigest: string): boolean {
  if (!TOKEN_SHA256_PATTERN.test(expectedDigest)) return false;
  const match = SINGLE_BEARER_PATTERN.exec(header ?? '');
  if (match === null) return false;
  const actual = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(expectedDigest, 'hex'));
}

export function generateBearerToken(): { token: string; token_sha256: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, token_sha256: tokenDigest(token).toString('hex') };
}
