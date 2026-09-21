import { createHash } from 'node:crypto';
import { BrainError } from '../contracts/errors.js';
import { captureRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps, MutationAdvisory, MutationIntent, RevisionBuilder } from '../core/mutation.js';
import { NOTE_KINDS, LIFECYCLES } from '../core/types.js';
import type {
  BackendHit,
  CaptureRequest,
  MutationReceipt,
  NoteInput,
  RequestContext,
  ScopeConfig,
  SourceRef,
  StoredRevision
} from '../core/types.js';
import { decodeRevision, makeEtag } from '../notes/codec.js';
import { resolveScopes } from '../security/authorise.js';
import { assertNoCredentials } from '../security/redact.js';
import { authorizeRelatedIds } from './related.js';

const CAPTURE_TOOL = 'brain_capture';
const DUPLICATE_PAGE_SIZE = 5;
export const DUPLICATE_CHECK_UNAVAILABLE = 'duplicate_check_unavailable';
export const DUPLICATE_DETAILS_WITHHELD = 'duplicate_details_withheld';

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function parseCaptureRequest(input: CaptureRequest): CaptureRequest {
  const parsed = captureRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`capture request is invalid: ${detail}`);
  }
  return parsed.data;
}

function normalizeString(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeNote(note: NoteInput): NoteInput {
  const content = normalizeValue(note.content) as NoteInput['content'];
  return {
    title: normalizeString(note.title),
    tags: note.tags.map((tag) => normalizeString(tag)),
    content,
    evidence: note.evidence.map(
      (entry): NoteInput['evidence'][number] => ({
        kind: entry.kind,
        ref: normalizeString(entry.ref),
        description: normalizeString(entry.description),
        ...(entry.observed_at === undefined ? {} : { observed_at: entry.observed_at })
      })
    ),
    related_ids: [...note.related_ids]
  };
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) normalized[key] = normalizeValue(source[key]);
    return normalized;
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalize(source[key]);
    return ordered;
  }
  return value;
}

function normalizedPayloadDigest(note: NoteInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(note)), 'utf8').digest('hex');
}

