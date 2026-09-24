import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTokenDigest } from './config/load.js';
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
  validateBackupArchive,
  validateStoreLinks,
  verifyManifest,
  writeManifestFile
} from './operations/backup.js';
import { bootstrap } from './operations/bootstrap.js';
import { health } from './operations/health.js';
import { selectLegacyCredentialDigest } from './operations/legacy-credentials.js';
import {
  assertRecoveryMode,
  recoverPending,
  requireRecoveryAuthorization,
  summariseRecovery
} from './operations/recovery.js';
import { applyVaultMigration, formatMigrationBlockers, resumeVaultMigration } from './operations/vault-v2/apply.js';
import { planVaultMigration } from './operations/vault-v2/plan.js';
import { buildInspectionReport, renderInspectionReport } from './operations/vault-v2/report.js';
import { rollbackVaultMigration } from './operations/vault-v2/rollback.js';
import { verifyVaultMigration } from './operations/vault-v2/verify.js';
import { ScopeRegistry } from './projects/scope-registry.js';
import { generateBearerToken } from './security/authenticate.js';
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
  | 'validate-archive'
  | 'validate-store-links'
  | 'verify-backup'
  | 'auth'
  | 'vault-v2';

export const CLI_COMMANDS: readonly CliCommand[] = [
  'serve',
  'setup',
  'health',
  'recover',
  'recover-state',
  'rebuild-catalogue',
  'backup-manifest',
  'validate-archive',
  'validate-store-links',
  'verify-backup',
  'auth',
  'vault-v2'
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
  'commands: serve | setup | health | recover | recover-state | rebuild-catalogue | backup-manifest | validate-archive | validate-store-links | verify-backup | auth | vault-v2'
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
  const scope = flagString(parsed.flags, 'scope') ?? env.BRAIN_SETUP_SCOPE;
  const vault = flagString(parsed.flags, 'vault') ?? env.BRAIN_SETUP_VAULT;
  const uid = flagNumber(parsed.flags, 'uid') ?? (env.BRAIN_SETUP_UID === undefined ? undefined : Number(env.BRAIN_SETUP_UID));
  const gid = flagNumber(parsed.flags, 'gid') ?? (env.BRAIN_SETUP_GID === undefined ? undefined : Number(env.BRAIN_SETUP_GID));
  const result = await bootstrap({
    root,
    ...(scope === undefined ? {} : { scope }),
    ...(vault === undefined ? {} : { vault_path: vault }),
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid })
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
    const scopeRegistry = new ScopeRegistry(config.scopes, journal);
    for (const scope of scopeRegistry.all()) vault.registerScope(scope);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: scopeRegistry.all(),
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
    });
    backend = new BasicMemoryBackend({
      url: config.backend_endpoint,
      projects: scopeRegistry.all().map((scope) => scope.backend_project),
      timeout_ms: config.limits.backend_timeout_ms
    });
    await backend.connect();
    for (const scope of scopeRegistry.all()) backend.registerScope(scope);
    const mutations = new MutationCoordinator({
      config,
      scopeRegistry,
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
    const scopeRegistry = new ScopeRegistry(config.scopes, journal);
    for (const scope of scopeRegistry.all()) vault.registerScope(scope);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: scopeRegistry.all(),
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
    });
    let scanned = 0;
    let conflicted = 0;
    let malformed = 0;
    let unsupported = 0;
    for (const scope of scopeRegistry.all()) {
      const report = await catalogue.reconcileReport(scope.id);
      scanned += report.scanned;
      conflicted += report.conflicted;
      malformed += report.malformed;
      unsupported += report.unsupported_schema;
    }
    if (acceptLoss) journal.acknowledgeOperationalLoss();
    process.stdout.write(
      `catalogue rebuilt for ${scopeRegistry.all().map((scope) => scope.id).join(', ')}; ` +
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
  requireRecoveryAuthorization(resolveAuthorization(parsed, env), loadTokenDigest(env));
  const lock = InstanceLock.acquire(config.mounts.state);
  let journal: Journal | undefined;
  let catalogue: RevisionCatalogue | undefined;
  let backend: BasicMemoryBackend | undefined;
  try {
    journal = Journal.open(join(config.mounts.state, 'journal.db'), { requireExisting: true });
    const vault = new FileVault(config.mounts.vault, config.scopes);
    const scopeRegistry = new ScopeRegistry(config.scopes, journal);
    for (const scope of scopeRegistry.all()) vault.registerScope(scope);
    catalogue = RevisionCatalogue.open(join(config.mounts.state, 'catalogue.db'), {
      vault,
      scopes: scopeRegistry.all(),
      clock: systemClock,
      approval_provenance: new JournalApprovalProvenance(journal)
    });
    backend = new BasicMemoryBackend({
      url: config.backend_endpoint,
      projects: scopeRegistry.all().map((scope) => scope.backend_project),
      timeout_ms: config.limits.backend_timeout_ms
    });
    await backend.connect();
    for (const scope of scopeRegistry.all()) backend.registerScope(scope);
    const mutations = new MutationCoordinator({
      config,
      scopeRegistry,
      backend,
      vault,
      catalogue,
      journal,
      clock: systemClock,
      ids: systemIds
    });
    const deps: BrainDeps = {
      config,
      scopeRegistry,
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

async function runValidateArchive(parsed: ParsedArguments): Promise<number> {
  const archive = flagString(parsed.flags, 'archive');
  const mode = flagString(parsed.flags, 'mode');
  if (archive === undefined) throw invalidInput('validate-archive requires --archive');
  if (mode !== 'vault' && mode !== 'volume') {
    throw invalidInput('validate-archive requires --mode vault or --mode volume');
  }
  await validateBackupArchive(archive, mode);
  process.stdout.write(`validated ${mode} archive: ${archive}\n`);
  return 0;
}

async function runValidateStoreLinks(parsed: ParsedArguments): Promise<number> {
  const root = flagString(parsed.flags, 'root');
  const mode = flagString(parsed.flags, 'mode');
  if (root === undefined) throw invalidInput('validate-store-links requires --root');
  if (mode !== 'vault' && mode !== 'volume') {
    throw invalidInput('validate-store-links requires --mode vault or --mode volume');
  }
  await validateStoreLinks(root, mode);
  process.stdout.write(`validated ${mode} store links: ${root}\n`);
  return 0;
}

async function runAuth(parsed: ParsedArguments): Promise<number> {
  const subcommand = parsed.positionals[0];
  if (subcommand === 'generate') {
    const generated = generateBearerToken();
    process.stdout.write(`BRAIN_TOKEN_SHA256=${generated.token_sha256}\n`);
    if (flagBoolean(parsed.flags, 'show-token')) {
      process.stdout.write(`${generated.token}\n`);
    }
    return 0;
  }
  if (subcommand === 'migrate') {
    const credentialsFile = flagString(parsed.flags, 'credentials-file');
    if (credentialsFile === undefined) {
      throw invalidInput('auth migrate requires --credentials-file');
    }
    const selection = flagNumber(parsed.flags, 'select-entry');
    if (selection === undefined) {
      throw invalidInput('auth migrate requires --select-entry');
    }
    process.stdout.write(`BRAIN_TOKEN_SHA256=${selectLegacyCredentialDigest(credentialsFile, selection)}\n`);
    return 0;
  }
  throw invalidInput(`auth requires a subcommand\n${USAGE}`);
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw invalidInput(`${label} cannot be read: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidInput(`${label} is not valid JSON: ${path}`);
  }
}

async function runVaultV2(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const subcommand = parsed.positionals[0];
  const config = resolveConfig(env);
  const vault = flagString(parsed.flags, 'vault') ?? config.mounts.vault;
  const state = flagString(parsed.flags, 'state') ?? config.mounts.state;
  const projectNames = flagPairs(parsed.flags, 'projects');
  const clock: Clock = systemClock;
  if (subcommand === 'inspect') {
    const report = flagString(parsed.flags, 'report');
    if (report === undefined) throw invalidInput('vault-v2 inspect requires --report');
    const plan = await planVaultMigration({
      vault,
      state,
      projectNames,
      outputDirectory: dirname(resolve(report)),
      clock
    });
    const inspection = buildInspectionReport(plan);
    await writeFile(report, `${JSON.stringify(inspection, null, 2)}\n`, 'utf8');
    process.stdout.write(renderInspectionReport(inspection));
    return 0;
  }
  if (subcommand === 'plan') {
    const output = flagString(parsed.flags, 'output');
    if (output === undefined) throw invalidInput('vault-v2 plan requires --output');
    const plan = await planVaultMigration({
      vault,
      state,
      projectNames,
      outputDirectory: dirname(resolve(output)),
      clock
    });
    await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `vault-v2 manifest ${plan.manifest_sha256}: ${plan.moves.length} moves, ` +
        `${plan.history_copies.length} history copies, ${plan.blockers.length} blockers\n`
    );
    return 0;
  }
  if (subcommand === 'apply' || subcommand === 'resume') {
    const manifestPath = flagString(parsed.flags, 'manifest');
    if (manifestPath === undefined) throw invalidInput(`vault-v2 ${subcommand} requires --manifest`);
    const maintenance = flagBoolean(parsed.flags, 'maintenance');
    const receiptPath = flagString(parsed.flags, 'backup-receipt');
    const backupRoot = flagString(parsed.flags, 'backup-root');
    const partial = flagBoolean(parsed.flags, 'partial');
    const manifest = await readJsonFile(manifestPath, 'manifest');
    const backupReceipt = receiptPath === undefined ? undefined : await readJsonFile(receiptPath, 'backup receipt');
    const result =
      subcommand === 'apply'
        ? await applyVaultMigration(manifest, { maintenance, backupReceipt, backupRoot, partial, clock })
        : await resumeVaultMigration(manifest, { maintenance, backupReceipt, backupRoot, partial, clock });
    process.stdout.write(`vault-v2 ${result.status}: ${result.manifest_sha256}\n`);
    if (result.blocked.length > 0) {
      process.stdout.write(`blocked items (${result.blocked.length}):\n${formatMigrationBlockers(result.blocked)}\n`);
    }
    return 0;
  }
  if (subcommand === 'verify') {
    const manifestPath = flagString(parsed.flags, 'manifest');
    if (manifestPath === undefined) throw invalidInput('vault-v2 verify requires --manifest');
    const report = await verifyVaultMigration(await readJsonFile(manifestPath, 'manifest'));
    process.stdout.write(`vault-v2 verify ok=${report.ok} ${JSON.stringify(report.counts)}\n`);
    for (const failure of report.hash_failures) {
      process.stdout.write(`  failure ${failure.kind} ${failure.path}\n`);
    }
    for (const link of report.dangling_links) {
      process.stdout.write(`  dangling ${link.path} -> ${link.target}\n`);
    }
    for (const path of report.uuid_paths) process.stdout.write(`  uuid path ${path}\n`);
    return report.ok ? 0 : 1;
  }
  if (subcommand === 'rollback') {
    const manifestPath = flagString(parsed.flags, 'manifest');
    if (manifestPath === undefined) throw invalidInput('vault-v2 rollback requires --manifest');
    const maintenance = flagBoolean(parsed.flags, 'maintenance');
    const result = await rollbackVaultMigration(await readJsonFile(manifestPath, 'manifest'), {
      maintenance,
      clock
    });
    process.stdout.write(`vault-v2 rollback ${result.status}\n`);
    return 0;
  }
  throw invalidInput(`vault-v2 requires a subcommand\n${USAGE}`);
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
    case 'validate-archive':
      return runValidateArchive(parsed);
    case 'validate-store-links':
      return runValidateStoreLinks(parsed);
    case 'verify-backup':
      return runVerifyBackup(parsed);
    case 'auth':
      return runAuth(parsed);
    case 'vault-v2':
      return runVaultV2(parsed, env);
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
