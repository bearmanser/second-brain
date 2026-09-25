import { pathToFileURL } from 'node:url';
import {
  loadConfig,
  loadTokenDigest,
  resolveLayaSettings,
  resolveReconcileInterval,
  resolveSearchSettings
} from './config/load.js';
import type { BrainConfig } from './config/schema.js';
import { createRuntime, type BrainRuntime } from './runtime.js';
import { LayaWorker } from './retrieval/laya-worker.js';
import { layaWorkerOptions } from './retrieval/laya-worker.js';

export const DEFAULT_CONFIG_PATH = '/run/brain/brain.yaml';

function applyEnvironment(config: BrainConfig, env: NodeJS.ProcessEnv): BrainConfig {
  const next: BrainConfig = { ...config, mounts: { ...config.mounts } };
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
  return next;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const configPath = env.BRAIN_CONFIG ?? DEFAULT_CONFIG_PATH;
  const config = applyEnvironment(loadConfig(configPath), env);
  const search = resolveSearchSettings(config, env);
  config.search_mode = search.mode;
  config.search_fallback_only = search.fallback_only;
  config.limits = {
    ...config.limits,
    reconcile_interval_ms: resolveReconcileInterval(config, env)
  };
  return config;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<BrainRuntime> {
  const tokenDigest = loadTokenDigest(env);
  const config = resolveConfig(env);
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
