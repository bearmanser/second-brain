import { expect, test } from 'vitest';
import { BrainError, conflict, invalidInput, isBrainError, limitExceeded, notFound } from '../../src/errors.js';
import { LIMITS, NEGATIVE_VERDICTS, NOTE_TYPES, VERDICTS } from '../../src/types.js';

test('error helpers carry their code and message', () => {
  expect(invalidInput('bad').code).toBe('INVALID_INPUT');
  expect(notFound('gone').code).toBe('NOT_FOUND');
  expect(conflict('race').code).toBe('CONFLICT');
  expect(limitExceeded('big').message).toBe('big');
  expect(isBrainError(conflict('x'))).toBe(true);
  expect(isBrainError(new Error('x'))).toBe(false);
  expect(new BrainError('NOT_FOUND', 'm')).toBeInstanceOf(Error);
});

test('shared constants match the spec', () => {
  expect(NOTE_TYPES).toEqual(['lesson', 'decision', 'playbook', 'fact', 'preference', 'session', 'note']);
  expect(VERDICTS).toEqual(['useful', 'irrelevant', 'stale', 'incorrect', 'contradiction']);
  expect([...NEGATIVE_VERDICTS].sort()).toEqual(['contradiction', 'incorrect', 'stale']);
  expect(LIMITS.noteWriteBytes).toBe(65536);
  expect(LIMITS.recallMax).toBe(20);
});
