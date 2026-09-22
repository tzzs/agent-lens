-- The session-title projection (§10) reads every `custom-title` / `ai-title` row the store holds
-- and no index reached them, so `deriveSessionTitles` scanned the whole event table to find 5,356
-- rows out of 398,794: measured 1.44 s cold / 164 ms warm, against 8 ms with this index.
--
-- It used to cost that once per `scan`. `watch` now runs the projection whenever a batch lands a
-- title record — which for claude-code is often, since it re-emits the title alongside ordinary
-- transcript lines — so an unindexed pass would put a whole-store scan on the watcher's tick.
--
-- Partial on purpose: the population is tiny and fixed by subtype, so the index stays small
-- (+~0.2 MB here) and the write path barely notices it. `type = 'unknown'` is left out of the
-- predicate because the query still filters on it; the planner uses this index either way.
CREATE INDEX IF NOT EXISTS idx_events_session_title ON events(session_id, timestamp, raw_seq)
  WHERE subtype IN ('custom-title', 'ai-title');
