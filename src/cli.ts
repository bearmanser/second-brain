import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTokenDigest } from './config/load.js';
import { BrainError, isBrainError } from './contracts/errors.js';
import type { Clock, IdSource } from './core/types.js';
import { MutationCoordinator, InstanceLock, type BrainDeps } from './core/mutation.js';
import { installShutdownHandlers, main, resolveConfig } from './main.js';
import { APPLICATION_VERSION, SCHEMA_VERSION } from './mcp/tools.js';
import { installObsidianAssets } from './obsidian/install.js';
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
  describeRecoveryInput,
  recoverPending,
  requireRecoveryAuthorization,
  summariseRecovery,
  summariseRecoveryInput
} from './operations/recovery.js';
import {
  importLocalVault,
  readLocalBackupManifest,
  rebuildLocalIndex,
  restoreLocalBackup,
  takeLocalBackup,
  verifyLocalBackup
} from './operations/local-rebuild.js';
import { applyVaultMigration, formatMigrationBlockers, resumeVaultMigration } from './operations/vault-v2/apply.js';
import { planVaultMigration } from './operations/vault-v2/plan.js';
import { buildInspectionReport, renderInspectionReport } from './operations/vault-v2/report.js';
import { rollbackVaultMigration } from './operations/vault-v2/rollback.js';
import { verifyVaultMigration } from './operations/vault-v2/verify.js';
import { ScopeRegistry } from './projects/scope-registry.js';
import {
  authorRetrievalLabel,
  ConflictingLabelError,
  exportLabeledRetrieval,
  RETRIEVAL_LABEL_SOURCES,
  RETRIEVAL_LABEL_VALUES,
  StaleLabelError,
  type LabelTextLookup
} from './retrieval/feedback-export.js';
import { readEvaluationDataset } from './retrieval/evaluation-dataset.js';
import { retrievalQueryId } from './retrieval/evaluation.js';
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
  | 'rebuild-index'
  | 'backup-manifest'
  | 'local-backup'
  | 'local-restore'
  | 'verify-local-backup'
  | 'validate-archive'
  | 'validate-store-links'
  | 'verify-backup'
  | 'auth'
  | 'vault-v2'
  | 'obsidian'
  | 'feedback';

