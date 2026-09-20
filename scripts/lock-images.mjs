import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configDirectory = join(repoRoot, 'config');

const digestPattern = /^([a-z0-9][a-z0-9._/-]*)@(sha256:[a-f0-9]{64})$/;
const defaultDiscoveryInputs = {
  node: 'node:24-alpine',
  backend: 'ghcr.io/basicmachines-co/basic-memory:latest'
};

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function parseArguments(argv) {
  const inputs = { ...defaultDiscoveryInputs };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--node') inputs.node = argv[index + 1];
    if (argv[index] === '--backend') inputs.backend = argv[index + 1];
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

const inputs = parseArguments(process.argv.slice(2));
const packageJson = readJson(join(repoRoot, 'package.json'));

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
  }
};

mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, 'dependency-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
writeFileSync(
  join(configDirectory, 'images.env'),
  `NODE_IMAGE=${nodeImage}\nBASIC_MEMORY_IMAGE=${basicMemoryImage}\n`,
  'utf8'
);

process.stdout.write(`Wrote config/dependency-lock.json and config/images.env for:\n${nodeImage}\n${basicMemoryImage}\n`);
