-- §4.3: for a row store `last_offset` carries the rowid high-water mark, and a rowid means
-- nothing without the table it counts — so the table name gets its own extension column and
-- a stored `sources` row stays interpretable without the adapter that minted it.
--
-- WHY the row's `source_id` is salted instead of being §4.1's literal `hash(agent + path)`:
-- one store can hold several interesting tables (OpenCode: `session`, `message`, `part` in one
-- db file), and a path-only id would collapse them onto a single row with one shared
-- watermark. The salt `{db}#{table}` keeps one row per table; `sqlite_table` records the
-- `{table}` half of it, which is otherwise only recoverable by re-running `discover()`.
ALTER TABLE sources ADD COLUMN sqlite_table TEXT;
