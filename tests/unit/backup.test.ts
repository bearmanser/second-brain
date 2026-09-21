import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  assertCompatibleStateSchema,
  buildManifest,
  collectManifestFiles,
  resolveBackupPath,
  validateBackupArchive,
  validateManifest,
  validateStoreLinks,
  verifyManifest,
  type BackupManifest,
  type VersionManifest
} from '../../src/operations/backup.js';
import { makeBackupFixture } from '../support/harness.js';

const versions: VersionManifest = {
  application: 'second-brain',
  schema: 1,
  images: { brain: `second-brain@sha256:${'a'.repeat(64)}` },
  stores: ['vault', 'brain-state'],
  sensitive: false,
  created_at: '2026-09-20T00:00:00.000Z'
};

test('refuses a restore when a stored file hash no longer matches', async () => {
  const fixture = await makeBackupFixture();
  await fixture.corrupt('vault/Projects/freellmapi/Notes/test.md');
  await expect(verifyManifest(fixture.root, fixture.manifest))
    .rejects.toThrow(/checksum/);
  await fixture.close();
});

test('verifies a manifest when every stored file matches', async () => {
  const fixture = await makeBackupFixture();
  await expect(verifyManifest(fixture.root, fixture.manifest)).resolves.toBeUndefined();
  await fixture.close();
});

test('records format version, creation time, versions, stores and file entries', () => {
  const files = [
    {
      path: 'vault/note.md',
      size: 3,
      sha256: createHash('sha256').update('abc').digest('hex')
    }
  ];
  const manifest = buildManifest(files, versions);
  expect(manifest.format_version).toBe(BACKUP_FORMAT_VERSION);
  expect(manifest.created_at).toBe('2026-09-20T00:00:00.000Z');
  expect(manifest.software).toEqual({
    application: 'second-brain',
    schema: 1,
    images: versions.images
  });
  expect(manifest.stores).toEqual(['vault', 'brain-state']);
  expect(manifest.sensitive).toBe(false);
  expect(manifest.files).toEqual(files);
});

test('records the Compose-key to actual-volume-name mapping', () => {
  const manifest = buildManifest([], {
    ...versions,
    volumes: { 'brain-state': 'second-brain_brain-state' }
  });
  expect(manifest.volumes).toEqual({ 'brain-state': 'second-brain_brain-state' });
  expect(validateManifest(manifest).volumes).toEqual({
    'brain-state': 'second-brain_brain-state'
  });
  expect(() =>
    buildManifest([], { ...versions, volumes: { '../escape': 'x' } })
  ).not.toThrow();
  expect(() => validateManifest(buildManifest([], { ...versions, volumes: { '../escape': 'x' } }))).toThrow(
    /traversal/
  );
});

test('rejects manifests with invalid sizes, hashes, times, stores, images, or sensitivity', () => {
  const base = buildManifest([], versions);
  const sha = createHash('sha256').update('abc').digest('hex');
  const cases: [string, (manifest: BackupManifest) => void, RegExp][] = [
    [
      'size',
      (manifest) => {
        manifest.files = [{ path: 'a.md', size: -1, sha256: sha }];
      },
      /size/
    ],
    [
      'fractional size',
      (manifest) => {
        manifest.files = [{ path: 'a.md', size: 1.5, sha256: sha }];
      },
      /size/
    ],
    [
      'sha256',
      (manifest) => {
        manifest.files = [{ path: 'a.md', size: 1, sha256: 'short' }];
      },
      /sha256/
    ],
    [
      'created_at',
      (manifest) => {
        (manifest as { created_at: unknown }).created_at = 'yesterday';
      },
      /created_at/
    ],
    [
      'application',
      (manifest) => {
        (manifest.software as { application: unknown }).application = '';
      },
      /application/
    ],
    [
      'schema',
      (manifest) => {
        (manifest.software as { schema: unknown }).schema = 0;
      },
      /schema/
    ],
    [
      'image',
      (manifest) => {
        manifest.software.images = { brain: '' };
      },
      /images/
    ],
    [
      'store',
      (manifest) => {
        manifest.stores = [''];
      },
      /stores/
    ],
    [
      'sensitive',
      (manifest) => {
        (manifest as { sensitive: unknown }).sensitive = 'yes';
      },
      /sensitive/
    ]
  ];
  for (const [label, mutate, pattern] of cases) {
    const manifest = JSON.parse(JSON.stringify(base)) as BackupManifest;
    mutate(manifest);
    expect(() => validateManifest(manifest), label).toThrow(pattern);
  }
});

test('defaults the creation time and treats a manifest as not sensitive', () => {
  const manifest = buildManifest([], {
    application: 'second-brain',
    schema: 1,
    images: {}
  });
  expect(Number.isFinite(Date.parse(manifest.created_at))).toBe(true);
  expect(manifest.sensitive).toBe(false);
  expect(manifest.stores).toEqual([]);
});

