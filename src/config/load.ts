import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { BrainError } from '../contracts/errors.js';
import { brainConfigSchema, credentialsFileSchema, tokenDigestSchema } from './schema.js';
import type { BrainConfig, CredentialRecord } from './schema.js';

export const BRAIN_TOKEN_ENV = 'BRAIN_TOKEN_SHA256';

const invalidConfig = (message: string, cause?: unknown): BrainError =>
  new BrainError({ code: 'INVALID_INPUT', message, cause });

const readText = (path: string, label: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw invalidConfig(`${label} cannot be read`, error);
  }
};

export function loadConfig(path: string): BrainConfig {
  const text = readText(path, 'configuration file');
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw invalidConfig('configuration file is not valid YAML', error);
  }
  const parsed = brainConfigSchema.safeParse(document);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .filter((field) => field.length > 0)
      )
    ];
    const detail = fields.length > 0 ? ` (${fields.join(', ')})` : '';
    throw invalidConfig(`configuration is invalid${detail}`);
  }
  return parsed.data;
}

export function loadCredentials(path: string): CredentialRecord[] {
  const text = readText(path, 'credentials file');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw invalidConfig('credentials file is not valid JSON', error);
  }
  const parsed = credentialsFileSchema.safeParse(document);
  if (!parsed.success) {
    throw invalidConfig('credentials file is invalid');
  }
  return parsed.data.credentials;
}

export function assertTokenDigest(value: unknown): string {
  const parsed = tokenDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidConfig(`${BRAIN_TOKEN_ENV} must be a lowercase sha256 hex digest`);
  }
  return parsed.data;
}

export function loadTokenDigest(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[BRAIN_TOKEN_ENV];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidConfig(`${BRAIN_TOKEN_ENV} is required`);
  }
  return assertTokenDigest(value);
}
