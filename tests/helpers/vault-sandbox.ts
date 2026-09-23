import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function vaultSandbox(): Promise<{
  vault: string;
  state: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'second-brain-vault-v2-'));
  try {
    const vault = join(root, 'vault');
    const state = join(root, 'state');
    await mkdir(vault);
    await mkdir(state);
    return { vault, state, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