test('rejects traversal and absolute paths inside a backup', () => {
  expect(() => resolveBackupPath('/tmp/backup', '../escape.md')).toThrow(/traversal/);
  expect(() => resolveBackupPath('/tmp/backup', 'vault/../../escape.md')).toThrow(/traversal/);
  expect(() => resolveBackupPath('/tmp/backup', '/etc/passwd')).toThrow(/relative/);
  expect(() => resolveBackupPath('/tmp/backup', 'vault/./note.md')).toThrow(/traversal/);
});

test('the fixture rejects unsafe corrupt paths and never touches production paths', async () => {
  const fixture = await makeBackupFixture();
  await expect(fixture.corrupt('../../etc/passwd')).rejects.toThrow(/traversal/);
  await expect(fixture.corrupt('/etc/passwd')).rejects.toThrow(/relative/);
  expect(fixture.root.startsWith(tmpdir())).toBe(true);
  await fixture.close();
});

test('a missing stored file fails checksum verification', async () => {
  const fixture = await makeBackupFixture();
  await rm(join(fixture.root, 'state', 'journal.db'));
  await expect(verifyManifest(fixture.root, fixture.manifest)).rejects.toThrow(/checksum/);
  await fixture.close();
});

test('rejects an unsupported backup format version', async () => {
  const fixture = await makeBackupFixture();
  const unsupported: BackupManifest = { ...fixture.manifest, format_version: 99 };
  await expect(verifyManifest(fixture.root, unsupported)).rejects.toThrow(/unsupported/);
  await fixture.close();
});

test('rejects a backup produced by a newer application-state schema', () => {
  const newer = buildManifest([], { ...versions, schema: 2 });
  expect(() => assertCompatibleStateSchema(newer, 1)).toThrow(/schema/);
  expect(() => assertCompatibleStateSchema(buildManifest([], versions), 1)).not.toThrow();
});

test('collects a directory snapshot that verifies as a manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-manifest-'));
  try {
    await writeFile(join(root, 'a.md'), 'alpha');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'b.txt'), 'beta');
    const files = await collectManifestFiles(root);
    const manifest = buildManifest(files, versions);
    await expect(verifyManifest(root, manifest)).resolves.toBeUndefined();
    expect(files.map((file) => file.path).sort()).toEqual(['a.md', 'nested/b.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withLinkStore(
  setup: (workspace: string, store: string) => Promise<void>,
  assertion: (store: string, archive: string) => Promise<void>
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'brain-archive-link-'));
  const archive = join(workspace, 'volume.tar');
  const store = join(workspace, 'store');
  try {
    await mkdir(store);
    await setup(workspace, store);
    const packed = spawnSync('tar', ['-cf', archive, '-C', store, '.'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    await assertion(store, archive);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('live and archive validation reject a link that traverses through a regular file', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await writeFile(join(store, 'regular-file'), 'not a directory');
      await symlink('regular-file/..', join(store, 'non-directory-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/non-directory-link/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/non-directory-link/);
    }
  );
});

test('live and archive validation reject a simple missing link target', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await symlink('missing-target', join(store, 'missing-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/missing-link/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/missing-link/);
    }
  );
});

test('live and archive validation reject dot-dot escaping the store root', async () => {
  await withLinkStore(
    async (workspace, store) => {
      await writeFile(join(workspace, 'outside'), 'outside');
      await symlink('../outside', join(store, 'escaping-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/escaping-link/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/escaping-link/);
    }
  );
});

test('live and archive validation reject absolute link targets', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await symlink('/etc/passwd', join(store, 'absolute-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/absolute-link/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/absolute-link/);
    }
  );
});

test('live and archive validation reject symbolic link cycles', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await symlink('cycle-b', join(store, 'cycle-a'));
      await symlink('cycle-a', join(store, 'cycle-b'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/cycle-a/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/cycle-a/);
    }
  );
});

test('live and archive validation reject excessive symbolic link traversal', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await mkdir(join(store, 'target'));
      for (let index = 41; index >= 0; index -= 1) {
        await symlink(index === 41 ? 'target' : `depth-${index + 1}`, join(store, `depth-${index}`));
      }
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).rejects.toThrow(/depth-0/);
      await expect(validateBackupArchive(archive, 'volume')).rejects.toThrow(/depth-0/);
    }
  );
});

test('live and archive validation accept a bounded symlink chain to an internal directory', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await mkdir(join(store, 'target'));
      await writeFile(join(store, 'target', 'value'), 'inside');
      await symlink('target', join(store, 'second-link'));
      await symlink('second-link', join(store, 'first-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'volume')).resolves.toBeUndefined();
      await expect(validateBackupArchive(archive, 'volume')).resolves.toBeUndefined();
    }
  );
});

test('live and archive validation reject symbolic links in a vault store', async () => {
  await withLinkStore(
    async (_workspace, store) => {
      await writeFile(join(store, 'target'), 'inside');
      await symlink('target', join(store, 'vault-link'));
    },
    async (store, archive) => {
      await expect(validateStoreLinks(store, 'vault')).rejects.toThrow(/vault-link/);
      await expect(validateBackupArchive(archive, 'vault')).rejects.toThrow(/vault-link/);
    }
  );
});
