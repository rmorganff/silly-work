-- silly-work 0001: Work-only Turso DB (aws-eu-west-1).
-- doc_id is free text: colons, slashes and dots are all legal (e.g. 'lms-fix-123', 'cardn:2026-11').
-- A deleted doc stays as a tombstone (data IS NULL) so changes?since_seq can tell a poller it went.

CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data       TEXT,                       -- JSON text exactly as written; NULL = tombstone
  version    INTEGER NOT NULL DEFAULT 1, -- +1 on every write; ifVersion compares to this
  seq        INTEGER NOT NULL,           -- global, monotonic; set from seq_counter on every write
  updated_at TEXT NOT NULL,              -- ISO 8601 UTC
  PRIMARY KEY (collection, doc_id)
);
CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq);
CREATE INDEX IF NOT EXISTS docs_collection_seq ON docs (collection, seq);

-- One row (id = 1). Every write does value = value + 1 inside its transaction and stamps that on the doc.
CREATE TABLE IF NOT EXISTS seq_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO seq_counter (id, value) VALUES (1, 0);

-- A retried write carrying the same silly_wid is answered as "again" and never done twice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  silly_wid  TEXT PRIMARY KEY,
  collection TEXT,
  doc_id     TEXT,
  created_at TEXT NOT NULL
);

-- Slack triage context and pending reply/kudos drafts. Sent only on Ronnie's tap (User xoxp- chat.postMessage).
-- expires_at = sent_at/dismissal + 7 days; rows past it are purged.
CREATE TABLE IF NOT EXISTS slack_drafts (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT,
  thread_ts       TEXT,
  kind            TEXT,   -- reply | kudos
  draft_text      TEXT,
  context_summary TEXT,
  status          TEXT,   -- pending | sent | dismissed
  created_at      TEXT,
  sent_at         TEXT,
  expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS slack_drafts_expires ON slack_drafts (expires_at);

-- Who did what. Targets are collection/doc_id and rule names only: never document content.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  action     TEXT,
  target     TEXT,
  created_at TEXT
);
