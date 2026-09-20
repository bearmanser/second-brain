import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrainError, isBrainError } from './contracts/errors.js';
import type { Clock, IdSource } from './core/types.js';
import { MutationCoordinator, InstanceLock } from './core/mutation.js';
import { installShutdownHandlers, main, resolveConfig } from './main.js';
import { RevisionCatalogue } from './notes/catalogue.js';
import { bootstrap } from './operations/bootstrap.js';
import { health } from './operations/health.js';
import { BasicMemoryBackend } from './storage/basic-memory.js';
import { Journal } from './storage/journal.js';
import { FileVault } from './storage/vault.js';

export type CliCommand = 'serve' | 'setup' | 'health' | 'recover' | 'rebuild-catalogue';

export const CLI_COMMANDS: readonly CliCommand[] = [
  'serve',
  'setup',
  'health',
  'recover',
  'rebuild-catalogue'
];

export interface ParsedArguments {
  command: CliCommand;
  flags: Map<string, string | boolean>;
  positionals: string[];
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

const USAGE = [
  'usage: node dist/cli.js <command> [options]',
  'commands: serve | setup | health | recover | rebuild-catalogue'
].join('\n');

function isCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const [first, ...rest] = argv;
  const command = first === undefined || first.startsWith('-') ? 'serve' : first;
  if (!isCommand(command)) {
    throw new BrainError({ code: 'INVALID_INPUT', message: `${USAGE}` });
  }
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const tokens = first !== undefined && first.startsWith('-') ? [...argv] : rest;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const separator = body.indexOf('=');
      if (separator !== -1) {
        flags.set(body.slice(0, separator), body.slice(separator + 1));
        continue;
      }
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, flags, positionals };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new BrainError({ code: 'INVALID_INPUT', message: `--${name} must be an integer` });
  }
  return parsed;
}

function flagBoolean(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}

async function runSetup(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const root = flagString(parsed.flags, 'root') ?? env.BRAIN_SETUP_ROOT ?? process.cwd();
  const scope = flagString(parsed.flags, 'scope') ?? env.BRAIN_SETUP_SCOPE ?? 'freellmapi';
  const vault = flagString(parsed.flags, 'vault') ?? env.BRAIN_SETUP_VAULT;
  const uid = flagNumber(parsed.flags, 'uid') ?? (env.BRAIN_SETUP_UID === undefined ? undefined : Number(env.BRAIN_SETUP_UID));
  const gid = flagNumber(parsed.flags, 'gid') ?? (env.BRAIN_SETUP_GID === undefined ? undefined : Number(env.BRAIN_SETUP_GID));
  const ownerCredential =
    flagBoolean(parsed.flags, 'owner-credential') || env.BRAIN_SETUP_OWNER_CREDENTIAL === '1';
  const result = await bootstrap({
    root,
    scope,
    ...(vault === undefined ? {} : { vault_path: vault }),
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
    ...(ownerCredential ? { owner_credential: true } : {})
  });
  process.stdout.write(`bootstrap root: ${root}\n`);
  process.stdout.write(`bootstrap created: ${result.created.join(', ') || '(none)'}\n`);
  process.stdout.write(`bootstrap preserved: ${result.preserved.join(', ') || '(none)'}\n`);
  process.stdout.write(`bootstrap vault: ${result.vault_path}\n`);
  process.stdout.write(`bootstrap config: ${result.config_path}\n`);
  return 0;
}

async function runHealth(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const tokenFile = flagString(parsed.flags, 'token-file') ?? env.BRAIN_HEALTH_TOKEN;
  const healthy = await health(config, {
    ...(tokenFile === undefined ? {} : { token_file: tokenFile }),
    onDiagnostic: (message) => process.stderr.write(`${message}\n`)
  });
  process.stdout.write(healthy ? 'healthy\n' : 'unhealthy\n');
  return healthy ? 0 : 1;
}

async function runRecover(_parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const lock = InstanceLock.acquire(config.mounts.state);
  let journal: Journal | undefined;
  let catalogue: RevisionCatalogue | undefined;
  let backend: BasicMemoryBackend | undefined;
  try {
    journal = Journal.open(join(config.mounts.state, 'journal.db'), { requireExisting: true });
    const vault = new FileVault(config.mounts.vault, config.scopes);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: config.scopes,
      clock: systemClock
    });
    backend = new BasicMemoryBackend({
      url: config.backend_endpoint,
      projects: config.scopes.map((scope) => scope.backend_project),
      timeout_ms: config.limits.backend_timeout_ms
    });
    await backend.connect();
    const mutations = new MutationCoordinator({
      config,
      backend,
      vault,
      catalogue,
      journal,
      clock: systemClock,
      ids: systemIds
    });
    await mutations.recover();
    process.stdout.write('recovery complete\n');
    return 0;
  } finally {
    await backend?.close().catch(() => undefined);
    catalogue?.close();
    journal?.close();
    lock.release();
  }
}

async function runRebuildCatalogue(_parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const lock = InstanceLock.acquire(config.mounts.state);
  let catalogue: RevisionCatalogue | undefined;
  try {
    const vault = new FileVault(config.mounts.vault, config.scopes);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: config.scopes,
      clock: systemClock
    });
    for (const scope of config.scopes) {
      await catalogue.reconcile(scope.id);
    }
    process.stdout.write(`catalogue rebuilt for ${config.scopes.map((scope) => scope.id).join(', ')}\n`);
    return 0;
  } finally {
    catalogue?.close();
    lock.release();
  }
}

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const parsed = parseArguments(argv);
  switch (parsed.command) {
    case 'serve': {
      const runtime = await main(env);
      installShutdownHandlers(runtime);
      process.stdout.write(`second-brain listening on ${runtime.url}\n`);
      return 0;
    }
    case 'setup':
      return runSetup(parsed, env);
    case 'health':
      return runHealth(parsed, env);
    case 'recover':
      return runRecover(parsed, env);
    case 'rebuild-catalogue':
      return runRebuildCatalogue(parsed, env);
  }
}

function report(error: unknown): number {
  if (isBrainError(error)) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  return 1;
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntryPoint) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.exitCode = report(error);
    });
}
