import { z } from 'zod';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  DYNAMIC_PROJECTS_MAX,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  PROJECT_PROVISION_GLOBAL_PER_MINUTE,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  SCOPE_ID_PATTERN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { ScopeConfig } from '../core/types.js';

export const RESULT_DELIVERY_MODES = ['structured', 'text-json'] as const;
export type ResultDelivery = (typeof RESULT_DELIVERY_MODES)[number];

export const SEARCH_MODES = ['text', 'reranked'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const TOKEN_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const tokenDigestSchema = z.string().regex(TOKEN_SHA256_PATTERN, {
  message: 'token digest must be a lowercase sha256 hex digest'
});

const TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)|%2e|%2f|%5c|\u0000/i;

const withoutTraversal = (value: string): boolean => !TRAVERSAL_PATTERN.test(value);

const scopeId = z.string().regex(SCOPE_ID_PATTERN, {
  message: 'scope id must match ^[a-z][a-z0-9-]{0,63}$'
});

const safeName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(withoutTraversal, { message: 'value must not contain traversal sequences' });

const mountPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(withoutTraversal, { message: 'path must not contain traversal sequences' });

const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('\\') ||
  value.startsWith('//') ||
  /^[A-Za-z]:[\\/]/.test(value);

const relativePath = mountPath.refine((value) => !isAbsolutePath(value), {
  message: 'relative_root must be a relative path'
});

const httpEndpoint = z.url().refine((value) => /^https?:\/\//.test(value), {
  message: 'endpoint must be an http(s) URL'
});

export const scopeConfigSchema = z.strictObject({
  id: scopeId,
  backend_project: safeName,
  relative_root: relativePath,
  repository_aliases: z.array(safeName).max(16)
});

