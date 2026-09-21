-- §18 row 2: how tokens fold is a per-agent property, and it has to survive the
-- writer that recorded the rows — an event ingested under Codex's cumulative-usage
-- rule must keep folding under that rule even after the adapter's declaration changes.
ALTER TABLE agents ADD COLUMN aggregation_mode TEXT;
ALTER TABLE agents ADD COLUMN subagents_included INTEGER;

-- scanSource rescan-on-drift joins sources by agent_id (§5.3); until now it was a full scan.
CREATE INDEX IF NOT EXISTS idx_sources_agent ON sources(agent_id);
