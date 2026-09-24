import type { NoteContent, DocumentType } from '../contracts/content.js';
import type { Project, ProjectFilter } from '../projects/registry.js';
import type { BrainConfig } from '../config/schema.js';
import type { CurrentCatalogue, CurrentVault } from '../notes/current-catalogue.js';
import type { RerankWorker } from '../retrieval/reranker.js';
import type { Journal } from '../storage/journal.js';
import type { DocumentStore } from '../storage/document-store.js';
import type { SearchIndex } from '../storage/search-index.js';

export type { NoteContent } from '../contracts/content.js';
export type { DocumentType } from '../contracts/content.js';
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

export const RECALL_MODES = ['text', 'reranked', 'hybrid'] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

export type NoteReference =
  | {id: string; path?: never; title?: never}
  | {path: string; id?: never; title?: never}
  | {title: string; id?: never; path?: never};

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
  type?: DocumentType;
  source?: string;
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
  project_id?: string;
  relative_root?: string;
  created: boolean;
  backend_ready: boolean;
  materialized: boolean;
  warnings: string[];
}

export interface ProjectEnsureResultV2 {
  operation_id: string;
  repository_identity: string;
  project_id: string;
  relative_root: string;
  created: boolean;
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
  id?: string;
  path?: string;
  title?: string;
  revision_id?: string;
  cursor?: string;
  budget_tokens?: number;
}

export interface ReviewAdoptOperation {
  action: 'adopt';
  idempotency_key: string;
  path: string;
  expected_etag: string;
  rationale: string;
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
      }
    | ReviewMoveOperation
    | ReviewAdoptOperation;
}

export interface ReviewMoveOperation {
  action: 'move';
  idempotency_key: string;
  id: string;
  target_path: string;
  expected_etag: string;
  rationale: string;
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
  heading?: string | null;
  start_line?: number;
  end_line?: number;
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
  protocol?: 2;
  scopes: { id: string }[];
  health: {
    gateway: 'ready' | 'recovering' | 'degraded';
    backend: 'ready' | 'unavailable';
    embeddings: 'ready' | 'unavailable' | 'unknown';
  };
  local?: {
    index: { state: 'ready' | 'unavailable'; documents?: number };
    worker: { state: string; model_fingerprint?: string };
  };
  features?: {
    reranking: boolean;
    text_search: boolean;
    fallback: boolean;
  };
  pending_operations: number;
  projects?: { scope: string; state: RepositoryProjectState; display_name?: string; relative_root?: string }[];
  operation?: MutationReceipt | ProjectEnsureResult;
  schemas?: Record<string, unknown>;
}

