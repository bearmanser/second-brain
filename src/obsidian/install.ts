import { readFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainError } from '../contracts/errors.js';

const ASSETS_DIRECTORY = fileURLToPath(new URL('./assets', import.meta.url));

export type ObsidianInstallMode = 'create-only';

export interface InstallObsidianAssetsInput {
  vault: string;
  mode: ObsidianInstallMode;
}

export interface InstallObsidianAssetsResult {
  created: string[];
  unchanged: string[];
  conflicts: string[];
}

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function errnoOf(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

async function walkAssets(directory: string, prefix: string, found: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkAssets(absolute, relative, found);
      continue;
    }
    if (entry.isFile()) found.push(relative);
  }
}

export async function listObsidianAssetPaths(): Promise<string[]> {
  const found: string[] = [];
  await walkAssets(ASSETS_DIRECTORY, '', found);
  found.sort();
  return found;
}

async function writeCreateOnly(absolute: string, contents: Buffer): Promise<'created' | 'unchanged' | 'conflict'> {
  try {
    await writeFile(absolute, contents, { flag: 'wx' });
    return 'created';
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') throw error;
    if (code !== 'EEXIST') return 'conflict';
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return 'conflict';
    const current = await readFile(absolute);
    return current.equals(contents) ? 'unchanged' : 'conflict';
  }
}

export async function installObsidianAssets(
  input: InstallObsidianAssetsInput
): Promise<InstallObsidianAssetsResult> {
  if (input === null || typeof input !== 'object') {
    throw invalidInput('an Obsidian install requires an input object');
  }
  if (input.mode !== 'create-only') {
    throw invalidInput('only the create-only Obsidian install mode is supported');
  }
  if (typeof input.vault !== 'string' || input.vault.length === 0) {
    throw invalidInput('an Obsidian install requires a vault directory');
  }
  const vaultRoot = resolve(input.vault);
  const created: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const relative of await listObsidianAssetPaths()) {
    const segments = relative.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) {
      throw invalidInput('an Obsidian asset path is unsafe');
    }
    const absolute = resolve(vaultRoot, ...segments);
    if (!isInside(vaultRoot, absolute)) throw invalidInput('an Obsidian asset path leaves the vault');
    const contents = await readFile(join(ASSETS_DIRECTORY, ...segments));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
      info = undefined;
    }
    if (info !== undefined) {
      if (info.isSymbolicLink() || !info.isFile()) {
        conflicts.push(relative);
        continue;
      }
      const current = await readFile(absolute);
      if (current.equals(contents)) unchanged.push(relative);
      else conflicts.push(relative);
      continue;
    }
    try {
      await mkdir(dirname(absolute), { recursive: true });
    } catch (error) {
      if (errnoOf(error) === 'ENOTDIR' || errnoOf(error) === 'EEXIST') {
        conflicts.push(relative);
        continue;
      }
      throw error;
    }
    const outcome = await writeCreateOnly(absolute, contents);
    if (outcome === 'created') created.push(relative);
    else if (outcome === 'unchanged') unchanged.push(relative);
    else conflicts.push(relative);
  }
  created.sort();
  unchanged.sort();
  conflicts.sort();
  return { created, unchanged, conflicts };
}
