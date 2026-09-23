import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export interface InventoryRow {
  path: string;
  bytes: number;
  sha256: string;
}

const FD_DIRECTORY = '/proc/self/fd';
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function hasErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function descriptorPath(handle: FileHandle): string {
  return `${FD_DIRECTORY}/${handle.fd}`;
}

function assertDescriptorSupport(): void {
  if (
    typeof constants.O_DIRECTORY !== 'number' ||
    typeof constants.O_NOFOLLOW !== 'number' ||
    typeof constants.O_NONBLOCK !== 'number'
  ) {
    throw new Error('inventory requires no-follow directory descriptors, which this platform lacks');
  }
}

function childPath(parent: FileHandle, name: string): string {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`inventory rejects unsafe entry name: ${JSON.stringify(name)}`);
  }
  return `${descriptorPath(parent)}/${name}`;
}

async function assertPinnedProcfs(): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(FD_DIRECTORY, DIRECTORY_FLAGS);
  } catch {
    throw new Error('inventory requires /proc/self/fd for pinned descriptor containment');
  }
  try {
    await readdir(FD_DIRECTORY);
  } catch {
    throw new Error('inventory requires an enumerable /proc/self/fd for pinned descriptor containment');
  } finally {
    await handle.close();
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function openChildDirectory(parent: FileHandle, name: string, relative: string): Promise<FileHandle> {
  const path = childPath(parent, name);
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    if (hasErrno(error, 'ELOOP')) throw new Error(`inventory rejects symbolic link: ${relative}`);
    if (hasErrno(error, 'ENOTDIR')) {
      if (await isSymbolicLink(path)) throw new Error(`inventory rejects symbolic link: ${relative}`);
      throw new Error(`inventory root is not a directory: ${relative}`);
    }
    if (hasErrno(error, 'ENOENT')) throw new Error(`inventory root does not exist: ${relative}`);
    throw new Error(`inventory cannot open ${relative}: ${describe(error)}`);
  }
}

async function openRootChain(absolute: string, handles: FileHandle[]): Promise<FileHandle> {
  const root = await open('/', DIRECTORY_FLAGS);
  handles.push(root);
  let current = root;
  const parts = absolute.split(sep).filter((segment) => segment.length > 0);
  const prefix: string[] = [];
  for (const name of parts) {
    prefix.push(name);
    const next = await openChildDirectory(current, name, `/${prefix.join('/')}`);
    handles.push(next);
    current = next;
  }
  return current;
}

async function entriesOf(handle: FileHandle): Promise<string[]> {
  try {
    return (await readdir(descriptorPath(handle))).sort();
  } catch (error) {
    if (hasErrno(error, 'ENOENT') || hasErrno(error, 'ENOTDIR') || hasErrno(error, 'EACCES')) {
      throw new Error(
        `inventory cannot enumerate a pinned directory descriptor because /proc/self/fd is unavailable or unusable: ${describe(error)}`
      );
    }
    throw error;
  }
}

async function readLeaf(
  parent: FileHandle,
  name: string,
  relative: string,
  rows: InventoryRow[]
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(childPath(parent, name), FILE_FLAGS);
  } catch (error) {
    if (hasErrno(error, 'ELOOP')) throw new Error(`inventory rejects symbolic link: ${relative}`);
    if (hasErrno(error, 'ENOENT')) throw new Error(`inventory path changed while reading: ${relative}`);
    throw new Error(`inventory cannot open ${relative}: ${describe(error)}`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`inventory rejects unsupported file type: ${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`inventory file changed while reading: ${relative}`);
    }
    rows.push({
      path: relative,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  } finally {
    await handle.close();
  }
}

async function walk(directory: FileHandle, prefix: string, rows: InventoryRow[]): Promise<void> {
  for (const name of await entriesOf(directory)) {
    const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
    let childDirectory: FileHandle | undefined;
    try {
      childDirectory = await open(childPath(directory, name), DIRECTORY_FLAGS);
    } catch (error) {
      if (hasErrno(error, 'ELOOP')) throw new Error(`inventory rejects symbolic link: ${relative}`);
      if (hasErrno(error, 'ENOTDIR')) {
        await readLeaf(directory, name, relative, rows);
        continue;
      }
      if (hasErrno(error, 'ENOENT')) throw new Error(`inventory path changed while reading: ${relative}`);
      throw new Error(`inventory cannot inspect ${relative}: ${describe(error)}`);
    }
    try {
      await walk(childDirectory, relative, rows);
    } finally {
      await childDirectory.close();
    }
  }
}

export async function inventoryTree(root: string): Promise<InventoryRow[]> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('inventory root must be a non-empty path');
  }
  assertDescriptorSupport();
  const absolute = resolve(root);
  if (!isAbsolute(absolute)) throw new Error('inventory root must resolve to an absolute path');
  await assertPinnedProcfs();
  const handles: FileHandle[] = [];
  const rows: InventoryRow[] = [];
  try {
    const rootHandle = await openRootChain(absolute, handles);
    await walk(rootHandle, '', rows);
    return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } finally {
    for (let index = handles.length - 1; index >= 0; index -= 1) {
      try {
        await handles[index].close();
      } catch {
        continue;
      }
    }
  }
}
