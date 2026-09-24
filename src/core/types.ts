import type { NoteContent } from '../contracts/content.js';
import type { Project, ProjectFilter } from '../projects/registry.js';

export type { NoteContent } from '../contracts/content.js';
export type {
  Project,
  ProjectAlias,
  ProjectFilter,
  ProjectRegistryPort
} from '../projects/registry.js';

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

export interface ProjectSelector {
  project?: string;
  scope?: string;
}

export interface CaptureRequest extends ProjectSelector {
  idempotency_key: string;
  note: NoteInput;
}

export interface ProjectEnsureRequest {
  idempotency_key: string;
  remote_url: string;
  display_name?: string;
}

export interface ProjectEnsureResult {
  operation_id: string;
  repository_identity: string;
  scope: string;
  created: boolean;
  backend_ready: boolean;
  materialized: boolean;
  warnings: string[];
}

export interface ProjectProvisioningPlan {
  repository_identity: string;
  project_id: string;
  display_name: string;
  relative_root: string;
  backend_project: string;
  backend_relative_root: string;
  created_by_actor_id: string;
  creation_operation_id: string;
}

export type RepositoryProjectState = 'provisioning' | 'ready' | 'recovery_required';

export interface RecallRequest extends ProjectSelector {
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

export interface ReadRequest extends ProjectSelector {
  id: string;
  revision_id?: string;
  cursor?: string;
  budget_tokens?: number;
}

export interface ReviewRequest extends ProjectSelector {
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

export interface FeedbackRequest extends ProjectSelector {
  idempotency_key: string;
  id: string;
  revision_id: string;
  retrieval_id?: string;
  verdict: FeedbackVerdict;
  reason: string;
  related_id?: string;
}

export interface StatusRequest extends ProjectSelector {
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
  scopes: { id: string }[];
  health: {
    gateway: 'ready' | 'recovering' | 'degraded';
    backend: 'ready' | 'unavailable';
    embeddings: 'ready' | 'unavailable' | 'unknown';
  };
  pending_operations: number;
  projects?: { scope: string; state: RepositoryProjectState }[];
  operation?: MutationReceipt | ProjectEnsureResult;
  schemas?: Record<string, unknown>;
}

export interface ScopeConfig {
  id: string;
  backend_project: string;
  relative_root: string;
  repository_aliases: string[];
}

export interface SystemActor {
  readonly kind: 'system';
  readonly id: string;
}

export const SYSTEM_ACTOR: SystemActor = Object.freeze({ kind: 'system', id: 'system' });

export interface AuthenticatedContext {
  readonly actor: SystemActor;
  readonly request_id: string;
  readonly signal: AbortSignal;
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
  registerScope(scope: ScopeConfig): void;
  verifyProject(project: string, projectPath: string): Promise<boolean>;
  ensureProject(project: string, projectPath: string): Promise<{ created: boolean }>;
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
  registerScope(scope: ScopeConfig): void;
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
  registerScope(scope: ScopeConfig): void;
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

export interface ProjectProvisioning {
  created_by_actor_id: string;
  creation_operation_id: string;
  failure_stage?: string;
  failure_code?: string;
}

export interface LegacyProjectBackendBinding {
  backend_project: string;
  backend_relative_root: string;
}

export interface PersistedProject {
  project: Project;
  state: RepositoryProjectState;
  provisioning: ProjectProvisioning;
  updated_at: string;
}

export interface LegacyProjectAdapterPort {
  binding(project_id: string): LegacyProjectBackendBinding | undefined;
  scopeFor(project: Project): ScopeConfig | undefined;
}

export const IDEMPOTENCY_ORIGINS = ['legacy', 'new'] as const;
export type IdempotencyOrigin = (typeof IDEMPOTENCY_ORIGINS)[number];

export const IDEMPOTENCY_RESOLUTIONS = [
  'unresolved',
  'bound',
  'conflict',
  'recovery_required',
  'released'
] as const;
export type IdempotencyResolution = (typeof IDEMPOTENCY_RESOLUTIONS)[number];

export const IDEMPOTENCY_TARGET_KINDS = ['operation', 'feedback'] as const;
export type IdempotencyTargetKind = (typeof IDEMPOTENCY_TARGET_KINDS)[number];

export interface IdempotencyKeyRecord {
  idempotency_key: string;
  origin: IdempotencyOrigin;
  resolution: IdempotencyResolution;
  tool?: string;
  project_id?: string;
  payload_hash?: string;
  target_kind?: IdempotencyTargetKind;
  target_id?: string;
}

export const RETRIEVAL_OUTCOMES_V2 = ['ok', 'partial', 'error'] as const;
export type RetrievalOutcomeV2 = (typeof RETRIEVAL_OUTCOMES_V2)[number];

export interface RetrievalSourceRef {
  scope: string;
  id: string;
  revision_id: string;
}

export interface RetrievalEventInputV2 {
  retrieval_id: string;
  actor_id: string;
  filter: ProjectFilter;
  searched_project_ids: string[];
  primary_project_id: string | null;
  returned_ids: RetrievalSourceRef[];
  item_count: number;
  token_used: number;
  token_limit: number;
  mode: RecallMode;
  outcome: RetrievalOutcomeV2;
  partial: boolean;
  duration_ms: number;
  created_at?: string;
}

export type NoteContentV1 = NoteContent;
export type NoteInputV1 = NoteInput;
export type StoredRevisionV1 = StoredRevision;