export interface StatusResultV2 {
  version: string;
  protocol_version: string;
  schema_version: 1;
  protocol: 2;
  projects: {
    id: string;
    display_name: string;
    relative_root: string;
    state: RepositoryProjectState;
  }[];
  health: {
    gateway: 'ready' | 'recovering' | 'degraded';
    index: 'ready' | 'unavailable';
    worker: 'ready' | 'disabled' | 'unavailable';
  };
  features: {
    reranking: boolean;
    text_search: boolean;
    fallback: boolean;
  };
  pending_operations: number;
  operation?: MutationReceipt | ProjectEnsureResultV2 | Extract<LocalOperationReceipt, { kind: 'feedback' }>;
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

export type LocalOperationState =
  | 'pending'
  | 'finalized'
  | 'conflicted'
  | 'recovery_required';

export interface LocalOperationPreconditions {
  id?: string;
  revision_id?: string;
  etag?: string;
  path?: string;
  target_path?: string;
  expected_heads?: readonly LocalExpectedHead[];
}

export interface LocalExpectedHead {
  revision_id: string;
  etag: string;
}

interface LocalOperationBase {
  project_id: string | null;
  idempotency_key: string;
}

type LocalReviewAction = Exclude<ReviewRequest['operation']['action'], 'list' | 'approve' | 'archive'>;

type LocalReviewPreconditions<Action extends LocalReviewAction> = Action extends 'resolve'
  ? { id: string; expected_heads: readonly LocalExpectedHead[] }
  : Action extends 'adopt'
    ? { path: string; etag: string }
    : Action extends 'move'
      ? { id: string; etag: string; target_path: string }
      : { id: string; etag: string };

export type LocalOperationIntent =
  | (LocalOperationBase & {
      tool: 'brain_capture';
      action: 'capture';
      payload: CaptureRequest;
      preconditions: { target_path?: string };
    })
  | (LocalOperationBase & {
      tool: 'brain_review';
      action: 'approve' | 'archive';
      payload: Extract<ReviewRequest['operation'], { action: 'approve' | 'archive' }>;
      preconditions: { id: string; etag: string };
    })
  | {
      [Action in LocalReviewAction]: LocalOperationBase & {
        tool: 'brain_review';
        action: Action;
        payload: Extract<ReviewRequest['operation'], { action: Action }>;
        preconditions: LocalReviewPreconditions<Action>;
      };
    }[LocalReviewAction]
  | (LocalOperationBase & {
      tool: 'brain_project_ensure';
      action: 'ensure';
      payload: ProjectEnsureRequest;
      preconditions: Record<string, never>;
    })
  | (LocalOperationBase & {
      tool: 'brain_feedback';
      action: 'record';
      payload: FeedbackRequest;
      preconditions: { id: string; revision_id: string };
    });

interface LocalAllocatedBase {
  operation_id: string;
  timestamp: string;
  storage_operation_ids: readonly string[];
}

export type LocalAllocatedIdentity =
  | (LocalAllocatedBase & { kind: 'note'; note_id: string; revision_id: string; path: string })
  | (LocalAllocatedBase & { kind: 'project_ensure' })
  | (LocalAllocatedBase & { kind: 'feedback'; feedback_id: string });

export interface LocalRevisionParent {
  revision_id: string;
  raw_hash: string;
}

export interface LocalObservedSource {
  path: string;
  raw: string;
  etag: string;
  id?: string;
  revision_id?: string;
  parents?: readonly LocalRevisionParent[];
}

export interface LocalConflictHead extends LocalExpectedHead {
  id: string;
  path: string;
  parents: readonly LocalRevisionParent[];
}

export interface LocalObservedState {
  sources: readonly LocalObservedSource[];
  heads: readonly LocalConflictHead[];
}

export type LocalReadCondition =
  | {
      kind: 'path';
      path: string;
      expected:
        | { kind: 'absent' }
        | { kind: 'present'; etag: string; id?: string; revision_id?: string };
    }
  | {
      kind: 'note';
      id: string;
      expected:
        | { kind: 'absent' }
        | { kind: 'present'; path: string; revision_id: string; etag: string };
    }
  | { kind: 'heads'; id: string; expected_heads: readonly LocalExpectedHead[] }
  | {
      kind: 'project';
      repository_identity: string;
      expected:
        | { kind: 'absent' }
        | { kind: 'present'; project_id: string; version: string };
    };

export type LocalReadSet = readonly [LocalReadCondition, ...LocalReadCondition[]];

export interface LocalPendingWrite {
  path: string;
  raw: string;
  id: string;
  revision_id: string;
  parents: readonly LocalRevisionParent[];
}

export type LocalDocumentEffect =
  | { kind: 'write'; write: LocalPendingWrite }
  | { kind: 'move'; from_path: string; to_path: string; write?: LocalPendingWrite }
  | { kind: 'adopt'; path: string; write: LocalPendingWrite }
  | {
      kind: 'remove';
      path: string;
      expected_id: string;
      expected_revision_id: string;
      expected_etag: string;
    };

export interface LocalReferenceEdit {
  path: string;
  expected_etag: string;
  raw: string;
  managed?: {
    id: string;
    revision_id: string;
    parents: readonly LocalRevisionParent[];
  };
}

export type LocalPlannedOperation =
  | {
      kind: 'note';
      read_set: LocalReadSet;
      heads: readonly LocalConflictHead[];
      parents: readonly LocalRevisionParent[];
      effects: readonly LocalDocumentEffect[];
      reference_edits?: readonly LocalReferenceEdit[];
    }
  | {
      kind: 'project_ensure';
      read_set: LocalReadSet;
      repository_identity: string;
      project_id: string;
      relative_root: string;
      created: boolean;
    }
  | {
      kind: 'feedback';
      read_set: LocalReadSet;
      feedback_id: string;
      id: string;
      revision_id: string;
      verdict: FeedbackVerdict;
      reason: string;
    };

export type LocalOperationPlan = (
  identity: LocalAllocatedIdentity,
  observed: LocalObservedState
) => Promise<LocalPlannedOperation> | LocalPlannedOperation;

export type LocalOperationReceipt =
  | {
      kind: 'note';
      operation_id: string;
      id: string;
      revision_id: string;
      path: string;
      etag: string;
      indexed: boolean;
      warnings: string[];
    }
  | {
      kind: 'project_ensure';
      operation_id: string;
      repository_identity: string;
      project_id: string;
      relative_root: string;
      created: boolean;
      materialized: boolean;
      warnings: string[];
    }
  | {
      kind: 'feedback';
      operation_id: string;
      feedback_id: string;
      recorded: true;
    };

export interface LocalOperationStatus {
  operation_id: string;
  tool: string;
  action: string;
  project_id: string | null;
  state: LocalOperationState;
  receipt?: LocalOperationReceipt;
}

export interface LocalRecoveryReport {
  inspected: number;
  finalized: number;
  conflicted: number;
  recovered: number;
  pending: number;
  blocking_operations: string[];
}

export interface LocalMutationCoordinatorPort {
  run(intent: LocalOperationIntent, plan: LocalOperationPlan): Promise<LocalOperationReceipt>;
  status(operation_id: string): LocalOperationStatus | undefined;
  recover(): Promise<LocalRecoveryReport>;
  enumerateConflictHeads(id: string): Promise<LocalConflictHead[]>;
  verifyConflictHeads(id: string, expected: readonly LocalExpectedHead[]): Promise<void>;
}

export interface ResolvedProject {
  id: string;
  display_name: string;
  relative_root: string;
  state: RepositoryProjectState;
  repository_identity?: string;
}

export interface ProjectResolutionPort {
  resolve(identifier: string | undefined): ResolvedProject | undefined;
  canonicalId(identifier: string): string | undefined;
  list(): ResolvedProject[];
}

export interface SourceCursorScope {
  id: string;
  path: string;
  revision_id: string;
  etag: string;
}

export interface SourceCursorPosition {
  offset: number;
}

export interface SourceBoundCursorPort {
  issue(input: SourceCursorScope & { offset: number; expires_at: string }): string;
  verify(cursor: string, scope: SourceCursorScope): SourceCursorPosition;
}

export interface LocalHandlerDeps {
  config: BrainConfig;
  documents: DocumentStore;
  catalogue: CurrentCatalogue;
  index: SearchIndex;
  journal: Journal;
  vault: CurrentVault;
  vaultRoot: string;
  clock: Clock;
  ids: IdSource;
  mutations: LocalMutationCoordinatorPort;
  projects: ProjectResolutionPort;
  cursors: SourceBoundCursorPort;
  worker?: RerankWorker;
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
export type NoteInputV1 = Omit<NoteInput, 'type' | 'source'>;
export type StoredRevisionV1 = Omit<StoredRevision, 'note'> & { note: NoteInputV1 };
