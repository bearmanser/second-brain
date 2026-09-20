import { expect, test } from 'vitest';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { countReferenceTokens } from '../../src/retrieval/budget.js';
import { lessonFixture } from '../fixtures/content.js';
import { workerContext } from '../fixtures/principals.js';
import { capture } from '../../src/features/capture.js';
import { createHarness } from '../support/harness.js';

const key = '00000000-0000-4000-8000-0000000000aa';

test('instructions are short and reference the controlled tools', () => {
  const text = buildInstructions();
  expect(text).toContain('brain_recall');
  expect(text).toContain('candidate');
  expect(countReferenceTokens(text)).toBeLessThan(700);
});

test('instructions do not embed the tool schemas', () => {
  const text = buildInstructions();
  for (const marker of ['"properties"', '"$defs"', '"$schema"', '"additionalProperties"']) {
    expect(text).not.toContain(marker);
  }
});

test('instructions are built from static prose, not from user notes', async () => {
  expect(buildInstructions).toHaveLength(0);
  const first = buildInstructions();
  expect(buildInstructions()).toBe(first);

  const harness = await createHarness();
  try {
    harness.backend.fail_once = 'before_write';
    await capture(
      workerContext,
      { idempotency_key: key, scope: 'freellmapi', note: lessonFixture },
      harness.deps
    );
    const after = buildInstructions();
    expect(after).toBe(first);
    expect(after).not.toContain(lessonFixture.title);
    expect(after).not.toContain('benchmark-fixture-1');
    expect(after).not.toContain('Measure the direct and proxied request');
  } finally {
    await harness.close();
  }
});

test('instructions carry the required behavioral guidance', () => {
  const text = buildInstructions();
  for (const phrase of [
    'reference memory',
    'brain_status',
    'brain_review',
    'brain_feedback',
    'untrusted data',
    'evidence',
    'handoff'
  ]) {
    expect(text).toContain(phrase);
  }
  expect(text).toContain('Validation is not verification');
});
