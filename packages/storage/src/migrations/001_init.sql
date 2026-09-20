-- AgentLens initial schema (docs/plan-v2.md §3.1, §3.2, §4.3, §5.2, §6).
-- Timestamps are INTEGER ms epoch; booleans are INTEGER 0/1.
-- Table order follows FK dependency order.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  display_name     TEXT,
  detected_version TEXT,
  data_root        TEXT,
  last_seen_at     INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  canonical_root TEXT,
  display_name   TEXT,
  source         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_canonical_root ON projects(canonical_root);

CREATE TABLE IF NOT EXISTS models (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name     TEXT NOT NULL,
  tier     TEXT,
  UNIQUE (provider, name, tier)
);

CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT REFERENCES agents(id),
  path             TEXT,
  kind             TEXT CHECK (kind IN ('jsonl', 'sqlite', 'ndir')),
  inode            INTEGER,
  size             INTEGER,
  mtime_ms         INTEGER,
  last_offset      INTEGER,
  parser_version   INTEGER,
  session_id_hint  TEXT,
  status           TEXT CHECK (status IN ('active', 'gone', 'error', 'rotated')),
  last_error       TEXT,
  scan_started_at  INTEGER,
  scan_finished_at INTEGER,
  rows_ingested    INTEGER
);

-- All FK columns are nullable so an event may land before its parent row is upserted
-- within the same transaction; the collector fills the rest.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  host_id         TEXT,
  project_id      TEXT REFERENCES projects(id),
  source_id       TEXT REFERENCES sources(id),
  first_timestamp INTEGER,
  last_timestamp  INTEGER,
  title           TEXT,
  event_count     INTEGER DEFAULT 0,
  duration_ms     INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  schema_version      INTEGER,
  agent_id            TEXT,
  host_id             TEXT,
  source_id           TEXT REFERENCES sources(id),
  session_id          TEXT REFERENCES sessions(id),
  project_id          TEXT REFERENCES projects(id),
  parent_event_id     TEXT,
  request_id          TEXT,
  timestamp           INTEGER,
  ingested_at         INTEGER,
  type                TEXT,
  subtype             TEXT,
  model_rowid         INTEGER REFERENCES models(rowid),
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  reasoning_tokens    INTEGER,
  usage_source        TEXT,
  capability_type     TEXT,
  capability_name     TEXT,
  capability_provider TEXT,
  duration_ms         INTEGER,
  status              TEXT,
  error_fingerprint   TEXT,
  raw_seq             INTEGER,
  raw_offset          INTEGER,
  content_ref         TEXT,
  metadata            TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, raw_seq);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);
-- Capability is a top-tier page (§10), so it needs its own access path.
CREATE INDEX IF NOT EXISTS idx_events_capability ON events(capability_type, capability_name);

CREATE TABLE IF NOT EXISTS payloads (
  event_id   TEXT PRIMARY KEY REFERENCES events(id),
  kind       TEXT,
  role       TEXT,
  -- zlib-compressed UTF-8 text; compression happens in code (§3.2).
  text       BLOB,
  bytes      INTEGER,
  truncated  INTEGER DEFAULT 0,
  created_at INTEGER
);

-- §5.2 rule 1: adapters never fail silently; doctor reads this table (§11).
CREATE TABLE IF NOT EXISTS parse_errors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT,
  agent_id      TEXT,
  path          TEXT,
  raw_seq       INTEGER,
  raw_offset    INTEGER,
  reason        TEXT,
  raw_line      TEXT,
  upstream_type TEXT,
  created_at    INTEGER
);
