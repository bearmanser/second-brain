import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCredentials } from './config/load.js';
import { BrainError, isBrainError } from './contracts/errors.js';
import type { Clock, IdSource } from './core/types.js';
import { MutationCoordinator, InstanceLock, type BrainDeps } from './core/mutation.js';
import { installShutdownHandlers, main, resolveConfig } from './main.js';
import { APPLICATION_VERSION, SCHEMA_VERSION } from './mcp/tools.js';
import { RevisionCatalogue } from './notes/catalogue.js';
import { JournalApprovalProvenance } from './notes/reconcile.js';
import {
  assertCompatibleStateSchema,
  buildManifest,
  collectManifestFiles,
  readManifestFile,
  verifyManifest,
  writeManifestFile
} from './operations/backup.js';
import { bootstrap } from './operations/bootstrap.js';
import { health } from './operations/health.js';
import { assertRecoveryMode, authenticateOwner, recoverPending, summariseRecovery } from './operations/recovery.js';
import { BasicMemoryBackend } from './storage/basic-memory.js';
import { Journal } from './storage/journal.js';
import { FileVault } from './storage/vault.js';

export type CliCommand =
  | 'serve'
  | 'setup'
  | 'health'
  | 'recover'
  | 'recover-state'
  | 'rebuild-catalogue'
  | 'backup-manifest'
  | 'verify-backup';

export const CLI_COMMANDS: readonly CliCommand[] = [
  'serve',
  'setup',
  'health',
  'recover',
  'recover-state',
  'rebuild-catalogue',
  'backup-manifest',
  'verify-backup'
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
  'commands: serve | setup | health | recover | recover-state | rebuild-catalogue | backup-manifest | verify-backup'
].join('\n');

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

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

function flagList(flags: Map<string, string | boolean>, name: string): string[] {
  const value = flagString(flags, name);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function flagPairs(flags: Map<string, string | boolean>, name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of flagList(flags, name)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw invalidInput(`--${name} entries must look like name=value`);
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
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
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
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

async function runRebuildCatalogue(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const acceptLoss = flagBoolean(parsed.flags, 'accept-operational-loss');
  const lock = InstanceLock.acquire(config.mounts.state);
  let journal: Journal | undefined;
  let catalogue: RevisionCatalogue | undefined;
  try {
    if (acceptLoss) {
      journal = Journal.open(join(config.mounts.state, 'journal.db'));
      process.stdout.write(
        'catalogue rebuild acknowledged operational loss: journal.db was initialized fresh; ' +
          'retry and feedback history is gone and this is not full operational recovery\n'
      );
    } else {
      journal = Journal.open(join(config.mounts.state, 'journal.db'), { requireExisting: true });
    }
    const vault = new FileVault(config.mounts.vault, config.scopes);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: config.scopes,
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
    });
    let scanned = 0;
    let conflicted = 0;
    let malformed = 0;
    let unsupported = 0;
    for (const scope of config.scopes) {
      const report = await catalogue.reconcileReport(scope.id);
      scanned += report.scanned;
      conflicted += report.conflicted;
      malformed += report.malformed;
      unsupported += report.unsupported_schema;
    }
    process.stdout.write(
      `catalogue rebuilt for ${config.scopes.map((scope) => scope.id).join(', ')}; ` +
        `scanned ${scanned}, conflicts ${conflicted}, malformed ${malformed}, unsupported ${unsupported}\n`
    );
    return 0;
  } finally {
    catalogue?.close();
    journal?.close();
    lock.release();
  }
}

function resolveAuthorization(
  parsed: ParsedArguments,
  env: NodeJS.ProcessEnv
): string | undefined {
  const token =
    flagString(parsed.flags, 'token') ?? env.BRAIN_TOKEN ?? env.BRAIN_HEALTH_TOKEN;
  if (token === undefined || token.length === 0) return undefined;
  return `Bearer ${token}`;
}

async function runRecoverState(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  assertRecoveryMode(flagString(parsed.flags, 'mode'));
  const config = resolveConfig(env);
  const credentials = loadCredentials(config.credentials_file);
  authenticateOwner(resolveAuthorization(parsed, env), credentials);
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
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
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
    const deps: BrainDeps = {
      config,
      backend,
      vault,
      catalogue,
      journal,
      clock: systemClock,
      ids: systemIds,
      mutations
    };
    const report = await recoverPending(deps);
    process.stdout.write(`${summariseRecovery(report)}\n`);
    for (const operation of report.operations) {
      process.stdout.write(
        `  ${operation.operation_id} ${operation.previous_state}->${operation.state} ` +
          `${operation.outcome}${operation.reason === undefined ? '' : ` (${operation.reason})`}\n`
      );
    }
    return report.blocking_operations.length > 0 ? 1 : 0;
  } finally {
    await backend?.close().catch(() => undefined);
    catalogue?.close();
    journal?.close();
    lock.release();
  }
}

async function runBackupManifest(parsed: ParsedArguments): Promise<number> {
  const root = flagString(parsed.flags, 'root') ?? '.';
  const out = flagString(parsed.flags, 'out');
  const stores = flagList(parsed.flags, 'store');
  const images = flagPairs(parsed.flags, 'image');
  const volumes = flagPairs(parsed.flags, 'volume');
  const sensitive = flagBoolean(parsed.flags, 'sensitive');
  const createdAt = flagString(parsed.flags, 'created-at');
  let files = await collectManifestFiles(root);
  if (out !== undefined && out !== '-') {
    const base = resolve(root);
    const target = resolve(out);
    files = files.filter((file) => resolve(base, file.path) !== target);
  }
  const manifest = buildManifest(files, {
    application: APPLICATION_VERSION,
    schema: SCHEMA_VERSION,
    images,
    stores,
    sensitive,
    volumes,
    ...(createdAt === undefined ? {} : { created_at: createdAt })
  });
  if (out === undefined || out === '-') {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    await writeManifestFile(out, manifest);
  }
  process.stderr.write(`backup manifest: ${files.length} files\n`);
  return 0;
}

async function runVerifyBackup(parsed: ParsedArguments): Promise<number> {
  const root = flagString(parsed.flags, 'root') ?? '.';
  const manifestPath = flagString(parsed.flags, 'manifest');
  if (manifestPath === undefined) throw invalidInput('verify-backup requires --manifest');
  const manifest = await readManifestFile(manifestPath);
  assertCompatibleStateSchema(manifest, SCHEMA_VERSION);
  await verifyManifest(root, manifest);
  process.stdout.write(
    `verified ${manifest.files.length} files (format ${manifest.format_version}, schema ${manifest.software.schema})\n`
  );
  return 0;
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
    case 'recover-state':
      return runRecoverState(parsed, env);
    case 'rebuild-catalogue':
      return runRebuildCatalogue(parsed, env);
    case 'backup-manifest':
      return runBackupManifest(parsed);
    case 'verify-backup':
      return runVerifyBackup(parsed);
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
