-- §8/§18: plan credits join the persisted stage-1 fold.
--
-- `credits` was already stored per event (Qoder bills through a credit economy, and §18 rows
-- 1-2 keep it out of `cost_reported` because credits are not dollars), but nothing read it:
-- the only usage signal a credit-plan agent writes was a dead column. It folds as a
-- quantity, exactly like `rep_cost` — `MAX(credits)` over the request group, NULLs skipped —
-- so "this agent has no credit economy" stays distinct from "it burned zero credits".
--
-- The column alone is not enough: `requests` rows folded before this migration would carry
-- NULL credits and still satisfy every certificate the reader checks (the grouping is
-- unchanged, and `member_count` still matches `events`), so the fast path would answer 0 for
-- a real 1,248.4. Clearing the sentinel row is the invalidation: `backfillRequestFold` re-folds
-- from `events` on the next migrate() through the one statement the write path uses, and
-- until it has run, `persistedFold` declines and the live fold answers — a decline costs
-- time and never costs a number.
ALTER TABLE requests ADD COLUMN credits REAL;
DELETE FROM requests;
DELETE FROM requests_state;
