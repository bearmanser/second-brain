import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_RUBRIC_VERSION = '2026-09-23';

export const RETRIEVAL_LABEL_SOURCES = ['human_reviewed', 'agent_proposed', 'synthetic'] as const;
export type RetrievalLabelSource = (typeof RETRIEVAL_LABEL_SOURCES)[number];

export const RETRIEVAL_LABEL_VALUES = [0, 1, 2] as const;
export type RetrievalLabelValue = (typeof RETRIEVAL_LABEL_VALUES)[number];

export const RETRIEVAL_SPLITS = ['train', 'dev', 'test'] as const;
export type RetrievalSplit = (typeof RETRIEVAL_SPLITS)[number];

export class StaleLabelError extends Error {
  readonly code = 'STALE_LABEL';

  constructor(message: string) {
    super(message);
    this.name = 'StaleLabelError';
  }
}

export interface RetrievalLabelInput {
  label_id?: string;
  trace_id: string;
  source_type: RetrievalLabelSource;
  query_id: string;
  question_id?: string;
  question_version?: string;
  model_fingerprint?: string;
  logical_id?: string;
  path?: string;
  revision_id?: string;
  source_hash: string;
  candidate_position?: number;
  label: RetrievalLabelValue;
  rubric_version?: string;
  evidence_ref?: string;
  approved?: boolean;
  voided_at?: string | null;
  created_at?: string;
  query_family?: string;
  source_family?: string;
}

export interface RetrievalLabelEntry extends RetrievalLabelInput {
  label_id: string;
  approved: boolean;
  voided_at: string | null;
  created_at: string;
}

export interface LabelSourceVersion {
  source_hash: string;
  revision_id?: string;
}

export function assertFreshLabel(source: LabelSourceVersion, current: LabelSourceVersion): void {
  if (source.source_hash !== current.source_hash) {
    throw new StaleLabelError('the source hash does not match the current version of the note');
  }
  if (
    source.revision_id !== undefined &&
    current.revision_id !== undefined &&
    source.revision_id !== current.revision_id
  ) {
    throw new StaleLabelError('the revision id does not match the current version of the note');
  }
}

export function defaultApproved(source: RetrievalLabelSource): boolean {
  if (source === 'agent_proposed') return false;
  return true;
}

export function isExportableLabel(entry: Pick<RetrievalLabelEntry, 'approved' | 'voided_at'>): boolean {
  return entry.approved && entry.voided_at === null;
}

function labelKey(entry: RetrievalLabelInput): string {
  return entry.label_id ?? `${entry.query_id}\u0000${entry.logical_id ?? entry.path ?? entry.source_hash}`;
}

function queryFamilyOf(entry: RetrievalLabelInput): string {
  return entry.query_family ?? entry.query_id;
}

