import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import manifest from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };

const fsProbe = vi.hoisted(() => ({
  beforeOpen: null as null | ((event: { path: string; flags: unknown }) => void | Promise<void>),
  afterOpen:
    null as
      | null
      | ((event: { path: string; flags: unknown; handle: { fd: number } }) => void | Promise<void>),
  beforeReaddir: null as null | ((event: { path: string }) => void | Promise<void>),
  opened: [] as string[],
  listed: [] as string[],
  reset(): void {
    this.beforeOpen = null;
    this.afterOpen = null;
    this.beforeReaddir = null;
    this.opened.length = 0;
    this.listed.length = 0;
  }
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const actualOpen = actual.open as unknown as (...args: unknown[]) => Promise<{ fd: number }>;
  const actualReaddir = actual.readdir as unknown as (...args: unknown[]) => Promise<string[]>;
  return {
    ...actual,
    open: async (path: unknown, flags?: unknown, mode?: unknown) => {
      const record = { path: typeof path === 'string' ? path : String(path), flags, handle: { fd: -1 } };
      fsProbe.opened.push(record.path);
      if (fsProbe.beforeOpen !== null) await fsProbe.beforeOpen(record);
      const handle = await actualOpen(path, flags, mode);
      record.handle = handle;
      if (fsProbe.afterOpen !== null) await fsProbe.afterOpen(record);
      return handle;
    },
    readdir: async (path: unknown, options?: unknown) => {
      const record = { path: typeof path === 'string' ? path : String(path) };
      fsProbe.listed.push(record.path);
      if (fsProbe.beforeReaddir !== null) await fsProbe.beforeReaddir(record);
      return actualReaddir(path, options);
    }
  };
});

const { inventoryTree } = await import('../../src/operations/vault-v2/inventory.js');
const { decodeRevision, payloadHash } = await import('../../src/notes/codec.js');
const { RevisionCatalogue } = await import('../../src/notes/catalogue.js');
const { FileVault } = await import('../../src/storage/vault.js');
const { vaultSandbox } = await import('../helpers/vault-sandbox.js');

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}

interface ManifestRevision {
  path: string;
  id: string;
  revision_id: string;
  status: string;
  parent_revision_ids: string[];
  approved: boolean;
  approval_payload_hash?: string;
}

interface ManifestCase {
  version: number;
  files: ManifestFile[];
  revisions: ManifestRevision[];
  logical_heads: Array<{ id: string; heads: string[]; resolution: string }>;
}

const fixture = manifest as unknown as ManifestCase;

afterEach(() => fsProbe.reset());

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function materialize(vault: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const entry of fixture.files) {
    const bytes = Buffer.from(entry.base64, 'base64');
    expect(bytes.length).toBe(entry.bytes);
    expect(digest(bytes)).toBe(entry.sha256);
    const destination = join(vault, entry.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
    hashes.set(entry.path, entry.sha256);
  }
  return hashes;
}

