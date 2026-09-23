import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BrainError } from '../contracts/errors.js';
import type { Principal } from '../core/types.js';
import { TOKEN_SHA256_PATTERN } from '../config/schema.js';
import type { CredentialRecord } from '../config/schema.js';

const BEARER_PATTERN = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)$/i;
const SINGLE_BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

const unauthenticated = (message: string): BrainError =>
  new BrainError({ code: 'UNAUTHENTICATED', message });

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

export function authenticate(header: string | undefined, credentials: CredentialRecord[]): Principal {
  if (typeof header !== 'string') {
    throw unauthenticated('a bearer credential is required');
  }
  const match = BEARER_PATTERN.exec(header);
  if (!match) {
    throw unauthenticated('authorization header is malformed');
  }
  const presented = tokenDigest(match[1]);
  const digests = new Set<string>();
  let matched: Principal | undefined;
  for (const record of credentials) {
    if (digests.has(record.token_sha256)) {
      throw unauthenticated('credential store contains duplicate digests');
    }
    digests.add(record.token_sha256);
    if (!TOKEN_SHA256_PATTERN.test(record.token_sha256)) continue;
    const expected = Buffer.from(record.token_sha256, 'hex');
    if (expected.length !== presented.length) continue;
    if (timingSafeEqual(expected, presented)) {
      matched = record.principal;
    }
  }
  if (!matched) {
    throw unauthenticated('bearer credential is not recognized');
  }
  return {
    id: matched.id,
    role: matched.role,
    read_scopes: [...matched.read_scopes],
    write_scopes: [...matched.write_scopes],
    review_scopes: [...matched.review_scopes]
  };
}
