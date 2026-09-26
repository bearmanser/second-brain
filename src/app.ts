import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { SearchIndex } from './index/search-index.js';
import { Sync } from './index/sync.js';
import { Notes } from './notes.js';
import { Projects } from './projects.js';
import { Store } from './store.js';
import { Vault } from './vault/vault.js';

export interface Brain {
  config: Config;
  vault: Vault;
  index: SearchIndex;
  store: Store;
  projects: Projects;
  sync: Sync;
  notes: Notes;
  close(): void;
}

const heldLocks = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function acquireLock(file: string): () => void {
  if (heldLocks.has(file)) throw new Error(`this process already holds ${file}`);
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    let pid = -1;
    try {
      pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid ?? -1;
    } catch {
      pid = -1;
    }
    if (pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(`another gateway instance (pid ${pid}) already holds ${file}`);
    }
    writeFileSync(file, JSON.stringify({ pid: process.pid }));
  }
  heldLocks.add(file);
  return () => {
    heldLocks.delete(file);
    rmSync(file, { force: true });
  };
}

export function openBrain(config: Config): Brain {
  mkdirSync(config.stateDir, { recursive: true });
  const release = acquireLock(join(config.stateDir, 'brain.lock'));
  const cleanups: (() => void)[] = [release];
  const closeAll = (): void => {
    while (cleanups.length > 0) cleanups.pop()?.();
  };
  try {
    const vault = new Vault(config.vaultDir);
    const index = SearchIndex.open(join(config.stateDir, 'index.db'));
    cleanups.push(() => index.close());
    const store = Store.open(join(config.stateDir, 'brain.db'));
    cleanups.push(() => store.close());
    const projects = new Projects(vault);
    const sync = new Sync(vault, index);
    const notes = new Notes({
      vault,
      index,
      sync,
      store,
      projects,
      now: () => new Date(),
      newId: () => randomUUID()
    });
    sync.scan();
    return { config, vault, index, store, projects, sync, notes, close: closeAll };
  } catch (error) {
    closeAll();
    throw error;
  }
}
