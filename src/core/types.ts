import type { NoteContent } from '../contracts/content.js';

export type { NoteContent } from '../contracts/content.js';

export const NOTE_KINDS = [
  'lesson',
  'decision',
  'playbook',
  'fact',
  'preference',
  'session',
  'note'
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export const LIFECYCLES = ['candidate', 'active', 'superseded', 'archived'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const PHASES = [
  'general',
  'brainstorming',
  'planning',
  'debugging',
  'implementation',
  'review',
  'handoff'
] as const;
export type Phase = (typeof PHASES)[number];

export const EVIDENCE_KINDS = [
  'user_statement',
  'repository',
  'test_run',
  'observation',
  'reference',
  'hypothesis'
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const FEEDBACK_VERDICTS = [
  'useful',
  'irrelevant',
  'stale',
  'incorrect',
  'contradiction'
] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const RECALL_MODES = ['hybrid', 'text'] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

export interface Evidence {
  kind: EvidenceKind;
  ref: string;
  description: string;
  observed_at?: string;
}

export interface NoteInput {
  title: string;
  tags: string[];
  content: NoteContent;
  evidence: Evidence[];
  related_ids: string[];
}

export interface CaptureRequest {
  idempotency_key: string;
  scope: string;
  note: NoteInput;
}

export interface RecallRequest {
  scope: string;
  query: string;
  topics?: string[];
  phase?: Phase;
  kinds?: NoteKind[];
  include_shared?: boolean;
  include_candidates?: boolean;
  session_id?: string;
  mode?: RecallMode;
  allow_text_fallback?: boolean;
  budget_tokens?: number;
  limit?: number;
}

export interface ReadRequest {
  scope: string;
  id: string;
  revision_id?: string;
  cursor?: string;
  budget_tokens?: number;
}

export interface ReviewRequest {
  scope: string;
  operation:
    | { action: 'list'; filter: 'candidate' | 'conflict'; cursor?: string }
    | {
        action: 'approve' | 'archive';
        idempotency_key: string;
        id: string;
        expected_etag: string;
        rationale: string;
      }
    | {
        action: 'revise';
        idempotency_key: string;
        id: string;
        expected_etag: string;
        rationale: string;
        note: NoteInput;
      }
    | {
        action: 'supersede';
        idempotency_key: string;
        id: string;
        expected_etag: string;
        rationale: string;
        replacement_id: string;
      }
    | {
        action: 'resolve';
        idempotency_key: string;
        id: string;
        expected_heads: { revision_id: string; etag: string }[];
        rationale: string;
        note: NoteInput;
      };
}

export interface FeedbackRequest {
  idempotency_key: string;
  scope: string;
  id: string;
  revision_id: string;
  retrieval_id?: string;
  verdict: FeedbackVerdict;
  reason: string;
  related_id?: string;
}

export interface StatusRequest {
  scope?: string;
  operation_id?: string;
  include_schemas?: boolean;
}

export interface SourceRef {
  id: string;
  revision_id: string;
  scope: string;
  title: string;
  kind: NoteKind;
  status: Lifecycle;
  etag: string;
  relative_path: string;
  warnings: string[];
}

export interface MutationReceipt {
  operation_id: string;
  id: string;
  revision_id: string;
  outcome: 'stored' | 'stored_conflict' | 'pending';
  materialized: boolean;
  indexed: boolean;
  etag?: string;
  possible_duplicates: SourceRef[];
  warnings: string[];
}

export interface RecallResult {
  retrieval_id: string;
  mode: RecallMode;
  partial: boolean;
  warnings: string[];
  budget: { tokenizer: 'cl100k_base'; used: number; limit: number };
  items: (SourceRef & { excerpt: string; reasons: string[] })[];
}

export interface ReadResult {
  source: SourceRef;
  markdown: string;
  next_cursor?: string;
}

export interface ReviewListResult {
  items: SourceRef[];
  next_cursor?: string;
}

export interface FeedbackResult {
  feedback_id: string;
  recorded: true;
}

export interface StatusResult {
  version: string;
  protocol_version: string;
  schema_version: 1;
  scopes: { id: string; can_write: boolean; can_review: boolean }[];
  health: {
    gateway: 'ready' | 'recovering' | 'degraded';
    backend: 'ready' | 'unavailable';
    embeddings: 'ready' | 'unavailable' | 'unknown';
  };
  pending_operations: number;
  operation?: MutationReceipt;
  schemas?: Record<string, unknown>;
}

export interface ScopeConfig {
  id: string;
  backend_project: string;
  relative_root: string;
  repository_aliases: string[];
}

export interface Principal {
  id: string;
  role: 'worker' | 'reviewer' | 'owner';
  read_scopes: string[];
  write_scopes: string[];
  review_scopes: string[];
}

export interface RequestContext {
  principal: Principal;
  request_id: string;
  signal: AbortSignal;
}

export interface Clock {
  now(): Date;
}

export interface IdSource {
  next(): string;
}

export interface StoredRevision {
  id: string;
  revision_id: string;
  parents: { revision_id: string; raw_hash: string }[];
  scope: string;
  status: Lifecycle;
  note: NoteInput;
  created_at: string;
  modified_at: string;
  operation_id: string;
  approval?: { principal_id: string; rationale: string; payload_hash: string };
  replacement_id?: string;
  extra_frontmatter: Record<string, unknown>;
  extra_markdown: string;
}

export interface Head {
  revision: StoredRevision;
  source: SourceRef;
  raw_hash: string;
  state: 'ready' | 'manual_unreviewed' | 'conflict' | 'malformed';
}

export interface PlannedWrite {
  revision: StoredRevision;
  backend_project: string;
  directory: string;
  storage_title: string;
  permalink: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface BackendHit {
  permalink: string;
  relative_path: string;
  revision_id: string;
  logical_id: string;
  rank: number;
  matched_text: string;
}

export interface BackendSearch {
  project: string;
  query: string;
  mode: RecallMode;
  kinds: NoteKind[];
  statuses: Lifecycle[];
  page: number;
  page_size: number;
}

export interface BackendPort {
  connect(): Promise<void>;
  probe(): Promise<{ server_version: string; tools: string[] }>;
  create(write: PlannedWrite): Promise<{ permalink: string; relative_path?: string }>;
  search(input: BackendSearch): Promise<{ hits: BackendHit[]; has_more: boolean }>;
  isIndexed(project: string, revision_id: string): Promise<boolean>;
  close(): Promise<void>;
}

export type CatalogueState =
  | 'ready'
  | 'manual_unreviewed'
  | 'conflict'
  | 'malformed'
  | 'unsupported_schema';

export interface VaultScan {
  managed: string[];
  unmanaged: string[];
}

export interface VaultPort {
  list(scope: string): Promise<string[]>;
  read(
    scope: string,
    relative_path: string
  ): Promise<{ raw: string; raw_hash: string; relative_path: string }>;
  scan?(scope: string): Promise<VaultScan>;
}

export interface ReconcileFinding {
  scope: string;
  relative_path: string;
  state: CatalogueState;
  id?: string;
  revision_id?: string;
  warnings: string[];
}

export interface ReconcileCounts {
  scanned: number;
  updated: number;
  unmanaged: number;
  malformed: number;
  conflicted: number;
  manual_unreviewed: number;
  unsupported_schema: number;
}

export interface ReconcileScopeReport extends ReconcileCounts {
  scope: string;
  findings: ReconcileFinding[];
}

export interface ReconcileReport extends ReconcileCounts {
  scopes: string[];
  ids?: {
    malformed: string[];
    conflicted: string[];
    manual_unreviewed: string[];
    unsupported_schema: string[];
  };
  findings?: ReconcileFinding[];
}

export interface CataloguePort {
  reconcile(scope: string): Promise<void>;
  reconcileReport(scope: string): Promise<ReconcileScopeReport>;
  approvalIsValid(revision: StoredRevision): boolean;
  get(scope: string, id: string): Promise<Head>;
  getRevision(scope: string, id: string, revision_id: string): Promise<Head>;
  locate(
    scope: string,
    id: string,
    revision_id?: string
  ): Promise<{ relative_path: string } | undefined>;
  list(
    scope: string,
    filter: 'candidate' | 'conflict',
    cursor?: string
  ): Promise<{ items: SourceRef[]; next_cursor?: string }>;
}
