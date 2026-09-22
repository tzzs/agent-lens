-- §19 ("立方体在 343k 事件下的量级"): stage 1 persisted.
--
-- One stage-1 fold measured 2.86 s to build a temporary B-tree over 343,303 rows keyed by
-- (agent_id, 64-char request key) plus 2.57 s for stage 2 to re-attach the dimensions
-- through `e.id = r.rep_id`. The cube already shares ONE such materialisation per request
-- (`fold-cache.ts`), so the remaining cost is that every request pays it again, and the CLI
-- pays it once per statement. This table is the same relation, made durable and kept in
-- step by the write path: token/cost routes then scan ~1 row per request instead of
-- folding ~1 row per event, and the dimension re-attach is already done.
--
-- SHAPE: byte-for-byte the columns `materialiseFoldSql` produces (grouping key, folded
-- values, the representative row's dim columns), plus a time-window certificate. The
-- vocabulary comes from `@agentlens/event-model`'s REQUEST_FOLD_* lists, which the cube
-- reads from too, so the persisted relation and the inline fold cannot drift (§14).
--
-- WHAT IS NOT HERE: any computed money. `rep_cost` is the agent's OWN reported number, a
-- fact stored on the row; the priced half of §18 row 1's fusion still resolves at read time
-- against the current price table — the same reason §19 kept `pricing_gap` derived, since
-- `agl pricing update` can make a stored verdict a lie.
--
-- NO FOREIGN KEYS: `rep_id` is not a child of one event but the MAX(id) of a group, so no
-- FK action expresses "recompute me when any member moves". Deleting a member silently
-- changes the group's MAX, which is why `prune` and §5.3's repair path DELETE and re-fold
-- the affected keys rather than merging them (`packages/storage/src/request-fold.ts` owns
-- that), and why `requestFoldHealth` reports to both doctors the drift it cannot forbid.
CREATE TABLE IF NOT EXISTS requests (
  agent_key      TEXT    NOT NULL,             -- COALESCE(agent_id, ''), the §18 per-agent fold partition
  req_key        TEXT    NOT NULL,             -- request_id under request_max, event id under the sum modes
  rep_id         TEXT,                         -- MAX(id) in the group: the row the dims came from
  tokens_input   INTEGER NOT NULL DEFAULT 0,   -- MAX(COALESCE(col, 0)) over the group
  tokens_output  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning   INTEGER NOT NULL DEFAULT 0,
  duration       INTEGER NOT NULL DEFAULT 0,
  rep_cost       REAL,                         -- MAX(cost_reported); NULL means "nobody reported" (§8)
  member_count   INTEGER NOT NULL DEFAULT 0,   -- events folded into this row
  ts_count       INTEGER NOT NULL DEFAULT 0,   -- of those, how many carry a timestamp
  min_ts         INTEGER,                      -- window certificate: the group spans [min_ts, max_ts]
  max_ts         INTEGER,
  -- The representative row's columns, i.e. exactly what stage 2 used to re-read from events.
  timestamp      INTEGER,
  agent_id       TEXT,
  host_id        TEXT,
  project_id     TEXT,
  session_id     TEXT,
  thread_id      TEXT,
  capability_type TEXT,
  capability_name TEXT,
  status         TEXT,
  usage_source   TEXT,
  model_rowid    INTEGER,
  PRIMARY KEY (agent_key, req_key)
);

-- Singleton build state: the grouping the rows were folded under, so a reader holding a
-- different §18 policy map refuses the fast path instead of answering from the wrong grain.
CREATE TABLE IF NOT EXISTS requests_state (
  slot               INTEGER PRIMARY KEY CHECK (slot = 0),
  policy_fingerprint TEXT    NOT NULL,
  built_at           INTEGER NOT NULL,
  rebuilt_at         INTEGER
);
