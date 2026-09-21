import { z } from 'zod';
import { BrainError } from '../contracts/errors.js';
import { BACKEND_SEARCH_PAGE_SIZE, BACKEND_SEARCH_PAGES } from '../core/limits.js';
import type {
  BackendHit,
  BackendSearch,
  Lifecycle,
  NoteKind,
  PlannedWrite,
  RecallMode
} from '../core/types.js';

export const WRITE_NOTE_TOOL = 'write_note';
export const SEARCH_NOTES_TOOL = 'search_notes';
export const READ_NOTE_TOOL = 'read_note';
export const LIST_MEMORY_PROJECTS_TOOL = 'list_memory_projects';
export const CREATE_MEMORY_PROJECT_TOOL = 'create_memory_project';

export const REQUIRED_BACKEND_TOOLS = [
  WRITE_NOTE_TOOL,
  SEARCH_NOTES_TOOL,
  READ_NOTE_TOOL,
  LIST_MEMORY_PROJECTS_TOOL,
  CREATE_MEMORY_PROJECT_TOOL
] as const;

export const BRAIN_STATUS_KEY = 'brain_status';
export const BRAIN_ID_KEY = 'brain_id';
export const BRAIN_REVISION_ID_KEY = 'brain_revision_id';

export const protocolError = (message: string, cause?: unknown): BrainError =>
  new BrainError({ code: 'BACKEND_PROTOCOL_ERROR', message, cause });

export const invalidInput = (message: string, cause?: unknown): BrainError =>
  new BrainError({ code: 'INVALID_INPUT', message, cause });

export interface WriteNoteArguments {
  project: string;
  title: string;
  directory: string;
  note_type: NoteKind;
  content: string;
  metadata: Record<string, unknown>;
  overwrite: false;
  output_format: 'json';
}

export interface MetadataInFilter<T> {
  $in: T[];
}

export interface SearchNotesArguments {
  project: string;
  query: string;
  search_type: RecallMode;
  note_types: NoteKind[];
  metadata_filters: { brain_status: MetadataInFilter<Lifecycle> };
  page: number;
  page_size: number;
  search_all_projects: false;
  output_format: 'json';
}

export interface IndexedLookupArguments {
  project: string;
  query: null;
  search_all_projects: false;
  output_format: 'json';
  page: 1;
  page_size: 1;
  metadata_filters: { brain_revision_id: string };
}

export interface CreateMemoryProjectArguments {
  project_name: string;
  project_path: string;
  set_default: false;
  output_format: 'json';
}

export function argumentsForProjectCreate(
  project: string,
  projectPath: string
): CreateMemoryProjectArguments {
  return {
    project_name: project,
    project_path: projectPath,
    set_default: false,
    output_format: 'json'
  };
}

export function argumentsForCreate(write: PlannedWrite): WriteNoteArguments {
  return {
    project: write.backend_project,
    title: write.storage_title,
    directory: write.directory,
    note_type: write.revision.note.content.kind,
    content: write.body,
    metadata: { ...write.metadata, permalink: write.permalink },
    overwrite: false,
    output_format: 'json'
  };
}

export function argumentsForSearch(input: BackendSearch): SearchNotesArguments {
  assertSearchPagination(input.page, input.page_size);
  return {
    project: input.project,
    query: input.query,
    search_type: input.mode,
    note_types: [...input.kinds],
    metadata_filters: { [BRAIN_STATUS_KEY]: { $in: [...input.statuses] } },
    page: input.page,
    page_size: input.page_size,
    search_all_projects: false,
    output_format: 'json'
  };
}

export function assertSearchPagination(page: number, page_size: number): void {
  if (!Number.isInteger(page) || page < 1 || page > BACKEND_SEARCH_PAGES) {
    throw invalidInput(`backend search page must be an integer in 1..${BACKEND_SEARCH_PAGES}`);
  }
  if (!Number.isInteger(page_size) || page_size < 1 || page_size > BACKEND_SEARCH_PAGE_SIZE) {
    throw invalidInput(
      `backend search page_size must be an integer in 1..${BACKEND_SEARCH_PAGE_SIZE}`
    );
  }
}

