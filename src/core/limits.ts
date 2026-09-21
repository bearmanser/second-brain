export const PUBLIC_ENDPOINT = 'http://127.0.0.1:7331/mcp';
export const PRIVATE_BACKEND_ENDPOINT = 'http://memory:8000/mcp';

export const GATEWAY_INSTANCES = 1;
export const BACKEND_PROCESSES = 1;

export const INPUT_BODY_MAX_BYTES = 256 * 1024;
export const RENDERED_NOTE_MAX_BYTES = 64 * 1024;
export const TOOL_RESULT_MAX_BYTES = 128 * 1024;

export const TITLE_MIN_CODE_POINTS = 1;
export const TITLE_MAX_CODE_POINTS = 160;
export const CONTENT_TEXT_MAX_CHARS = 8000;
export const MARKDOWN_BODY_MAX_CHARS = 32000;

export const TAGS_MAX_ITEMS = 24;
export const EVIDENCE_MAX_ITEMS = 32;
export const RELATED_IDS_MAX_ITEMS = 32;
export const TEXTS_MAX_ITEMS = 32;

export const RECALL_BUDGET_TOKENS_DEFAULT = 1500;
export const RECALL_BUDGET_TOKENS_MIN = 256;
export const RECALL_BUDGET_TOKENS_MAX = 4000;
export const RECALL_LIMIT_DEFAULT = 6;
export const RECALL_LIMIT_MAX = 12;

export const READ_BUDGET_TOKENS_DEFAULT = 4000;
export const READ_BUDGET_TOKENS_MIN = 256;
export const READ_BUDGET_TOKENS_MAX = 8000;

export const BACKEND_SEARCH_PAGES = 4;
export const BACKEND_SEARCH_PAGE_SIZE = 40;
export const RECALL_MAX_SCOPES = 2;
export const BACKEND_TIMEOUT_MS = 15_000;
export const MATERIALIZATION_TIMEOUT_MS = 10_000;
export const RECONCILE_INTERVAL_MS = 30_000;
export const SESSION_FRESHNESS_DAYS = 7;
export const CURSOR_TTL_MS = 10 * 60 * 1000;
export const AUDIT_RETENTION_DAYS = 30;
export const CONCURRENT_READS = 8;
export const WRITE_COORDINATORS = 1;
export const PROJECT_PROVISION_PER_PRINCIPAL_PER_MINUTE = 10;
export const PROJECT_PROVISION_GLOBAL_PER_MINUTE = 50;
export const DYNAMIC_PROJECTS_MAX = 1000;

export const SCOPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const ETAG_PATTERN = /^[a-f0-9]{64}$/;
