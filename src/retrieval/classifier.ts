import { KNOWN_DOCUMENT_TYPES } from './query.js';

export const INTENT_LABELS = [
  'decision_lookup',
  'how_to',
  'concept_lookup',
  'chronological_recall',
  'broad_research',
  'unknown'
] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

export const INTENT_QUESTION_VERSION = 'intent-2026-09-23.1';
export const TYPE_QUESTION_VERSION = 'type-2026-09-23.1';
export const ADVISORY_ENABLED_BY_DEFAULT = false;

export const SUGGESTED_DOCUMENT_TYPES: readonly string[] = [
  'decision',
  'playbook',
  'lesson',
  'fact',
  'preference',
  'session',
  'note',
  'project',
  'architecture',
  'research',
  'concept',
  'task',
  'person',
  'meeting',
  'reference',
  'daily'
].filter((type) => KNOWN_DOCUMENT_TYPES.has(type));

export interface AdvisoryPrediction {
  label: string;
  model_fingerprint?: string;
}

export interface AdvisoryPredictorInput {
  text: string;
  question_version: string;
  signal?: AbortSignal;
}

export type AdvisoryPredictor = (input: AdvisoryPredictorInput) => Promise<AdvisoryPrediction>;

export interface AdvisoryOptions {
  enabled?: boolean;
  predictor?: AdvisoryPredictor;
  signal?: AbortSignal;
}

export interface IntentSuggestion {
  value: IntentLabel;
  question_version: string;
  model_fingerprint?: string;
}

export interface TypeSuggestion {
  value: string;
  question_version: string;
  model_fingerprint?: string;
}

export interface ClassifiableDocument {
  title?: string;
  body?: string;
}

async function predict(
  options: AdvisoryOptions,
  text: string,
  questionVersion: string
): Promise<AdvisoryPrediction | undefined> {
  if (options.enabled !== true) return undefined;
  if (text.trim().length === 0) return undefined;
  if (options.predictor === undefined) return undefined;
  try {
    return await options.predictor({
      text,
      question_version: questionVersion,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  } catch {
    return undefined;
  }
}

function isIntentLabel(value: string): value is IntentLabel {
  return (INTENT_LABELS as readonly string[]).includes(value);
}

export async function suggestIntent(
  query: string,
  options: AdvisoryOptions = {}
): Promise<IntentSuggestion | undefined> {
  if (typeof query !== 'string') return undefined;
  const prediction = await predict(options, query, INTENT_QUESTION_VERSION);
  if (prediction === undefined || !isIntentLabel(prediction.label)) return undefined;
  return {
    value: prediction.label,
    question_version: INTENT_QUESTION_VERSION,
    ...(prediction.model_fingerprint === undefined ? {} : { model_fingerprint: prediction.model_fingerprint })
  };
}

export async function suggestType(
  document: ClassifiableDocument,
  options: AdvisoryOptions = {}
): Promise<TypeSuggestion | undefined> {
  const title = typeof document?.title === 'string' ? document.title : '';
  const body = typeof document?.body === 'string' ? document.body : '';
  const prediction = await predict(options, `${title}\n\n${body}`, TYPE_QUESTION_VERSION);
  if (prediction === undefined || !SUGGESTED_DOCUMENT_TYPES.includes(prediction.label)) return undefined;
  return {
    value: prediction.label,
    question_version: TYPE_QUESTION_VERSION,
    ...(prediction.model_fingerprint === undefined ? {} : { model_fingerprint: prediction.model_fingerprint })
  };
}

export function resolveDocumentType(
  explicit: string | undefined,
  suggestion: string | undefined
): string | undefined {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof suggestion === 'string' && SUGGESTED_DOCUMENT_TYPES.includes(suggestion)) return suggestion;
  return undefined;
}

export type CandidateChannel = 'exact' | 'lexical' | 'graph';

export interface ChannelCandidate {
  channel: CandidateChannel;
}

const CHANNEL_ORDERS: Record<IntentLabel, readonly CandidateChannel[]> = {
  decision_lookup: ['exact', 'lexical', 'graph'],
  how_to: ['exact', 'graph', 'lexical'],
  concept_lookup: ['lexical', 'exact', 'graph'],
  chronological_recall: ['exact', 'lexical', 'graph'],
  broad_research: ['lexical', 'graph', 'exact'],
  unknown: ['lexical', 'exact', 'graph']
};

export function intentChannelOrder(intent: IntentLabel | undefined): readonly CandidateChannel[] {
  return intent === undefined ? ['exact', 'lexical', 'graph'] : CHANNEL_ORDERS[intent];
}

export function applyIntentPreference<T extends ChannelCandidate>(
  candidates: readonly T[],
  intent: IntentLabel | undefined
): T[] {
  if (intent === undefined || intent === 'unknown') return [...candidates];
  const order = intentChannelOrder(intent);
  const rank = (channel: CandidateChannel): number => {
    const index = order.indexOf(channel);
    return index < 0 ? order.length : index;
  };
  return [...candidates].sort((left, right) => rank(left.channel) - rank(right.channel));
}