export function argumentsForIndexedLookup(
  project: string,
  revision_id: string
): IndexedLookupArguments {
  return {
    project,
    query: null,
    search_all_projects: false,
    output_format: 'json',
    page: 1,
    page_size: 1,
    metadata_filters: { [BRAIN_REVISION_ID_KEY]: revision_id }
  };
}

export const createResponseSchema = z.object({
  title: z.string(),
  permalink: z.string(),
  file_path: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
  action: z.string(),
  error: z.string().optional()
});

export type CreateResponse = z.infer<typeof createResponseSchema>;

export const searchHitSchema = z.object({
  title: z.string(),
  type: z.string(),
  score: z.number(),
  entity: z.string(),
  external_id: z.string(),
  permalink: z.string(),
  content: z.string(),
  matched_chunk: z.string().optional(),
  file_path: z.string(),
  updated_at: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  entity_id: z.number().optional()
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchHitSchema),
  current_page: z.number().optional(),
  page_size: z.number().optional(),
  total: z.number().optional(),
  total_is_exact: z.boolean().optional(),
  has_more: z.boolean()
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const projectSchema = z.object({
  name: z.string(),
  path: z.string()
});

export const projectsResponseSchema = z.object({
  projects: z.array(projectSchema)
});

export const projectCreateResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  created: z.boolean(),
  already_exists: z.boolean()
});

const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export function toBackendHit(hit: SearchHit): BackendHit {
  return {
    permalink: hit.permalink,
    relative_path: hit.file_path,
    revision_id: metadataString(hit.metadata, BRAIN_REVISION_ID_KEY) ?? '',
    logical_id: metadataString(hit.metadata, BRAIN_ID_KEY) ?? '',
    rank: hit.score,
    matched_text: hit.matched_chunk ?? hit.content
  };
}

export function decodeCreateResponse(value: unknown): {
  permalink: string;
  relative_path?: string;
} {
  const parsed = createResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError('write_note response did not match the observed backend shape');
  }
  if (parsed.data.action === 'conflict') {
    throw new BrainError({
      code: 'CONFLICT',
      message: `write_note refused to overwrite an existing note (${parsed.data.error ?? 'conflict'})`
    });
  }
  if (parsed.data.action !== 'created') {
    throw protocolError(`write_note returned an unknown action: ${parsed.data.action}`);
  }
  return parsed.data.file_path === null || parsed.data.file_path === undefined
    ? { permalink: parsed.data.permalink }
    : { permalink: parsed.data.permalink, relative_path: parsed.data.file_path };
}

export function decodeSearchResponse(value: unknown): {
  hits: BackendHit[];
  has_more: boolean;
} {
  const parsed = searchResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError('search_notes response did not match the observed backend shape');
  }
  return {
    hits: parsed.data.results.map(toBackendHit),
    has_more: parsed.data.has_more
  };
}

export function decodeProjectNames(value: unknown): string[] {
  const parsed = projectsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError('list_memory_projects response did not match the observed backend shape');
  }
  return parsed.data.projects.map((project) => project.name);
}

export function decodeProjects(value: unknown): Array<{ name: string; path: string }> {
  const parsed = projectsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError('list_memory_projects response did not match the observed backend shape');
  }
  return parsed.data.projects.map((project) => ({ name: project.name, path: project.path }));
}

export function decodeProjectCreateResponse(
  value: unknown,
  expectedProject: string,
  expectedPath: string
): { created: boolean } {
  const parsed = projectCreateResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError('create_memory_project response did not match the observed backend shape');
  }
  if (parsed.data.name !== expectedProject || parsed.data.path !== expectedPath) {
    throw protocolError('create_memory_project returned an unexpected project identity');
  }
  if (parsed.data.created === parsed.data.already_exists) {
    throw protocolError('create_memory_project returned an inconsistent creation state');
  }
  return { created: parsed.data.created };
}

export function assertRequiredBackendTools(tools: readonly string[]): void {
  const observed = new Set(tools);
  for (const name of REQUIRED_BACKEND_TOOLS) {
    if (!observed.has(name)) {
      throw protocolError(`backend is missing the required tool ${name}`);
    }
  }
}
