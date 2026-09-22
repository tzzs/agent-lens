/**
 * §4.1 attribution, one layer up: `sessions.title` has no writer in the ingest path, so the
 * session list — the product's #1 surface per §10 — read "Untitled claude-code session" for
 * all 450 sessions on a machine whose logs contain 5,338 title records.
 *
 * The evidence is already stored. `custom-title` / `ai-title` are host-metadata records
 * (§5.3 keeps them rather than dropping them, precisely because the UI wants session titles),
 * and the adapter parks their fields under `metadata.value`, so the title of a session is a
 * fact about rows already in the store. This derives it from those rows, which makes the
 * result a pure function of the store: replay changes nothing (§4.2), and a session whose
 * title row arrived through a different source file gets the same answer either way.
 *
 * Two rules worth naming:
 *  - a human-set `custom-title` outranks a generated `ai-title` regardless of arrival order,
 *    because the generated one is a guess about the conversation and the set one is what the
 *    user called it;
 *  - within a kind, the newest record wins, ordered by the canonical timeline order so equal
 *    timestamps do not resolve by rowid accident.
 *
 * A session with no title evidence keeps NULL — the surfaces render their own fallback. Inventing
 * a title from a message body would be a content-layer read (§3.2 defaults off) and would put
 * words on screen the user never wrote.
 */
import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './write.ts'

export interface SessionTitleStats {
  /** Sessions that carry title evidence in their rows. */
  withEvidence: number
  /** Rows actually written this pass; 0 on a converged store. */
  updated: number
}

interface TitleRow {
  session_id: string
  title: string
  subtype: string
}

export function selectSessionTitle(rows: readonly TitleRow[]): string | null {
  // Ordered by the caller as (timestamp, raw_seq, id) ascending, so the LAST matching row is the
  // newest. A human title outranks the generated one even if the generator wrote later.
  let human: string | null = null
  let generated: string | null = null
  for (const r of rows) {
    const text = r.title?.trim()
    if (!text) continue
    if (r.subtype === 'custom-title') human = text
    else if (r.subtype === 'ai-title') generated = text
  }
  return human ?? generated
}

const TITLE_ROWS_SQL = `
  SELECT session_id, subtype, json_extract(metadata, '$.value.title') AS title
  FROM events
  WHERE type = 'unknown'
    AND subtype IN ('custom-title', 'ai-title')
    AND session_id IS NOT NULL
    AND TRIM(COALESCE(json_extract(metadata, '$.value.title'), '')) <> ''
  ORDER BY session_id, timestamp, raw_seq IS NULL, raw_seq, id`

/**
 * Fill `sessions.title` from the rows already stored. Idempotent by construction: the UPDATE only
 * fires where the derived title differs (NULL-safe `IS NOT`), so a second pass with the same
 * evidence writes zero rows.
 */
export function deriveSessionTitles(db: DatabaseSync): SessionTitleStats {
  const rows = db.prepare(TITLE_ROWS_SQL).all() as unknown as TitleRow[]
  const bySession = new Map<string, TitleRow[]>()
  for (const row of rows) {
    const list = bySession.get(row.session_id)
    if (list) list.push(row)
    else bySession.set(row.session_id, [row])
  }

  // `IS NOT` rather than `<>`: the stored value is usually NULL, and NULL <> x is NULL, which
  // would silently skip the very rows this pass exists to fill (§5.3 uses the same guard).
  const write = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title IS NOT ?')
  const updated = withTransaction(db, () => {
    let n = 0
    for (const [sessionId, candidates] of bySession) {
      const title = selectSessionTitle(candidates)
      if (title === null) continue
      n += Number(write.run(title, sessionId, title).changes ?? 0)
    }
    return n
  })
  return { withEvidence: bySession.size, updated }
}
