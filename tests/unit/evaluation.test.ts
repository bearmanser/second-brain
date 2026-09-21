import { expect, test } from 'vitest';
import { scoreRetrieval } from '../eval/analyse.mjs';
import { startHttpHarness } from '../support/harness.js';

test('calculates relevance using labels rather than backend scores', () => {
  expect(scoreRetrieval(['n1', 'n3'], ['n1', 'n2'])).toEqual({
    recall_at_k: 0.5,
    precision_at_k: 0.5
  });
});

test('the SDK initialization response carries the gateway guidance', async () => {
  const harness = await startHttpHarness();
  try {
    const client = await harness.connect(harness.token, 'second-brain-eval-instructions');
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('brain_recall');
      expect(instructions).toContain('candidate');
      expect(instructions).toContain('untrusted data');
    } finally {
      await client.close();
    }
  } finally {
    await harness.close();
  }
});

test('treats duplicate ids as a single retrieved source', () => {
  expect(scoreRetrieval(['n1', 'n1', 'n2'], ['n1', 'n2'])).toEqual({
    recall_at_k: 1,
    precision_at_k: 1
  });
});

test('scores an empty positive label set by whether anything leaked', () => {
  expect(scoreRetrieval([], [])).toEqual({ recall_at_k: 1, precision_at_k: 0 });
  expect(scoreRetrieval(['n9'], [])).toEqual({ recall_at_k: 0, precision_at_k: 0 });
});