function collectStrings(
  value: unknown,
  field: string,
  found: { field: string; value: string }[]
): void {
  if (typeof value === 'string') {
    found.push({ field, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${field}[${index}]`, found));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, field.length === 0 ? key : `${field}.${key}`, found);
    }
  }
}

function rejectCredentialText(note: NoteInput): void {
  const strings: { field: string; value: string }[] = [];
  collectStrings(note, 'note', strings);
  for (const entry of strings) {
    assertNoCredentials(entry.value, entry.field);
  }
}

function authorizeScope(
  ctx: RequestContext,
  requested: string,
  deps: BrainDeps
): ScopeConfig {
  const [scope] = resolveScopes(ctx.principal, requested, false, 'write', deps.scopeRegistry);
  return scope;
}

function vaultRelativePath(scope: ScopeConfig, relativePath: string): string {
  const prefix = `${scope.relative_root}/`;
  return relativePath.startsWith(prefix) ? relativePath : `${scope.relative_root}/${relativePath}`;
}

async function resolveCatalogueHit(
  scope: ScopeConfig,
  hit: BackendHit,
  deps: BrainDeps
): Promise<SourceRef | undefined> {
  if (hit.logical_id === '') return undefined;
  try {
    const head =
      hit.revision_id !== ''
        ? await deps.catalogue.getRevision(scope.id, hit.logical_id, hit.revision_id)
        : await deps.catalogue.get(scope.id, hit.logical_id);
    return head.source;
  } catch {
    return undefined;
  }
}

async function resolveHit(
  scope: ScopeConfig,
  hit: BackendHit,
  deps: BrainDeps
): Promise<SourceRef | undefined> {
  const catalogued = await resolveCatalogueHit(scope, hit, deps);
  if (catalogued !== undefined) return catalogued;
  if (hit.relative_path === '') return undefined;
  try {
    const read = await deps.vault.read(scope.id, vaultRelativePath(scope, hit.relative_path));
    const revision = decodeRevision(read.raw);
    return {
      id: revision.id,
      revision_id: revision.revision_id,
      scope: revision.scope,
      title: revision.note.title,
      kind: revision.note.content.kind,
      status: revision.status,
      etag: makeEtag(revision.revision_id, read.raw_hash),
      relative_path: read.relative_path,
      warnings: []
    };
  } catch {
    return undefined;
  }
}

interface DuplicateLookup {
  duplicates: SourceRef[];
  warnings: string[];
}

async function findPossibleDuplicates(
  ctx: RequestContext,
  scope: ScopeConfig,
  note: NoteInput,
  deps: BrainDeps
): Promise<DuplicateLookup> {
  if (!ctx.principal.read_scopes.includes(scope.id)) {
    return { duplicates: [], warnings: [DUPLICATE_CHECK_UNAVAILABLE] };
  }
  let hits: BackendHit[];
  try {
    const result = await deps.backend.search({
      project: scope.backend_project,
      query: note.title,
      mode: 'hybrid',
      kinds: [...NOTE_KINDS],
      statuses: [...LIFECYCLES],
      page: 1,
      page_size: DUPLICATE_PAGE_SIZE
    });
    hits = result.hits;
  } catch {
    return { duplicates: [], warnings: [DUPLICATE_CHECK_UNAVAILABLE] };
  }
  const duplicates: SourceRef[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const hit of hits) {
    const source = await resolveHit(scope, hit, deps);
    if (source === undefined) {
      partial = true;
      continue;
    }
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    duplicates.push(source);
  }
  return { duplicates, warnings: partial ? [DUPLICATE_CHECK_UNAVAILABLE] : [] };
}

function filterReadableDuplicates(
  ctx: RequestContext,
  receipt: MutationReceipt
): MutationReceipt {
  if (receipt.possible_duplicates.length === 0) return receipt;
  const readable = new Set(ctx.principal.read_scopes);
  const visible = receipt.possible_duplicates.filter((entry) => readable.has(entry.scope));
  if (visible.length === receipt.possible_duplicates.length) return receipt;
  const warnings = [...receipt.warnings];
  if (!warnings.includes(DUPLICATE_DETAILS_WITHHELD)) warnings.push(DUPLICATE_DETAILS_WITHHELD);
  return { ...receipt, possible_duplicates: visible, warnings };
}

export async function capture(
  ctx: RequestContext,
  input: CaptureRequest,
  deps: BrainDeps
): Promise<MutationReceipt> {
  const request = parseCaptureRequest(input);
  const scope = authorizeScope(ctx, request.scope, deps);
  const note = normalizeNote(request.note);

  await authorizeRelatedIds(ctx, note.related_ids, deps);
  rejectCredentialText(note);

  const lookup = await findPossibleDuplicates(ctx, scope, note, deps);
  const advisory: MutationAdvisory = {
    warnings: lookup.warnings,
    possible_duplicates: lookup.duplicates
  };

  const intent: MutationIntent = {
    tool: CAPTURE_TOOL,
    scope: scope.id,
    idempotency_key: request.idempotency_key,
    payload: { note, payload_digest: normalizedPayloadDigest(note) },
    expected_heads: [],
    advisory
  };

  const build: RevisionBuilder = (identities, heads): StoredRevision => ({
    id: identities.note_id,
    revision_id: identities.revision_id,
    parents: heads.map((head) => ({
      revision_id: head.revision.revision_id,
      raw_hash: head.raw_hash
    })),
    scope: scope.id,
    status: 'candidate',
    note,
    created_at: identities.timestamp,
    modified_at: identities.timestamp,
    operation_id: identities.operation_id,
    extra_frontmatter: {},
    extra_markdown: ''
  });

  return filterReadableDuplicates(ctx, await deps.mutations.commit(ctx, intent, build));
}
