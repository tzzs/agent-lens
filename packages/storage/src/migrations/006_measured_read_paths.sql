-- One access path the measured dashboard routes asked for, and one it did not — recorded
-- here so the second one is not re-added on the strength of the old number.

-- The Projects page prints which cwds were observed per canonical project (§4.1's evidence
-- for worktree folding). That is a GROUP BY over an expression no index covered: a full scan
-- of every event in the store, measured 244 ms warm against 91 ms with this index — 2.7x for
-- +25 MB. The rest of the page now costs ~0.5 s, so the scan was most of it.
CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(project_id, json_extract(metadata, '$.cwd'));
