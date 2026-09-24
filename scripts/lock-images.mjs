import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const digestPattern = /^([a-z0-9][a-z0-9._/-]*)@(sha256:[a-f0-9]{64})$/;
const defaultDiscoveryInputs = {
  node: 'node:24-alpine',
  backend: 'ghcr.io/basicmachines-co/basic-memory:latest'
};

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function parseArguments(argv) {
  const inputs = { ...defaultDiscoveryInputs, configDirectory: join(repoRoot, 'config') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--node') inputs.node = argv[index + 1];
    if (argv[index] === '--backend') inputs.backend = argv[index + 1];
    if (argv[index] === '--config-dir') inputs.configDirectory = resolve(argv[index + 1]);
  }
  return inputs;
}

function repodigest(reference) {
  const output = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', reference]);
  const digests = JSON.parse(output);
  for (const digest of digests) {
    const match = digestPattern.exec(digest);
    if (match !== null) return `${match[1]}@${match[2]}`;
  }
  throw new Error(`No sha256 RepoDigest found for image: ${reference}`);
}

function imageLabel(reference, label) {
  return docker(['image', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, reference]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function preservedSections(path) {
  if (!existsSync(path)) return {};
  let previous;
  try {
    previous = readJson(path);
  } catch {
    throw new Error(`Refusing to overwrite unreadable lock: ${path}`);
  }
  if (previous.laya === undefined) return {};
  if (typeof previous.laya !== 'object' || previous.laya === null || Array.isArray(previous.laya)) {
    throw new Error(`Refusing to overwrite lock with a malformed laya section: ${path}`);
  }
  return { laya: previous.laya };
}

const inputs = parseArguments(process.argv.slice(2));
const configDirectory = inputs.configDirectory;
const packageJson = readJson(join(repoRoot, 'package.json'));
const preserved = preservedSections(join(configDirectory, 'dependency-lock.json'));

const nodeImage = repodigest(inputs.node);
const basicMemoryImage = repodigest(inputs.backend);

const lock = {
  schemaVersion: 1,
  runtime: {
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    engines: packageJson.engines.node
  },
  dependencies: packageJson.dependencies,
  devDependencies: packageJson.devDependencies,
  images: {
    NODE_IMAGE: nodeImage,
    BASIC_MEMORY_IMAGE: basicMemoryImage
  },
  backend: {
    name: 'basic-memory',
    imageVersion: imageLabel(inputs.backend, 'org.opencontainers.image.version'),
    revision: imageLabel(inputs.backend, 'org.opencontainers.image.revision'),
    transport: 'streamable-http',
    mcpPath: '/mcp',
    port: 8000
  },
  ...preserved
};

mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, 'dependency-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
writeFileSync(
  join(configDirectory, 'images.env'),
  `NODE_IMAGE=${nodeImage}\nBASIC_MEMORY_IMAGE=${basicMemoryImage}\n`,
  'utf8'
);

process.stdout.write(`Wrote ${join(configDirectory, 'dependency-lock.json')} and ${join(configDirectory, 'images.env')} for:\n${nodeImage}\n${basicMemoryImage}\n`);
