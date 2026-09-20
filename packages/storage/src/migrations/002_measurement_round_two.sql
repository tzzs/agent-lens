-- docs/plan-v2.md §18 (second measurement round). Nullable additions only: the meaning of
-- existing columns is frozen, so events written before this migration stay correct.
ALTER TABLE events ADD COLUMN thread_id TEXT;
ALTER TABLE events ADD COLUMN cost_reported REAL;
ALTER TABLE events ADD COLUMN cost_source TEXT;
ALTER TABLE events ADD COLUMN credits REAL;

-- Codex keys sessions across many thread files, so thread grain needs its own access path.
CREATE INDEX idx_events_thread ON events(thread_id);
CREATE INDEX idx_events_source_seq ON events(source_id, raw_seq);
