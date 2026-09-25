export const VERSION = '1.0.0';

export const NOTE_TYPES = ['lesson', 'decision', 'playbook', 'fact', 'preference', 'session', 'note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const VERDICTS = ['useful', 'irrelevant', 'stale', 'incorrect', 'contradiction'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const NEGATIVE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['incorrect', 'stale', 'contradiction']);

export type FeedbackSummary = Partial<Record<Verdict, number>>;

export const LIMITS = {
  noteWriteBytes: 64 * 1024,
  noteReadBytes: 256 * 1024,
  requestBodyBytes: 256 * 1024,
  recallDefault: 5,
  recallMax: 20,
  excerptChars: 600,
  titleChars: 200,
  tagsMax: 32,
  tagChars: 100,
  queryChars: 1000,
  reasonChars: 1000,
  filenameChars: 100
} as const;
