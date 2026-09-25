import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { restrictedLayaEnvironment } from '../../src/retrieval/laya-worker.js';
import { LAYA_DEFAULT_LOCK_FILE, LAYA_MODEL_SUBDIRECTORY } from '../../src/config/schema.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_MODEL_DIR = process.env.BRAIN_LAYA_MODEL_DIR ?? `/var/lib/second-brain/${LAYA_MODEL_SUBDIRECTORY}`;
const RUNTIME_DIR = join(DEFAULT_MODEL_DIR);
const LOCK_FILE = join(REPO_ROOT, LAYA_DEFAULT_LOCK_FILE);

const readText = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
const artifactsPresent = existsSync(RUNTIME_DIR) && existsSync(LOCK_FILE);

describe('offline local retrieval', () => {
  test('normal startup does not fetch models', () => {
    const dockerfile = readText('Dockerfile');
    expect(dockerfile).not.toMatch(/prepare-laya\.py\s+fetch/);
    expect(dockerfile).not.toMatch(/huggingface|hf_hub|from_pretrained|snapshot_download/i);
    const compose = readText('compose.yaml');
    expect(compose).not.toMatch(/prepare-laya|huggingface/i);
    const setup = readText('scripts/setup.sh');
    expect(setup).not.toMatch(/prepare-laya\.py\s+fetch/);
  });

  test('the worker child runs with networking and telemetry disabled', () => {
    const env = restrictedLayaEnvironment({ PATH: '/usr/bin' }, { threads: 2 });
    expect(env.HF_HUB_OFFLINE).toBe('1');
    expect(env.TRANSFORMERS_OFFLINE).toBe('1');
    expect(env.HF_HUB_DISABLE_TELEMETRY).toBe('1');
    expect(env.TOKENIZERS_PARALLELISM).toBe('false');
    expect(env.OMP_NUM_THREADS).toBe('2');
    expect(env.MKL_NUM_THREADS).toBe('2');
    expect(env.OPENBLAS_NUM_THREADS).toBe('2');
  });

  test('the explicit model-prepare step is documented and separate from startup', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts/prepare-models.sh'))).toBe(true);
    const setup = readText('scripts/setup.sh');
    expect(setup).not.toMatch(/BRAIN_LAYA_ENABLED=true/);
  });

  test('the tracked model lock matches the configured default model directory', () => {
    const lock = JSON.parse(readText(LAYA_DEFAULT_LOCK_FILE)) as {
      revision: string;
      runtime: { fingerprint: string };
    };
    expect(lock.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.runtime.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test.skipIf(!artifactsPresent)(
    'verified cached artifacts load with networking disabled',
    () => {
      const result = spawnSync(
        'python3',
        [
          'scripts/prepare-laya.py',
          'verify',
          '--lock',
          LAYA_DEFAULT_LOCK_FILE,
          '--destination',
          DEFAULT_MODEL_DIR,
          '--offline'
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
      expect(`${result.stdout}${result.stderr}`).toContain('"command": "verify"');
      expect(result.status).toBe(0);
    },
    600_000
  );
});