function clearProbe(): void {
  fsProbe.opened.length = 0;
  fsProbe.listed.length = 0;
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: synthetic failure`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('inventory does not rewrite source bytes', async () => {
  const s = await vaultSandbox();
  try {
    const path = join(s.vault, 'Legacy note.md');
    const raw = Buffer.from('# Legacy note\r\n\r\nKeep these bytes.\r\n');
    await writeFile(path, raw);
    const rows = await inventoryTree(s.vault);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('Legacy note.md');
    expect(rows[0].bytes).toBe(raw.length);
    expect(rows[0].sha256).toBe(digest(raw));
    expect(await readFile(path)).toEqual(raw);
  } finally {
    await s.dispose();
  }
});

test('inventory orders paths deterministically and includes non-retrieval files', async () => {
  const s = await vaultSandbox();
  try {
    await mkdir(join(s.vault, 'Attachments'));
    await mkdir(join(s.vault, '.obsidian'));
    await writeFile(join(s.vault, 'z.md'), 'last');
    await writeFile(join(s.vault, 'Attachments', 'b.png'), Buffer.from([0, 255]));
    await writeFile(join(s.vault, '.obsidian', 'settings.json'), '{}');
    await writeFile(join(s.vault, 'Ærlig.md'), 'utf8');
    const first = await inventoryTree(s.vault);
    expect(first.map((row) => row.path)).toEqual([
      '.obsidian/settings.json',
      'Attachments/b.png',
      'z.md',
      'Ærlig.md'
    ]);
    expect(await inventoryTree(s.vault)).toEqual(first);
  } finally {
    await s.dispose();
  }
});

test('inventory rejects symlink escapes, including directory links and the root', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await writeFile(join(outside, 'secret'), 'outside');
    await symlink(outside, join(s.vault, 'escape'));
    await expect(inventoryTree(s.vault)).rejects.toThrow(/symbolic link/i);
    await expect(inventoryTree(join(s.vault, 'escape'))).rejects.toThrow(/symbolic link/i);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('inventory rejects a file symlink and a symlinked ancestor of the supplied root', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await writeFile(join(outside, 'secret.md'), 'outside');
    await symlink(join(outside, 'secret.md'), join(s.vault, 'link.md'));
    await expect(inventoryTree(s.vault)).rejects.toThrow(/symbolic link/i);

    await rm(join(s.vault, 'link.md'));
    await symlink(outside, join(s.vault, 'ancestor'));
    await expect(inventoryTree(join(s.vault, 'ancestor'))).rejects.toThrow(/symbolic link/i);
    await expect(inventoryTree(join(s.vault, 'ancestor', 'nested'))).rejects.toThrow(/symbolic link/i);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('sandbox disposal leaves a sibling sandbox intact', async () => {
  const first = await vaultSandbox();
  const second = await vaultSandbox();
  try {
    await writeFile(join(second.state, 'journal'), 'untouched');
    await first.dispose();
    expect(await readFile(join(second.state, 'journal'), 'utf8')).toBe('untouched');
  } finally {
    await second.dispose();
  }
});

test('frozen V1 corpus inventories exact bytes and records unresolved logical heads', async () => {
  const s = await vaultSandbox();
  try {
    const hashes = await materialize(s.vault);
    expect(await inventoryTree(s.vault)).toEqual(
      fixture.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    );
    for (const row of fixture.revisions) {
      const raw = await readFile(join(s.vault, row.path), 'utf8');
      const revision = decodeRevision(raw);
      expect(revision.id).toBe(row.id);
      expect(revision.revision_id).toBe(row.revision_id);
      expect(revision.parents.map((parent) => parent.revision_id)).toEqual(row.parent_revision_ids);
      expect(revision.status).toBe(row.status);
      if (row.approved) {
        expect(revision.approval).toBeDefined();
        expect(revision.approval?.payload_hash).toBe(payloadHash(revision));
        expect(revision.approval?.payload_hash).toBe(row.approval_payload_hash);
      } else {
        expect(revision.approval).toBeUndefined();
      }
      for (const parent of revision.parents) {
        const parentRow = fixture.revisions.find(
          (candidate) => candidate.revision_id === parent.revision_id
        );
        expect(parentRow).toBeDefined();
        expect(parent.raw_hash).toBe(hashes.get(parentRow!.path));
      }
    }
    expect(fixture.logical_heads[0].heads).toHaveLength(2);
    expect(fixture.logical_heads[0].resolution).toMatch(/conflict/);
  } finally {
    await s.dispose();
  }
});

test('frozen approved preference passes the real V1 approval logic with provenance', async () => {
  const s = await vaultSandbox();
  const scope = {
    id: 'freellmapi',
    backend_project: 'freellmapi',
    relative_root: 'Projects/freellmapi',
    repository_aliases: [] as string[]
  };
  const vault = new FileVault(s.vault, [scope]);
  const catalogue = RevisionCatalogue.open(join(s.state, 'catalogue.sqlite'), {
    vault,
    scopes: [scope],
    approval_provenance: { verify: () => true }
  });
  try {
    await materialize(s.vault);
    await catalogue.reconcile(scope.id);
    const preference = fixture.revisions.find((row) => row.approved);
    expect(preference).toBeDefined();
    const head = await catalogue.get(scope.id, preference!.id);
    expect(head.state).toBe('ready');
    expect(catalogue.approvalIsValid(head.revision)).toBe(true);
    expect(head.revision.approval?.payload_hash).toBe(payloadHash(head.revision));

    const denied = RevisionCatalogue.open(join(s.state, 'denied.sqlite'), {
      vault,
      scopes: [scope],
      approval_provenance: { verify: () => false }
    });
    try {
      await denied.reconcile(scope.id);
      const deniedHead = await denied.get(scope.id, preference!.id);
      expect(denied.approvalIsValid(deniedHead.revision)).toBe(false);
    } finally {
      denied.close();
    }
  } finally {
    catalogue.close();
    await s.dispose();
  }
});

test('a directory swapped for an outside symlink before directory open is rejected', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await mkdir(join(s.vault, 'swap'));
    await writeFile(join(s.vault, 'swap', 'keep.md'), 'inside');
    await writeFile(join(outside, 'outside-secret.md'), 'outside');
    let swapped = false;
    fsProbe.beforeOpen = async ({ path, flags }) => {
      if (swapped || !path.endsWith('/swap')) return;
      if ((Number(flags) & constants.O_DIRECTORY) === 0) return;
      swapped = true;
      await rm(join(s.vault, 'swap'), { recursive: true });
      await symlink(outside, join(s.vault, 'swap'));
    };
    clearProbe();
    await expect(inventoryTree(s.vault)).rejects.toThrow(/symbolic link/i);
    expect(swapped).toBe(true);
    expect(fsProbe.opened.some((path) => path.endsWith('/swap'))).toBe(true);
    expect(fsProbe.opened.some((path) => path.includes('outside-secret'))).toBe(false);
    expect(fsProbe.listed.some((path) => path.includes('outside-secret'))).toBe(false);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('a file replaced with an outside symlink immediately before leaf open is rejected', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await writeFile(join(s.vault, 'note.md'), 'inside');
    await writeFile(join(outside, 'outside-secret.md'), 'outside');
    let replaced = false;
    fsProbe.beforeOpen = async ({ path, flags }) => {
      if (replaced || !path.endsWith('/note.md')) return;
      if ((Number(flags) & constants.O_DIRECTORY) !== 0) return;
      replaced = true;
      await rm(join(s.vault, 'note.md'));
      await symlink(join(outside, 'outside-secret.md'), join(s.vault, 'note.md'));
    };
    clearProbe();
    await expect(inventoryTree(s.vault)).rejects.toThrow(/symbolic link/i);
    expect(replaced).toBe(true);
    expect(fsProbe.opened.filter((path) => path.endsWith('/note.md'))).toHaveLength(2);
    expect(fsProbe.opened.some((path) => path.includes('outside-secret'))).toBe(false);
    expect(fsProbe.listed.some((path) => path.includes('outside-secret'))).toBe(false);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('a directory renamed after acquisition and replaced by an outside symlink still enumerates the acquired object', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await mkdir(join(s.vault, 'swap'));
    const inside = Buffer.from('keep these bytes');
    await writeFile(join(s.vault, 'swap', 'keep.md'), inside);
    await writeFile(join(outside, 'outside-secret.md'), 'outside');
    let descriptor = -1;
    let swapped = false;
    fsProbe.afterOpen = ({ path, handle }) => {
      if (descriptor === -1 && path.endsWith('/swap')) descriptor = handle.fd;
    };
    fsProbe.beforeReaddir = async ({ path }) => {
      if (swapped || descriptor === -1 || path !== `/proc/self/fd/${descriptor}`) return;
      swapped = true;
      await rename(join(s.vault, 'swap'), join(s.vault, 'moved'));
      await symlink(outside, join(s.vault, 'swap'));
    };
    clearProbe();
    const rows = await inventoryTree(s.vault);
    expect(swapped).toBe(true);
    expect(rows).toEqual([{ path: 'swap/keep.md', bytes: inside.length, sha256: digest(inside) }]);
    expect(fsProbe.listed).toContain(`/proc/self/fd/${descriptor}`);
    expect(fsProbe.opened.some((path) => path.endsWith('/keep.md'))).toBe(true);
    expect(fsProbe.opened.some((path) => path.includes('outside-secret'))).toBe(false);
    expect(fsProbe.listed.some((path) => path.includes('outside-secret'))).toBe(false);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('a root ancestor replaced after acquisition cannot redirect traversal outside', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    const anchor = join(s.vault, 'anchor');
    const root = join(anchor, 'root');
    await mkdir(root, { recursive: true });
    const inside = Buffer.from('root bytes');
    await writeFile(join(root, 'note.md'), inside);
    await writeFile(join(outside, 'outside-secret.md'), 'outside');
    let descriptor = -1;
    let swapped = false;
    fsProbe.afterOpen = ({ path, handle }) => {
      if (descriptor === -1 && path.endsWith('/root')) descriptor = handle.fd;
    };
    fsProbe.beforeReaddir = async ({ path }) => {
      if (swapped || descriptor === -1 || path !== `/proc/self/fd/${descriptor}`) return;
      swapped = true;
      await rename(anchor, `${anchor}-moved`);
      await symlink(outside, anchor);
    };
    clearProbe();
    const rows = await inventoryTree(root);
    expect(swapped).toBe(true);
    expect(rows).toEqual([{ path: 'note.md', bytes: inside.length, sha256: digest(inside) }]);
    expect(fsProbe.listed).toContain(`/proc/self/fd/${descriptor}`);
    expect(fsProbe.opened.some((path) => path.includes('outside-secret'))).toBe(false);
    expect(fsProbe.listed.some((path) => path.includes('outside-secret'))).toBe(false);
  } finally {
    await s.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('an unavailable /proc/self/fd fails closed before acquiring descriptors', async () => {
  const s = await vaultSandbox();
  try {
    await writeFile(join(s.vault, 'note.md'), 'x');
    let openedRoot = false;
    fsProbe.beforeOpen = ({ path }) => {
      if (path === '/proc/self/fd') throw errno('ENOENT');
      if (path === '/') openedRoot = true;
    };
    const before = readdirSync('/proc/self/fd').length;
    await expect(inventoryTree(s.vault)).rejects.toThrow(/proc\/self\/fd/);
    expect(openedRoot).toBe(false);
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before);
  } finally {
    await s.dispose();
  }
});

test('an unusable /proc/self/fd mid-traversal fails closed without leaking descriptors', async () => {
  const s = await vaultSandbox();
  try {
    await writeFile(join(s.vault, 'note.md'), 'x');
    fsProbe.beforeReaddir = ({ path }) => {
      if (/^\/proc\/self\/fd\/\d+$/.test(path)) throw errno('ENOENT');
    };
    const before = readdirSync('/proc/self/fd').length;
    await expect(inventoryTree(s.vault)).rejects.toThrow(/unavailable or unusable/);
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before);
  } finally {
    await s.dispose();
  }
});
