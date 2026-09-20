import { z } from 'zod';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  SCOPE_ID_PATTERN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { Principal, ScopeConfig } from '../core/types.js';

export const PRINCIPAL_ROLES = ['worker', 'reviewer', 'owner'] as const;
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number];

export const RESULT_DELIVERY_MODES = ['structured', 'text-json'] as const;
export type ResultDelivery = (typeof RESULT_DELIVERY_MODES)[number];

export const TOKEN_SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

export const principalSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(PRINCIPAL_ROLES),
  read_scopes: z.array(scopeId),
  write_scopes: z.array(scopeId),
  review_scopes: z.array(scopeId)
});

export const credentialRecordSchema = z.strictObject({
  token_sha256: z.string().regex(TOKEN_SHA256_PATTERN, {
    message: 'token_sha256 must be a lowercase sha256 hex digest'
  }),
  principal: principalSchema
});

export const credentialsFileSchema = z.strictObject({
  credentials: z.array(credentialRecordSchema).min(1).superRefine((records, ctx) => {
    const digests = new Set<string>();
    for (const record of records) {
      if (digests.has(record.token_sha256)) {
        ctx.addIssue({ code: 'custom', message: 'duplicate credential digest' });
      }
      digests.add(record.token_sha256);
    }
  })
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
  concurrent_reads: z.int().positive().optional().default(CONCURRENT_READS)
});

const DEFAULT_LIMITS = {
  input_body_max_bytes: INPUT_BODY_MAX_BYTES,
  rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
  tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
  backend_timeout_ms: BACKEND_TIMEOUT_MS,
  materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
  reconcile_interval_ms: RECONCILE_INTERVAL_MS,
  concurrent_reads: CONCURRENT_READS
};

export const brainConfigSchema = z.strictObject({
  endpoint: httpEndpoint,
  backend_endpoint: httpEndpoint,
  port: z.int().min(1).max(65535),
  mounts: brainMountsSchema,
  credentials_file: mountPath,
  cursor_secret_file: mountPath.optional(),
  scopes: scopeListSchema,
  limits: brainLimitsSchema.default(() => ({ ...DEFAULT_LIMITS })),
  allowed_hosts: z.array(safeName).min(1),
  allowed_origins: z.array(httpEndpoint).default([]),
  result_delivery: z.enum(RESULT_DELIVERY_MODES).default('structured')
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
}

export interface BrainConfig {
  endpoint: string;
  backend_endpoint: string;
  port: number;
  mounts: BrainMounts;
  credentials_file: string;
  cursor_secret_file?: string;
  scopes: ScopeConfig[];
  limits: BrainLimits;
  allowed_hosts: string[];
  allowed_origins: string[];
  result_delivery?: ResultDelivery;
}

export interface CredentialRecord {
  token_sha256: string;
  principal: Principal;
}
