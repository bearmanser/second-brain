import type { Lifecycle, NoteInput, StoredRevision } from '../../src/core/types.js';
import type { ParsedRevision } from '../../src/notes/catalogue.js';

export const fixtureIds = {
  note: '0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  revision: '1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  replacement: '2d0a3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
} as const;

export const lessonFixture: NoteInput = {
  title: 'Compare direct and proxied TTFT',
  tags: ['streaming'],
  content: {
    kind: 'lesson',
    situation: 'First-token latency looked worse after streaming traffic was routed through the proxy.',
    lesson: 'Measure the direct and proxied request with the same prompt before attributing the difference to the proxy.',
    applicability: 'Applies to synthetic streaming benchmarks in the freellmapi scope.'
  },
  evidence: [
    {
      kind: 'test_run',
      ref: 'benchmark-fixture-1',
      description: 'Synthetic direct/proxy measurements'
    }
  ],
  related_ids: []
};

export const graphFixtureIds = {
  note: '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  root: '4a1b2c3d-5e6f-4a70-8b8c-9d0e1f2a3b4c',
  left: '5b2c3d4e-6f70-4b81-9c9d-0e1f2a3b4c5d',
  right: '6c3d4e5f-7081-4c92-8d0e-1f2a3b4c5d6e',
  rootHash: 'a'.repeat(64),
  leftHash: 'b'.repeat(64),
  rightHash: 'c'.repeat(64)
} as const;

export const graphScope = 'freellmapi';

const graphRevision = (
  revisionId: string,
  parents: { revision_id: string; raw_hash: string }[],
  status: Lifecycle = 'candidate'
): StoredRevision => ({
  id: graphFixtureIds.note,
  revision_id: revisionId,
  parents,
  scope: graphScope,
  status,
  note: lessonFixture,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: '2026-09-01T00:05:00Z',
  operation_id: fixtureIds.idempotencyKey,
  extra_frontmatter: {},
  extra_markdown: ''
});

export function revisionGraphFixture(): {
  root: ParsedRevision;
  left: ParsedRevision;
  right: ParsedRevision;
} {
  const root: ParsedRevision = {
    revision: graphRevision(graphFixtureIds.root, []),
    raw_hash: graphFixtureIds.rootHash,
    relative_path: `${graphScope}/Lessons/${graphFixtureIds.note}/${graphFixtureIds.root}.md`
  };
  const left: ParsedRevision = {
    revision: graphRevision(graphFixtureIds.left, [
      { revision_id: graphFixtureIds.root, raw_hash: graphFixtureIds.rootHash }
    ]),
    raw_hash: graphFixtureIds.leftHash,
    relative_path: `${graphScope}/Lessons/${graphFixtureIds.note}/${graphFixtureIds.left}.md`
  };
  const right: ParsedRevision = {
    revision: graphRevision(graphFixtureIds.right, [
      { revision_id: graphFixtureIds.root, raw_hash: graphFixtureIds.rootHash }
    ]),
    raw_hash: graphFixtureIds.rightHash,
    relative_path: `${graphScope}/Lessons/${graphFixtureIds.note}/${graphFixtureIds.right}.md`
  };
  return { root, left, right };
}
