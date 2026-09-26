import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { invalidInput, notFound } from '../errors.js';
import { withCollisionSuffix } from './paths.js';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface VaultFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  private resolve(path: string, allowMissing: boolean): string {
    let current = this.root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      let info;
      try {
        info = lstatSync(current);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        if (allowMissing) return join(this.root, ...path.split('/'));
        throw notFound(`note not found: ${path}`);
      }
      if (info.isSymbolicLink()) throw invalidInput(`path crosses a symbolic link: ${path}`);
    }
    return current;
  }

  list(): VaultFile[] {
    const files: VaultFile[] = [];
    const walk = (absolute: string, relative: string): void => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const childAbsolute = join(absolute, entry.name);
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(childAbsolute, childRelative);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const info = statSync(childAbsolute);
          files.push({ path: childRelative, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    walk(this.root, '');
    return files;
  }

  read(path: string): string {
    return readFileSync(this.resolve(path, false), 'utf8');
  }

  stat(path: string): { size: number; mtimeMs: number } {
    const info = statSync(this.resolve(path, false));
    return { size: info.size, mtimeMs: info.mtimeMs };
  }

  exists(path: string): boolean {
    try {
      this.resolve(path, false);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  write(path: string, raw: string): void {
    const target = this.resolve(path, true);
    const directory = dirname(target);
    mkdirSync(directory, { recursive: true });
    this.resolve(path, true);
    const temp = join(directory, `.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o644);
    try {
      writeSync(fd, raw);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  }

  remove(path: string): void {
    unlinkSync(this.resolve(path, false));
  }

  trash(path: string): string {
    const source = this.resolve(path, false);
    const stem = (path.split('/').at(-1) ?? path).replace(/\.md$/, '');
    const trashDir = join(this.root, '.trash');
    mkdirSync(trashDir, { recursive: true });
    const name = withCollisionSuffix(stem, (candidate) => existsSync(join(trashDir, `${candidate}.md`)));
    renameSync(source, join(trashDir, `${name}.md`));
    return `.trash/${name}.md`;
  }

  projectFolders(): string[] {
    const projects = join(this.root, 'Projects');
    if (!existsSync(projects)) return [];
    return readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  }
}
