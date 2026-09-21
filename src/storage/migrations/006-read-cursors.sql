CREATE TABLE read_cursors (
  cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX read_cursors_expiry ON read_cursors(expires_at);
