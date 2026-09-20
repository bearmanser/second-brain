import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  assertCompatibleStateSchema,
  buildManifest,
  collectManifestFiles,
  resolveBackupPath,
  validateManifest,
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
