import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { BrainError } from '../contracts/errors.js';
import { posix } from 'node:path';
import {
  LAYA_DEFAULT_LOCK_FILE,
  LAYA_MODEL_SUBDIRECTORY,
  brainConfigSchema,
  layaConfigSchema,
  tokenDigestSchema
} from './schema.js';
import type { BrainConfig, LayaSettings } from './schema.js';

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

const LAYA_ENVIRONMENT = {
  BRAIN_LAYA_ENABLED: 'enabled',
  BRAIN_LAYA_PYTHON: 'python',
  BRAIN_LAYA_MODEL_DIR: 'model_dir',
  BRAIN_LAYA_LOCK_FILE: 'lock_file',
  BRAIN_LAYA_BATCH_SIZE: 'batch_size',
  BRAIN_LAYA_QUEUE_BATCHES: 'queue_batches',
  BRAIN_LAYA_TIMEOUT_MS: 'timeout_ms',
  BRAIN_LAYA_THREADS: 'threads'
} as const;

const LAYA_BOOLEAN_FIELDS = new Set(['enabled']);
const LAYA_INTEGER_FIELDS = new Set(['batch_size', 'queue_batches', 'timeout_ms', 'threads']);

const environmentValue = (name: string, field: string, value: string): unknown => {
  if (LAYA_BOOLEAN_FIELDS.has(field)) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw invalidConfig(`${name} must be true or false`);
  }
  if (LAYA_INTEGER_FIELDS.has(field)) {
    if (!/^[0-9]{1,6}$/.test(value)) throw invalidConfig(`${name} must be a positive integer`);
    return Number(value);
  }
  return value;
};

export function resolveLayaSettings(config: BrainConfig, env: NodeJS.ProcessEnv = process.env): LayaSettings {
  const merged: Record<string, unknown> = { ...(config.laya ?? {}) };
  for (const [name, field] of Object.entries(LAYA_ENVIRONMENT)) {
    const value = env[name];
    if (value !== undefined && value.length > 0) merged[field] = environmentValue(name, field, value);
  }
  const parsed = layaConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].filter((field) => field.length > 0);
    throw invalidConfig(`laya configuration is invalid${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`);
  }
  const laya = parsed.data;
  return {
    enabled: laya.enabled,
    python: laya.python,
    model_dir: laya.model_dir ?? posix.join(config.mounts.state, LAYA_MODEL_SUBDIRECTORY),
    lock_file: laya.lock_file ?? LAYA_DEFAULT_LOCK_FILE,
    batch_size: laya.batch_size,
    queue_batches: laya.queue_batches,
    timeout_ms: laya.timeout_ms,
    threads: laya.threads
  };
}