const scopeListSchema = z.array(scopeConfigSchema).min(1).superRefine((scopes, ctx) => {
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (ids.has(scope.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate scope id: ${scope.id}` });
    }
    ids.add(scope.id);
  }
  const owners = new Map<string, string>();
  for (const scope of scopes) {
    for (const identifier of [scope.id, ...scope.repository_aliases]) {
      const existing = owners.get(identifier);
      if (existing !== undefined && existing !== scope.id) {
        ctx.addIssue({ code: 'custom', message: `ambiguous scope identifier: ${identifier}` });
      } else {
        owners.set(identifier, scope.id);
      }
    }
  }
});

export const brainMountsSchema = z.strictObject({
  vault: mountPath,
  state: mountPath
});

export const brainLimitsSchema = z.strictObject({
  input_body_max_bytes: z.int().positive().optional().default(INPUT_BODY_MAX_BYTES),
  rendered_note_max_bytes: z.int().positive().optional().default(RENDERED_NOTE_MAX_BYTES),
  tool_result_max_bytes: z.int().positive().optional().default(TOOL_RESULT_MAX_BYTES),
  backend_timeout_ms: z.int().positive().optional().default(BACKEND_TIMEOUT_MS),
  materialization_timeout_ms: z.int().positive().optional().default(MATERIALIZATION_TIMEOUT_MS),
  reconcile_interval_ms: z.int().positive().optional().default(RECONCILE_INTERVAL_MS),
  concurrent_reads: z.int().positive().optional().default(CONCURRENT_READS),
  project_provision_global_per_minute: z
    .int()
    .positive()
    .optional()
    .default(PROJECT_PROVISION_GLOBAL_PER_MINUTE),
  dynamic_projects_max: z.int().positive().optional().default(DYNAMIC_PROJECTS_MAX)
});

const DEFAULT_LIMITS = {
  input_body_max_bytes: INPUT_BODY_MAX_BYTES,
  rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
  tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
  backend_timeout_ms: BACKEND_TIMEOUT_MS,
  materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
  reconcile_interval_ms: RECONCILE_INTERVAL_MS,
  concurrent_reads: CONCURRENT_READS,
  project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
  dynamic_projects_max: DYNAMIC_PROJECTS_MAX
};

export const LAYA_BATCH_SIZE_MAX = 8;
export const LAYA_QUEUE_BATCHES_MAX = 4;
export const LAYA_TIMEOUT_MS_MAX = 20_000;
export const LAYA_THREADS_MAX = 64;
export const LAYA_THREADS_DEFAULT = 4;
export const LAYA_DEFAULT_LOCK_FILE = 'config/laya-model.lock.json';
export const LAYA_MODEL_SUBDIRECTORY = 'models/laya/runtime';

const executablePath = mountPath.refine((value) => /^[A-Za-z0-9_./+-]+$/.test(value), {
  message: 'python must be an executable name or path without spaces or shell syntax'
});

export const layaConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  python: executablePath.default('python3'),
  model_dir: mountPath.optional(),
  lock_file: mountPath.optional(),
  batch_size: z.int().min(1).max(LAYA_BATCH_SIZE_MAX).default(LAYA_BATCH_SIZE_MAX),
  queue_batches: z.int().min(1).max(LAYA_QUEUE_BATCHES_MAX).default(LAYA_QUEUE_BATCHES_MAX),
  timeout_ms: z.int().min(100).max(LAYA_TIMEOUT_MS_MAX).default(LAYA_TIMEOUT_MS_MAX),
  threads: z.int().min(1).max(LAYA_THREADS_MAX).default(LAYA_THREADS_DEFAULT)
});

const DEFAULT_LAYA = {
  enabled: false,
  python: 'python3',
  batch_size: LAYA_BATCH_SIZE_MAX,
  queue_batches: LAYA_QUEUE_BATCHES_MAX,
  timeout_ms: LAYA_TIMEOUT_MS_MAX,
  threads: LAYA_THREADS_DEFAULT
};

export const brainConfigSchema = z.strictObject({
  endpoint: httpEndpoint,
  backend_endpoint: httpEndpoint.optional(),
  port: z.int().min(1).max(65535),
  mounts: brainMountsSchema,
  cursor_secret_file: mountPath.optional(),
  scopes: scopeListSchema,
  limits: brainLimitsSchema.default(() => ({ ...DEFAULT_LIMITS })),
  allowed_hosts: z.array(safeName).min(1),
  allowed_origins: z.array(httpEndpoint).default([]),
  result_delivery: z.enum(RESULT_DELIVERY_MODES).default('structured'),
  search_mode: z.enum(SEARCH_MODES).default('text'),
  search_fallback_only: z.boolean().default(false),
  laya: layaConfigSchema.default(() => ({ ...DEFAULT_LAYA }))
});

export interface BrainMounts {
  vault: string;
  state: string;
}

export interface BrainLimits {
  input_body_max_bytes: number;
  rendered_note_max_bytes: number;
  tool_result_max_bytes: number;
  backend_timeout_ms: number;
  materialization_timeout_ms: number;
  reconcile_interval_ms: number;
  concurrent_reads: number;
  project_provision_global_per_minute: number;
  dynamic_projects_max: number;
}

export interface LayaConfig {
  enabled: boolean;
  python: string;
  model_dir?: string;
  lock_file?: string;
  batch_size: number;
  queue_batches: number;
  timeout_ms: number;
  threads: number;
}

export interface LayaSettings {
  enabled: boolean;
  python: string;
  model_dir: string;
  lock_file: string;
  batch_size: number;
  queue_batches: number;
  timeout_ms: number;
  threads: number;
}

export interface BrainConfig {
  endpoint: string;
  backend_endpoint?: string;
  port: number;
  mounts: BrainMounts;
  cursor_secret_file?: string;
  scopes: ScopeConfig[];
  limits: BrainLimits;
  allowed_hosts: string[];
  allowed_origins: string[];
  result_delivery: ResultDelivery;
  search_mode?: SearchMode;
  search_fallback_only?: boolean;
  laya?: LayaConfig;
}
