-- §2 Machine tier: a per-install identity for the entity ladder (Machine → Agent → Host → …).
-- The value is forward-looking: when two AgentLens databases are ever merged (multi-machine,
-- Team-synced store), each must be able to say WHICH install produced its rows without
-- re-attributing anything retroactively. Identity travels inside the database file itself —
-- a copy of a store carries its machine row with it, which a sidecar config file would not.
--
-- WHY one row, not a join table: today the tool is single-user, single-machine, and
-- `host_id` (§18 row 6) already distinguishes CLI vs desktop ON the machine, so a per-event
-- machine column would be a schema change (§6/§15 M5 freeze) that buys nothing yet. The
-- machine is therefore one row per database, and every row in that database belongs to it.
--
-- WHY a random UUIDv4: never a hostname (collides across labs, leaks identity), never a
-- username or any personal identifier (the §16 privacy posture is "local, no telemetry");
-- uniqueness across future merges is exactly what a random 122-bit namespace provides.
--
-- `slot = 0` is the SQLite singleton pattern: the table physically cannot hold a second
-- machine id, so concurrent first-run mints converge on one row via ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS machine (
  slot      INTEGER PRIMARY KEY CHECK (slot = 0),
  id        TEXT    NOT NULL CHECK (length(id) = 36),
  minted_at INTEGER NOT NULL
)
