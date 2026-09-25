import { pathToFileURL } from 'node:url';
import { loadConfig, loadTokenDigest, resolveLayaSettings, resolveSearchSettings } from './config/load.js';
import type { BrainConfig } from './config/schema.js';
import { createRuntime, type BrainRuntime } from './runtime.js';
import { LayaWorker } from './retrieval/laya-worker.js';
import { layaWorkerOptions } from './retrieval/laya-worker.js';

export const DEFAULT_CONFIG_PATH = '/run/brain/brain.yaml';

function applyEnvironment(config: BrainConfig, env: NodeJS.ProcessEnv): BrainConfig {
  const next: BrainConfig = { ...config, mounts: { ...config.mounts }, limits: { ...config.limits } };
  if (env.BRAIN_CURSOR_SECRET !== undefined && env.BRAIN_CURSOR_SECRET.length > 0) {
    next.cursor_secret_file = env.BRAIN_CURSOR_SECRET;
  }
  if (env.BRAIN_STATE_DIR !== undefined && env.BRAIN_STATE_DIR.length > 0) {
    next.mounts.state = env.BRAIN_STATE_DIR;
  }
  if (env.BRAIN_VAULT_DIR !== undefined && env.BRAIN_VAULT_DIR.length > 0) {
    next.mounts.vault = env.BRAIN_VAULT_DIR;
  }
  if (env.BRAIN_PORT !== undefined && env.BRAIN_PORT.length > 0) {
    const port = Number(env.BRAIN_PORT);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) next.port = port;
  }
  if (env.BRAIN_SEARCH_MODE !== undefined && env.BRAIN_SEARCH_MODE.length > 0) {
    if (env.BRAIN_SEARCH_MODE === 'text' || env.BRAIN_SEARCH_MODE === 'reranked') {
      next.search_mode = env.BRAIN_SEARCH_MODE;
    } else {
      throw new Error('BRAIN_SEARCH_MODE must be text or reranked');
    }
  }
  if (env.BRAIN_SEARCH_FALLBACK_ONLY !== undefined && env.BRAIN_SEARCH_FALLBACK_ONLY.length > 0) {
    if (env.BRAIN_SEARCH_FALLBACK_ONLY === 'true') next.search_fallback_only = true;
    else if (env.BRAIN_SEARCH_FALLBACK_ONLY === 'false') next.search_fallback_only = false;
    else throw new Error('BRAIN_SEARCH_FALLBACK_ONLY must be true or false');
  }
  if (env.BRAIN_RECONCILE_INTERVAL_MS !== undefined && env.BRAIN_RECONCILE_INTERVAL_MS.length > 0) {
    if (!/^[0-9]{1,9}$/.test(env.BRAIN_RECONCILE_INTERVAL_MS)) {
      throw new Error('BRAIN_RECONCILE_INTERVAL_MS must be a positive integer');
    }
    const interval = Number(env.BRAIN_RECONCILE_INTERVAL_MS);
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error('BRAIN_RECONCILE_INTERVAL_MS must be a positive integer');
    }
    next.limits.reconcile_interval_ms = interval;
  }
  return next;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const configPath = env.BRAIN_CONFIG ?? DEFAULT_CONFIG_PATH;
  return applyEnvironment(loadConfig(configPath), env);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<BrainRuntime> {
  const tokenDigest = loadTokenDigest(env);
  const config = resolveConfig(env);
  const search = resolveSearchSettings(config, env);
  config.search_mode = search.mode;
  config.search_fallback_only = search.fallback_only;
  const laya = resolveLayaSettings(config, env);
  const worker = new LayaWorker(layaWorkerOptions(laya, process.cwd(), env));
  worker.start();
  return createRuntime(config, { token_digest: tokenDigest, local: { worker } });
}

export function installShutdownHandlers(runtime: BrainRuntime): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime
      .close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntryPoint) {
  main()
    .then((runtime) => {
      installShutdownHandlers(runtime);
      process.stdout.write(`second-brain listening on ${runtime.url}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`second-brain failed to start: ${message}\n`);
      process.exitCode = 1;
    });
}