function sourceFamilyOf(entry: RetrievalLabelInput): string {
  return entry.source_family ?? entry.logical_id ?? entry.path ?? entry.source_hash;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_value, index) => index);
  }

  find(index: number): number {
    let current = index;
    while (this.parent[current] !== current) {
      this.parent[current] = this.parent[this.parent[current]];
      current = this.parent[current];
    }
    return current;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

export interface SplitAssignment {
  split_for: Map<string, RetrievalSplit>;
  components: number;
  jointly_split_components: number;
  limitations: string[];
}

function splitForComponent(seed: number, members: readonly string[]): RetrievalSplit {
  const digest = createHash('sha256')
    .update(`${seed}:${[...members].sort().join('|')}`, 'utf8')
    .digest('hex');
  return RETRIEVAL_SPLITS[Number.parseInt(digest.slice(0, 8), 16) % RETRIEVAL_SPLITS.length];
}

export function assignSplits(
  entries: readonly RetrievalLabelInput[],
  splitSeed: number
): SplitAssignment {
  const disjoint = new DisjointSet(entries.length);
  const queryFamilies = new Map<string, number>();
  const sourceFamilies = new Map<string, number>();
  entries.forEach((entry, index) => {
    const queryKey = `q:${queryFamilyOf(entry)}`;
    const sourceKey = `s:${sourceFamilyOf(entry)}`;
    const knownQuery = queryFamilies.get(queryKey);
    if (knownQuery === undefined) queryFamilies.set(queryKey, index);
    else disjoint.union(knownQuery, index);
    const knownSource = sourceFamilies.get(sourceKey);
    if (knownSource === undefined) sourceFamilies.set(sourceKey, index);
    else disjoint.union(knownSource, index);
  });
  const membersByRoot = new Map<number, string[]>();
  entries.forEach((entry, index) => {
    const root = disjoint.find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(labelKey(entry));
    membersByRoot.set(root, members);
  });
  const split_for = new Map<string, RetrievalSplit>();
  let jointlySplit = 0;
  const limitations: string[] = [];
  for (const members of membersByRoot.values()) {
    const split = splitForComponent(splitSeed, members);
    for (const member of members) split_for.set(member, split);
    if (members.length > 1) {
      jointlySplit += 1;
      limitations.push(
        `grouped ${members.length} near-duplicate labels into one ${split} split to avoid leakage`
      );
    }
  }
  return {
    split_for,
    components: membersByRoot.size,
    jointly_split_components: jointlySplit,
    limitations
  };
}

export interface LabelTextLookup {
  queryText(query_id: string): string | undefined;
  noteText(source_hash: string): string | undefined;
}

export interface LabeledRetrievalExportOptions {
  output: string;
  splitSeed: number;
  includeText?: boolean;
  labels: readonly RetrievalLabelInput[];
  candidatesByQuery?: ReadonlyMap<string, readonly string[]>;
  textLookup?: LabelTextLookup;
  rubricVersion?: string;
  datasetId?: string;
  datasetSha256?: string;
  modelFingerprints?: readonly string[];
  questionVersions?: readonly string[];
}

export interface LabeledRetrievalManifest {
  version: number;
  include_text: boolean;
  split_seed: number;
  rubric_version: string;
  dataset_id: string | null;
  dataset_sha256: string | null;
  model_fingerprints: string[];
  question_versions: string[];
  counts: LabeledRetrievalCounts;
  limitations: string[];
  manifest_hash: string;
}

export interface LabeledRetrievalCounts {
  labels: number;
  exported: number;
  by_source: Record<RetrievalLabelSource, number>;
  by_split: Record<RetrievalSplit, number>;
  unjudged: number;
  excluded_not_approved: number;
  excluded_voided: number;
}

export interface LabeledRetrievalExport {
  output: string;
  counts: LabeledRetrievalCounts;
  manifest: LabeledRetrievalManifest;
  rows: Record<string, unknown>[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalise(entry: RetrievalLabelInput): RetrievalLabelEntry {
  const approved = entry.source_type === 'agent_proposed' ? false : entry.approved ?? true;
  return {
    ...entry,
    label_id: labelKey(entry),
    approved,
    voided_at: entry.voided_at ?? null,
    created_at: entry.created_at ?? new Date(0).toISOString()
  };
}

function rowFor(
  entry: RetrievalLabelEntry,
  split: RetrievalSplit,
  includeText: boolean,
  textLookup: LabelTextLookup | undefined,
  rubricVersion: string
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    label_id: entry.label_id,
    query_id: entry.query_id,
    trace_id: entry.trace_id,
    source_type: entry.source_type,
    label: entry.label,
    split,
    rubric_version: entry.rubric_version ?? rubricVersion,
    source_hash: entry.source_hash
  };
  if (entry.logical_id !== undefined) row.source_id = entry.logical_id;
  if (entry.path !== undefined) row.path = entry.path;
  if (entry.revision_id !== undefined) row.revision_id = entry.revision_id;
  if (entry.candidate_position !== undefined) row.candidate_position = entry.candidate_position;
  if (entry.question_id !== undefined) row.question_id = entry.question_id;
  if (entry.question_version !== undefined) row.question_version = entry.question_version;
  if (entry.model_fingerprint !== undefined) row.model_fingerprint = entry.model_fingerprint;
  if (entry.evidence_ref !== undefined) row.evidence_ref = entry.evidence_ref;
  if (includeText && textLookup !== undefined) {
    const queryText = textLookup.queryText(entry.query_id);
    const noteText = textLookup.noteText(entry.source_hash);
    if (queryText !== undefined) row.query_text = queryText;
    if (noteText !== undefined) row.note_text = noteText;
  }
  return row;
}

export async function exportLabeledRetrieval(
  options: LabeledRetrievalExportOptions
): Promise<LabeledRetrievalExport> {
  const includeText = options.includeText ?? false;
  const rubricVersion = options.rubricVersion ?? DEFAULT_RUBRIC_VERSION;
  const entries = options.labels.map(normalise);
  const exportable = entries.filter(isExportableLabel);
  const assignment = assignSplits(exportable, options.splitSeed);
  const rows = exportable
    .map((entry) =>
      rowFor(
        entry,
        assignment.split_for.get(entry.label_id) as RetrievalSplit,
        includeText,
        options.textLookup,
        rubricVersion
      )
    )
    .sort((left, right) => {
      const leftKey = `${left.query_id}\u0000${left.source_id ?? left.source_hash}\u0000${left.label_id}`;
      const rightKey = `${right.query_id}\u0000${right.source_id ?? right.source_hash}\u0000${right.label_id}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const bySource: Record<RetrievalLabelSource, number> = {
    human_reviewed: 0,
    agent_proposed: 0,
    synthetic: 0
  };
  const bySplit: Record<RetrievalSplit, number> = { train: 0, dev: 0, test: 0 };
  for (const entry of exportable) {
    bySource[entry.source_type] += 1;
    bySplit[assignment.split_for.get(entry.label_id) as RetrievalSplit] += 1;
  }
  const judgedByQuery = new Map<string, Set<string>>();
  for (const entry of entries) {
    const judged = judgedByQuery.get(entry.query_id) ?? new Set<string>();
    judged.add(entry.logical_id ?? entry.path ?? entry.source_hash);
    judgedByQuery.set(entry.query_id, judged);
  }
  let unjudged = 0;
  if (options.candidatesByQuery !== undefined) {
    for (const [queryId, candidates] of options.candidatesByQuery) {
      const judged = judgedByQuery.get(queryId) ?? new Set<string>();
      for (const candidate of candidates) {
        if (!judged.has(candidate)) unjudged += 1;
      }
    }
  }
  const counts: LabeledRetrievalCounts = {
    labels: entries.length,
    exported: exportable.length,
    by_source: bySource,
    by_split: bySplit,
    unjudged,
    excluded_not_approved: entries.filter((entry) => !entry.approved).length,
    excluded_voided: entries.filter((entry) => entry.approved && entry.voided_at !== null).length
  };
  const manifestCore = {
    version: 1,
    include_text: includeText,
    split_seed: options.splitSeed,
    rubric_version: rubricVersion,
    dataset_id: options.datasetId ?? null,
    dataset_sha256: options.datasetSha256 ?? null,
    model_fingerprints: [...(options.modelFingerprints ?? [])].sort(),
    question_versions: [...(options.questionVersions ?? [])].sort(),
    counts,
    limitations: assignment.limitations
  };
  const manifestHash = createHash('sha256').update(canonical(manifestCore), 'utf8').digest('hex');
  const manifest: LabeledRetrievalManifest = { ...manifestCore, manifest_hash: manifestHash };
  await mkdir(dirname(options.output), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(options.output, body.length === 0 ? '' : `${body}\n`, 'utf8');
  return { output: options.output, counts, manifest, rows };
}
