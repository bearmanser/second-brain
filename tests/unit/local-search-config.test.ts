import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  RECONCILE_INTERVAL_ENV,
  SEARCH_MODE_ENV,
  resolveLayaSettings,
  resolveReconcileInterval,
  resolveSearchSettings,
  loadConfig
} from '../../src/config/load.js';
import type { BrainConfig } from '../../src/config/schema.js';

const exampleConfigPath = fileURLToPath(new URL('../../config/brain.example.yaml', import.meta.url));
const baseConfig = (): BrainConfig => loadConfig(exampleConfigPath);

test('the documented example defaults to lexical text search with the model disabled', () => {
  const config = baseConfig();
  expect(config.search_mode).toBe('text');
  expect(config.search_fallback_only).toBe(false);
  expect(config.laya?.enabled).toBe(false);
});

test('resolves the default search mode from config when the environment is unset', () => {
  expect(resolveSearchSettings(baseConfig(), {})).toEqual({ mode: 'text', fallback_only: false });
});

test('accepts reranked only when the worker is enabled', () => {
  const config = baseConfig();
  expect(resolveSearchSettings(config, { [SEARCH_MODE_ENV]: 'reranked', BRAIN_LAYA_ENABLED: 'true' })).toEqual({
    mode: 'reranked',
    fallback_only: false
  });
});

test('accepts reranked with a disabled worker only under explicit fallback-only configuration', () => {
  const config = baseConfig();
  expect(
    resolveSearchSettings(config, { [SEARCH_MODE_ENV]: 'reranked', BRAIN_SEARCH_FALLBACK_ONLY: 'true' })
  ).toEqual({ mode: 'reranked', fallback_only: true });
});

test('rejects reranked with a disabled worker unless fallback-only is explicit', () => {
  const config = baseConfig();
  expect(() => resolveSearchSettings(config, { [SEARCH_MODE_ENV]: 'reranked' })).toThrow(/INVALID_INPUT/);
  expect(() =>
    resolveSearchSettings(config, { [SEARCH_MODE_ENV]: 'reranked', BRAIN_SEARCH_FALLBACK_ONLY: 'false' })
  ).toThrow(/INVALID_INPUT/);
});

test('rejects malformed search mode and fallback values', () => {
  const config = baseConfig();
  expect(() => resolveSearchSettings(config, { [SEARCH_MODE_ENV]: 'semantic' })).toThrow(/INVALID_INPUT/);
  expect(() => resolveSearchSettings(config, { BRAIN_SEARCH_FALLBACK_ONLY: 'yes' })).toThrow(/INVALID_INPUT/);
});

test('maps the reconcile interval with strict integer validation', () => {
  const config = baseConfig();
  expect(resolveReconcileInterval(config, {})).toBe(config.limits.reconcile_interval_ms);
  expect(resolveReconcileInterval(config, { [RECONCILE_INTERVAL_ENV]: '5000' })).toBe(5000);
  expect(() => resolveReconcileInterval(config, { [RECONCILE_INTERVAL_ENV]: '0' })).toThrow(/INVALID_INPUT/);
  expect(() => resolveReconcileInterval(config, { [RECONCILE_INTERVAL_ENV]: '-1' })).toThrow(/INVALID_INPUT/);
  expect(() => resolveReconcileInterval(config, { [RECONCILE_INTERVAL_ENV]: 'soon' })).toThrow(/INVALID_INPUT/);
});

test('maps the Laya worker settings from the environment with strict types', () => {
  const config = baseConfig();
  const settings = resolveLayaSettings(config, {
    BRAIN_LAYA_ENABLED: 'true',
    BRAIN_LAYA_BATCH_SIZE: '8',
    BRAIN_LAYA_QUEUE_BATCHES: '4',
    BRAIN_LAYA_TIMEOUT_MS: '4000',
    BRAIN_LAYA_THREADS: '2',
    BRAIN_LAYA_MODEL_DIR: '/var/lib/second-brain/models/laya/runtime'
  });
  expect(settings).toMatchObject({
    enabled: true,
    model_dir: '/var/lib/second-brain/models/laya/runtime',
    batch_size: 8,
    queue_batches: 4,
    timeout_ms: 4000,
    threads: 2
  });
  expect(() => resolveLayaSettings(config, { BRAIN_LAYA_THREADS: 'many' })).toThrow(/INVALID_INPUT/);
  expect(() => resolveLayaSettings(config, { BRAIN_LAYA_ENABLED: 'yes' })).toThrow(/INVALID_INPUT/);
});
