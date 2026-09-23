import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface InventoryRow {
  path: string;
  bytes: number;
  sha256: string;
}

function contained(root: string, path: string): string {
  const result = relative(root, path);
  if (result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error(`inventory path escapes root: ${path}`);
  }
  return result;
}

export async function inventoryTree(root: string): Promise<InventoryRow[]> {
  const absolute = resolve(root);
  let ancestor = absolute;
  while (true) {
    const stat = await lstat(ancestor);
    if (stat.isSymbolicLink()) throw new Error(`inventory rejects symbolic link: ${ancestor}`);
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!(await lstat(absolute)).isDirectory()) throw new Error('inventory root must be a directory');
  const rows: InventoryRow[] = [];

  async function walk(directory: string): Promise<void> {
    contained(absolute, directory);
    if (await realpath(directory) !== directory) {
      throw new Error(`inventory rejects symbolic link directory: ${directory}`);
    }
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const rel = contained(absolute, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`inventory rejects symbolic link: ${rel}`);
      if (stat.isDirectory()) {
        await walk(path);
      } else if (stat.isFile()) {
        if (await realpath(path) !== path) throw new Error(`inventory rejects symbolic link: ${rel}`);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            throw new Error(`inventory file changed while reading: ${rel}`);
          }
          const bytes = await file.readFile();
          const after = await file.stat();
          if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
            throw new Error(`inventory file changed while reading: ${rel}`);
          }
          rows.push({ path: rel.split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        } finally {
          await file.close();
        }
      } else {
        throw new Error(`inventory rejects unsupported file type: ${rel}`);
      }
    }
  }

  await walk(absolute);
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