export const CLI_COMMANDS: readonly CliCommand[] = [
  'serve',
  'setup',
  'health',
  'recover',
  'recover-state',
  'rebuild-catalogue',
  'rebuild-index',
  'backup-manifest',
  'local-backup',
  'local-restore',
  'verify-local-backup',
  'validate-archive',
  'validate-store-links',
  'verify-backup',
  'auth',
  'vault-v2',
  'obsidian',
  'feedback'
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
  'commands: serve | setup | health | recover | recover-state | rebuild-catalogue | rebuild-index | backup-manifest | local-backup | local-restore | verify-local-backup | validate-archive | validate-store-links | verify-backup | auth | vault-v2 | obsidian | feedback'
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

async function runRebuildIndex(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const vault = flagString(parsed.flags, 'vault') ?? config.mounts.vault;
  const state = flagString(parsed.flags, 'state') ?? config.mounts.state;
  const lock = InstanceLock.acquire(state);
  try {
    const result = await rebuildLocalIndex({ vault, state });
    if (result.status === 'rebuilt') {
      process.stdout.write(
        `index rebuilt: ${result.counts.documents} documents, ${result.counts.chunks} chunks, ` +
          `fingerprint ${result.fingerprint}\n`
      );
      return 0;
    }
    process.stderr.write(
      `index rebuild degraded: ${result.reason}; previous index ` +
        `${result.previous_index === null ? 'absent' : 'retained'}\n`
    );
    return 1;
  } finally {
    lock.release();
  }
}

async function runLocalBackup(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const vault = flagString(parsed.flags, 'vault') ?? config.mounts.vault;
  const state = flagString(parsed.flags, 'state') ?? config.mounts.state;
  const destination = requiredFlag(
    parsed,
    'destination',
    'local-backup requires --destination for the backup directory'
  );
  const result = await takeLocalBackup({
    vault,
    state,
    destination,
    scope: flagBoolean(parsed.flags, 'vault-only') ? 'vault-only' : 'full',
    includeSearchIndex: flagBoolean(parsed.flags, 'include-search-index'),
    includeModelArtifacts: flagBoolean(parsed.flags, 'include-model-artifacts'),
    ...(flagString(parsed.flags, 'config') === undefined
      ? {}
      : { config: flagString(parsed.flags, 'config') as string }),
    secrets: flagList(parsed.flags, 'secret'),
    allowWriters: flagBoolean(parsed.flags, 'allow-live-writers')
  });
  process.stdout.write(
    `local backup: ${result.files} files (${result.manifest.scope}), manifest ${result.manifest_path}` +
      `${result.sensitive ? ', sensitive' : ''}\n`
  );
  return 0;
}

async function runLocalRestore(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveConfig(env);
  const vault = flagString(parsed.flags, 'vault') ?? config.mounts.vault;
  const state = flagString(parsed.flags, 'state') ?? config.mounts.state;
  const backupRoot = requiredFlag(parsed, 'backup', 'local-restore requires --backup for the backup directory');
  if (flagBoolean(parsed.flags, 'vault-only')) {
    const result = await importLocalVault({ backupRoot, vault });
    process.stdout.write(
      `local vault-only import: ${result.imported_files} files; ${summariseRecoveryInput(result.classification)}\n`
    );
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    return 0;
  }
  const result = await restoreLocalBackup({ backupRoot, vault, state });
  process.stdout.write(
    `local restore: ${result.restored_files} files; ${summariseRecoveryInput(result.classification)}\n`
  );
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  return 0;
}

async function runVerifyLocalBackup(parsed: ParsedArguments): Promise<number> {
  const manifestPath = requiredFlag(parsed, 'manifest', 'verify-local-backup requires --manifest');
  const root = flagString(parsed.flags, 'root');
  const manifest = await readLocalBackupManifest(manifestPath);
  const roots =
    root === undefined
      ? {
          ...(flagString(parsed.flags, 'vault') === undefined ? {} : { vault: flagString(parsed.flags, 'vault') as string }),
          ...(flagString(parsed.flags, 'state') === undefined ? {} : { state: flagString(parsed.flags, 'state') as string }),
          ...(flagString(parsed.flags, 'config') === undefined ? {} : { config: flagString(parsed.flags, 'config') as string }),
          ...(flagString(parsed.flags, 'secrets') === undefined ? {} : { secrets: flagString(parsed.flags, 'secrets') as string })
        }
      : { vault: join(root, 'vault'), state: join(root, 'state'), config: join(root, 'config'), secrets: join(root, 'secrets') };
  const report = await verifyLocalBackup(manifest, roots);
  process.stdout.write(
    `local backup verify: ok=${report.ok} integrity=${report.integrity_ok} ` +
      `durable=${report.durable_complete} scope=${report.scope} files=${report.counts.files}` +
      `${report.sensitive ? ' sensitive' : ''}; ${summariseRecoveryInput(report.classification)}\n`
  );
  for (const path of report.missing_files) process.stdout.write(`  missing ${path}\n`);
  for (const path of report.checksum_failures) process.stdout.write(`  checksum ${path}\n`);
  return report.ok ? 0 : 1;
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
  process.stdout.write(
    `${summariseRecoveryInput(
      describeRecoveryInput({
        vault: existsSync(config.mounts.vault),
        history: existsSync(join(config.mounts.state, 'history')),
        journal: existsSync(join(config.mounts.state, 'journal.db')),
        index: existsSync(join(config.mounts.state, 'index', 'search.sqlite'))
      })
    )}\n`
  );
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

async function runObsidian(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const subcommand = parsed.positionals[0];
  if (subcommand !== 'init') throw invalidInput(`obsidian requires the init subcommand\n${USAGE}`);
  if (!flagBoolean(parsed.flags, 'create-only')) {
    throw invalidInput('obsidian init requires --create-only');
  }
  const vault = flagString(parsed.flags, 'vault') ?? resolveConfig(env).mounts.vault;
  const result = await installObsidianAssets({ vault, mode: 'create-only' });
  process.stdout.write(
    `obsidian init: ${result.created.length} created, ${result.unchanged.length} unchanged, ` +
      `${result.conflicts.length} conflicts\n`
  );
  for (const path of result.created) process.stdout.write(`  created ${path}\n`);
  for (const path of result.conflicts) process.stdout.write(`  conflict ${path}\n`);
  return 0;
}

interface EvaluationDataset {
  dataset_id: string;
  sha256: string;
  lookup: LabelTextLookup;
  candidatesByQuery: Map<string, string[]>;
}

async function loadEvaluationDataset(path: string): Promise<EvaluationDataset> {
  const parsed = await readEvaluationDataset(path).catch(() => {
    throw invalidInput(`evaluation dataset cannot be read or parsed: ${path}`);
  });
  return {
    dataset_id: path,
    sha256: parsed.sha256,
    lookup: {
      queryText: (query_id) => parsed.queryText.get(query_id),
      noteText: (source_hash) => parsed.noteText.get(source_hash)
    },
    candidatesByQuery: parsed.candidatesByQuery
  };
}

function feedbackState(parsed: ParsedArguments, env: NodeJS.ProcessEnv): string {
  const state = flagString(parsed.flags, 'state');
  return state === undefined ? resolveConfig(env).mounts.state : resolve(state);
}

function feedbackVault(parsed: ParsedArguments, env: NodeJS.ProcessEnv): string {
  const vault = flagString(parsed.flags, 'vault');
  return vault === undefined ? resolveConfig(env).mounts.vault : resolve(vault);
}

function requiredFlag(parsed: ParsedArguments, name: string, message: string): string {
  const value = flagString(parsed.flags, name);
  if (value === undefined) throw invalidInput(message);
  return value;
}

async function runFeedbackExport(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const output = requiredFlag(parsed, 'output', 'feedback export requires --output');
  const splitSeed = flagNumber(parsed.flags, 'split-seed');
  if (splitSeed === undefined) throw invalidInput('feedback export requires --split-seed');
  const includeText = flagBoolean(parsed.flags, 'include-text');
  const state = feedbackState(parsed, env);
  const datasetPath =
    flagString(parsed.flags, 'dataset') ?? join(state, 'evaluations', 'retrieval.jsonl');
  const lock = InstanceLock.acquire(state);
  let journal: Journal | undefined;
  try {
    journal = Journal.open(join(state, 'journal.db'), { requireExisting: true });
    let dataset: EvaluationDataset | undefined;
    try {
      dataset = await loadEvaluationDataset(datasetPath);
    } catch (error) {
      if (includeText) throw error;
    }
    const labels = journal.listRetrievalLabels();
    const modelFingerprints = [
      ...new Set(
        labels
          .map((entry) => entry.model_fingerprint)
          .filter((value): value is string => value !== undefined)
      )
    ];
    const questionVersions = [
      ...new Set(
        labels
          .map((entry) => entry.question_version)
          .filter((value): value is string => value !== undefined)
      )
    ];
    const result = await exportLabeledRetrieval({
      output,
      includeText,
      splitSeed,
      labels,
      modelFingerprints,
      questionVersions,
      ...(dataset === undefined
        ? {}
        : {
            datasetId: dataset.dataset_id,
            datasetSha256: dataset.sha256,
            textLookup: dataset.lookup,
            candidatesByQuery: dataset.candidatesByQuery
          })
    });
    process.stdout.write(
      `feedback export: ${result.counts.exported} labels exported ` +
        `(${result.counts.excluded_not_approved} not approved, ${result.counts.excluded_voided} voided, ` +
        `${result.counts.excluded_missing_text} missing text, ${result.counts.unjudged} unjudged); ` +
        `manifest ${result.manifest.manifest_hash}\n`
    );
    return 0;
  } finally {
    journal?.close();
    lock.release();
  }
}

async function runFeedbackLabel(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const queryIdFlag = flagString(parsed.flags, 'query-id');
  const queryText = flagString(parsed.flags, 'query');
  const phase = flagString(parsed.flags, 'phase');
  const query_id =
    queryIdFlag ??
    (queryText === undefined
      ? undefined
      : retrievalQueryId({ query: queryText, ...(phase === undefined ? {} : { phase }) }));
  if (query_id === undefined) throw invalidInput('feedback label requires --query-id or --query');
  const sourceType = requiredFlag(parsed, 'source-type', 'feedback label requires --source-type');
  if (!(RETRIEVAL_LABEL_SOURCES as readonly string[]).includes(sourceType)) {
    throw invalidInput(
      `feedback label --source-type must be one of ${RETRIEVAL_LABEL_SOURCES.join(', ')}`
    );
  }
  const value = flagNumber(parsed.flags, 'label');
  if (value === undefined || !RETRIEVAL_LABEL_VALUES.includes(value as 0 | 1 | 2)) {
    throw invalidInput('feedback label --label must be 0, 1, or 2');
  }
  const sourceHash = requiredFlag(parsed, 'source-hash', 'feedback label requires --source-hash');
  if (!/^[a-f0-9]{64}$/i.test(sourceHash)) {
    throw invalidInput('feedback label --source-hash must be a 64 character hexadecimal digest');
  }
  const logicalId = flagString(parsed.flags, 'logical-id');
  const path = flagString(parsed.flags, 'path');
  if (path === undefined) {
    throw invalidInput('feedback label requires --path to verify the current source version');
  }
  const revisionId = flagString(parsed.flags, 'revision-id');
  const vault = feedbackVault(parsed, env);
  const absoluteVault = resolve(vault);
  const absolutePath = resolve(absoluteVault, path);
  if (absolutePath !== absoluteVault && !absolutePath.startsWith(`${absoluteVault}${sep}`)) {
    throw invalidInput('feedback label --path must stay inside the vault');
  }
  let raw: Buffer;
  try {
    raw = await readFile(absolutePath);
  } catch {
    throw invalidInput(`feedback label cannot read the source at ${path}`);
  }
  const currentSourceHash = createHash('sha256').update(raw).digest('hex');
  const candidatePosition = flagNumber(parsed.flags, 'candidate-position');
  const state = feedbackState(parsed, env);
  const lock = InstanceLock.acquire(state);
  let journal: Journal | undefined;
  try {
    journal = Journal.open(join(state, 'journal.db'));
    const result = authorRetrievalLabel(journal, {
      trace_id: flagString(parsed.flags, 'trace-id') ?? 'manual',
      query_id,
      source_type: sourceType as (typeof RETRIEVAL_LABEL_SOURCES)[number],
      source_hash: sourceHash.toLowerCase(),
      label: value as 0 | 1 | 2,
      ...(logicalId === undefined ? {} : { logical_id: logicalId }),
      ...(path === undefined ? {} : { path }),
      ...(revisionId === undefined ? {} : { revision_id: revisionId }),
      ...(flagString(parsed.flags, 'question-id') === undefined
        ? {}
        : { question_id: flagString(parsed.flags, 'question-id') as string }),
      ...(flagString(parsed.flags, 'question-version') === undefined
        ? {}
        : { question_version: flagString(parsed.flags, 'question-version') as string }),
      ...(flagString(parsed.flags, 'model-fingerprint') === undefined
        ? {}
        : { model_fingerprint: flagString(parsed.flags, 'model-fingerprint') as string }),
      ...(candidatePosition === undefined ? {} : { candidate_position: candidatePosition }),
      ...(flagString(parsed.flags, 'rubric-version') === undefined
        ? {}
        : { rubric_version: flagString(parsed.flags, 'rubric-version') as string }),
      ...(flagString(parsed.flags, 'evidence-ref') === undefined
        ? {}
        : { evidence_ref: flagString(parsed.flags, 'evidence-ref') as string }),
      ...(flagString(parsed.flags, 'notes') === undefined
        ? {}
        : { notes: flagString(parsed.flags, 'notes') as string }),
      ...(flagString(parsed.flags, 'query-family') === undefined
        ? {}
        : { query_family: flagString(parsed.flags, 'query-family') as string }),
      ...(flagString(parsed.flags, 'source-family') === undefined
        ? {}
        : { source_family: flagString(parsed.flags, 'source-family') as string }),
      ...(flagBoolean(parsed.flags, 'approve') ? { approved: true } : {}),
      current: { source_hash: currentSourceHash }
    });
    process.stdout.write(
      `feedback label: ${result.created ? 'created' : 'replay'} ${result.label_id}\n`
    );
    return 0;
  } catch (error) {
    if (error instanceof StaleLabelError || error instanceof ConflictingLabelError) {
      throw invalidInput(error.message);
    }
    throw error;
  } finally {
    journal?.close();
    lock.release();
  }
}

async function runFeedbackVoid(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const labelId = requiredFlag(parsed, 'label-id', 'feedback void requires --label-id');
  const state = feedbackState(parsed, env);
  const lock = InstanceLock.acquire(state);
  let journal: Journal | undefined;
  try {
    journal = Journal.open(join(state, 'journal.db'), { requireExisting: true });
    const voidedAt = flagString(parsed.flags, 'voided-at');
    const changed = journal.voidRetrievalLabel(labelId, voidedAt);
    process.stdout.write(`feedback void: ${changed} label(s) voided\n`);
    return changed === 1 ? 0 : 1;
  } finally {
    journal?.close();
    lock.release();
  }
}

async function runFeedback(parsed: ParsedArguments, env: NodeJS.ProcessEnv): Promise<number> {
  const subcommand = parsed.positionals[0];
  if (subcommand === 'export') return runFeedbackExport(parsed, env);
  if (subcommand === 'label') return runFeedbackLabel(parsed, env);
  if (subcommand === 'void') return runFeedbackVoid(parsed, env);
  throw invalidInput(`feedback requires the export, label, or void subcommand\n${USAGE}`);
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
    case 'rebuild-index':
      return runRebuildIndex(parsed, env);
    case 'backup-manifest':
      return runBackupManifest(parsed);
    case 'local-backup':
      return runLocalBackup(parsed, env);
    case 'local-restore':
      return runLocalRestore(parsed, env);
    case 'verify-local-backup':
      return runVerifyLocalBackup(parsed);
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
    case 'obsidian':
      return runObsidian(parsed, env);
    case 'feedback':
      return runFeedback(parsed, env);
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
