import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BrainError } from '../contracts/errors.js';
import { TOKEN_SHA256_PATTERN } from '../config/schema.js';

export interface LegacyCredentialEntry {
  token_sha256: string;
}

const legacyPrincipalSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1).optional(),
    read_scopes: z.array(z.string()).optional(),
    write_scopes: z.array(z.string()).optional(),
    review_scopes: z.array(z.string()).optional()
  })
  .loose();

const legacyCredentialsFileSchema = z
  .object({
    credentials: z
      .array(
        z
          .object({
            token_sha256: z.string().regex(TOKEN_SHA256_PATTERN),
            principal: legacyPrincipalSchema
          })
          .loose()
      )
      .min(1)
      .superRefine((records, ctx) => {
        const digests = new Set<string>();
        for (const record of records) {
          if (digests.has(record.token_sha256)) {
            ctx.addIssue({ code: 'custom', message: 'duplicate legacy credential digest' });
          }
          digests.add(record.token_sha256);
        }
      })
  })
  .loose();

function invalid(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function readLegacyCredentialFile(path: string): LegacyCredentialEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw invalid('the legacy credentials file cannot be read', cause);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw invalid('the legacy credentials file is not valid JSON', cause);
  }
  const parsed = legacyCredentialsFileSchema.safeParse(document);
  if (!parsed.success) {
    throw invalid('the legacy credentials file is invalid');
  }
  return parsed.data.credentials.map((record) => ({ token_sha256: record.token_sha256 }));
}

export function listLegacyCredentialDigests(path: string): LegacyCredentialEntry[] {
  return readLegacyCredentialFile(path);
}

export function selectLegacyCredentialDigest(path: string, selection: number): string {
  if (!Number.isInteger(selection) || selection < 1) {
    throw invalid('the legacy credential selection must be a positive one-based integer');
  }
  const entries = readLegacyCredentialFile(path);
  if (selection > entries.length) {
    throw invalid(`the legacy credential selection must be between 1 and ${entries.length}`);
  }
  return entries[selection - 1].token_sha256;
}
