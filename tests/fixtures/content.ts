import type { NoteInput } from '../../src/core/types.js';

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
