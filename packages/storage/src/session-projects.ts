/**
 * §4.1 attribution, one layer up: `sessions.project_id` is seeded from whichever event a batch
 * happens to carry first, and `upsertSession` COALESCEs it — so that one record owns the session
 * row forever.
 *
 * For qoder and claude-code the first record in a transcript is a bookkeeping line with no `cwd`
 * (`workspace-directories`, `runtime-config`, `active-leaf`), which the adapter reports as
 * `UNATTRIBUTED_PROJECT_ID`. That sentinel is a non-null digest, so the COALESCE reads it as
 * "already known" and the records that DO carry a cwd can never land. Measured on a live store:
 * 85 sessions sat in the unattributed bucket while their own events named the project — one of
 * them 29,664 attributed events against 5,860 unattributed.
 *
 * So a session's project is a fact about its event rows, exactly like `event_count` and
 * `first_timestamp` already are (see the recompute in write.ts), and this derives it from them.
 *
 * Deliberately narrow, in three ways:
 *  - it only ever moves a session OUT of the unknown bucket, so it is monotone and converges;
 *  - a session already attributed keeps its project — two cwds in one session is genuine
 *    ambiguity rather than this bug, and silently re-homing sessions would make the number
 *    unexplainable after the fact;
 *  - with no attributed event at all it writes nothing, so the bucket stays honest (§5.2).
 *
 * Ties are broken by the digest so two runs over the same rows cannot disagree.
 */
import type { DatabaseSync } from 'node:sqlite'
import { UNATTRIBUTED_PROJECT_ID } from '@agentlens/event-model'
import { withTransaction } from './write.ts'

export interface SessionProjectStats {
  /** Sessions parked in the unknown bucket whose own events name a project. */
  stuck: number
  /** Rows actually written this pass; 0 on a converged store. */
  upgraded: number
}

/** Sessions this pass can act on: in the unknown bucket, and holding real evidence of their own. */
const STUCK_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM sessions s
  WHERE (s.project_id IS NULL OR s.project_id = ?)
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.session_id = s.id AND e.project_id IS NOT NULL AND e.project_id <> ?
    )`

/**
 * One correlated top-1 per session: the project its own events name most often. The `EXISTS`
 * guard is what keeps a session with no evidence out of the UPDATE arm — without it the subquery
 * would return NULL and wipe the bucket value the row is supposed to keep.
 */
const UPGRADE_SQL = `
  UPDATE sessions SET project_id = (
    SELECT e.project_id FROM events e
    WHERE e.session_id = sessions.id AND e.project_id IS NOT NULL AND e.project_id <> ?
    GROUP BY e.project_id
    ORDER BY COUNT(*) DESC, e.project_id
    LIMIT 1
  )
  WHERE (project_id IS NULL OR project_id = ?)
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.session_id = sessions.id AND e.project_id IS NOT NULL AND e.project_id <> ?
    )`

type Row = Record<string, unknown>

function rowsOf(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): Row[] {
  return db.prepare(sql).all(...params) as Row[]
}

export function deriveSessionProjects(db: DatabaseSync): SessionProjectStats {
  const stuck = Number(
    rowsOf(db, STUCK_COUNT_SQL, UNATTRIBUTED_PROJECT_ID, UNATTRIBUTED_PROJECT_ID)[0]?.n ?? 0,
  )
  const upgraded = withTransaction(db, () =>
    Number(db.prepare(UPGRADE_SQL).run(UNATTRIBUTED_PROJECT_ID, UNATTRIBUTED_PROJECT_ID, UNATTRIBUTED_PROJECT_ID).changes ?? 0),
  )
  return { stuck, upgraded }
}
