import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGEST = /^[a-f0-9]{64}$/;
const SINGLE_BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifyBearer(header: string | undefined, expectedDigest: string): boolean {
  if (!DIGEST.test(expectedDigest)) return false;
  const match = SINGLE_BEARER.exec(header ?? '');
  if (match === null) return false;
  const actual = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(expectedDigest, 'hex'));
}

export function generateBearerToken(): { token: string; token_sha256: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, token_sha256: sha256Hex(token) };
}
