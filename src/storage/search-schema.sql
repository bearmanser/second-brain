CREATE TABLE IF NOT EXISTS documents (
  document_key TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  project TEXT,
  project_norm TEXT,
  project_leaf TEXT,
  aliases_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(type);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);
CREATE INDEX IF NOT EXISTS documents_project_idx ON documents(project);
CREATE INDEX IF NOT EXISTS documents_id_idx ON documents(id);

CREATE TABLE IF NOT EXISTS chunks (
  row_id INTEGER PRIMARY KEY,
  chunk_key TEXT NOT NULL UNIQUE,
  document_key TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT,
  aliases_text TEXT NOT NULL,
  tags_text TEXT NOT NULL,
  line_from INTEGER NOT NULL,
  line_to INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  reference_tokens_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_key);
CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title,
  aliases,
  tags,
  heading,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS document_properties (
  document_key TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS document_properties_key_idx ON document_properties(key);

CREATE TABLE IF NOT EXISTS document_aliases (
  document_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS document_aliases_norm_idx ON document_aliases(alias_norm);

CREATE TABLE IF NOT EXISTS document_links (
  link_id INTEGER PRIMARY KEY,
  source_document_key TEXT NOT NULL,
  source_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  reference_target TEXT NOT NULL,
  reference_fragment TEXT,
  reference_syntax TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS document_links_source_idx ON document_links(source_document_key);
