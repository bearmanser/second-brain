import { expect, test } from 'vitest';
import type { ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { decodeRevision, payloadHash, renderRevision } from '../../src/notes/codec.js';
import { lessonFixture } from '../fixtures/content.js';

const scope: ScopeConfig = {
  id: 'freellmapi',
  backend_project: 'freellmapi',
  relative_root: 'freellmapi',
  repository_aliases: []
};

const ID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TIMESTAMP = '2026-09-23T09:00:00.000Z';

function approvedRevision(principalId: string): StoredRevision {
  const base: StoredRevision = {
    id: ID(0xa1),
    revision_id: ID(0xb1),
    parents: [],
    scope: 'freellmapi',
    status: 'active',
    note: lessonFixture,
    created_at: TIMESTAMP,
    modified_at: TIMESTAMP,
    operation_id: ID(0xc1),
    extra_frontmatter: {},
    extra_markdown: ''
  };
  return {
    ...base,
    approval: {
      principal_id: principalId,
      rationale: 'single trust domain approval',
      payload_hash: payloadHash(base)
    }
  };
}

test('accepts a legacy UUID or the fixed system actor as approval provenance', () => {
  const systemRaw = renderRevision(approvedRevision('system'), scope);
  expect(decodeRevision(systemRaw).approval?.principal_id).toBe('system');

  const legacyRaw = renderRevision(approvedRevision(ID(0x01)), scope);
  expect(decodeRevision(legacyRaw).approval?.principal_id).toBe(ID(0x01));
});

test('rejects an arbitrary approval actor string', () => {
  const raw = renderRevision(approvedRevision('system'), scope).replace(
    'brain_approved_by: system',
    'brain_approved_by: worker'
  );
  expect(raw).toContain('brain_approved_by: worker');
  expect(() => decodeRevision(raw)).toThrow(/INVALID_INPUT/);
});

test('content changes do not match a stored approval payload hash', () => {
  const revision = approvedRevision('system');
  const changed: StoredRevision = {
    ...revision,
    note: { ...revision.note, title: 'Changed title' }
  };
  expect(payloadHash(changed)).not.toBe(revision.approval?.payload_hash);
});
