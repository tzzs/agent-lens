/**
 * Fold materialisation (§7/§18 stage 1), the answer to "the dashboard re-folds the same
 * 340k events fourteen times per page load".
 *
 * Stage 1 — group every filtered event on its (agent, request) key and take the MAX of each
 * token bucket — is the single most expensive step of every token route, and a page like
 * `/api/overview` asks for it once per cube call. A `FoldCache` runs it ONCE per distinct
 * (fold key, filter) pair inside its lifetime and keeps the result in a temp table, so the
 * second and later calls read a materialised relation instead of re-folding.
 *
 * Why this cannot change a number: the temp table holds stage 1's own output rows plus the
 * stage-1 representative row's columns, and stage 2 reads exactly the same expressions it
 * would have read from the CTE — the two forms are generated from one dim definition
 * (`dimSql` in engine.ts) so they cannot drift. `test/fold-equivalence.test.ts` asserts
 * cached == inline over the real filter/dim matrix rather than trusting that argument.
 *
 * Scope: a cache lives for one dashboard request (or one CLI batch) and drops its tables in
 * `dispose()`. It never outlives the synchronous run that created it, so it can never serve
 * a row that was written after the request began. Names carry a per-cache id, so two
 * overlapping requests materialising the same key cannot collide.
 */
import type { DatabaseSync } from 'node:sqlite'

let cacheSeq = 0

export interface FoldCache {
  /**
   * Return the temp table holding this key's fold, materialising it on the first call. The
   * key covers the fold expression, the filter text and every bound filter value, so a hit
   * is the same computation, not merely a similar one.
   */
  ensure(key: string, create: (tableName: string) => FoldStatement): string
  /** Table names materialised so far; for diagnostics and tests. */
  names(): string[]
  /** Drop every table this cache created. Safe to call twice. */
  dispose(): void
}

/** A `CREATE TEMP TABLE … AS SELECT` and the values its inner filter binds. */
export interface FoldStatement {
  sql: string
  params: readonly unknown[]
}

/**
 * `create` receives the bare target table name and returns the statement that fills it. The
 * name is generated from a process-local counter and quoted at the point of use — no caller
 * string ever reaches the DDL text.
 */
export function createFoldCache(db: DatabaseSync): FoldCache {
  const id = `c${(++cacheSeq).toString(36)}`
  const tables = new Map<string, string>()
  return {
    ensure(key, create) {
      const hit = tables.get(key)
      if (hit) return hit
      const name = `agl_fold_${id}_${tables.size}`
      const stmt = create(name)
      const prepared = db.prepare(stmt.sql)
      // `run()`, not `all()`: this is a CREATE TABLE AS, and materialising 80k rows into an
      // array before dropping them is the opposite of the point.
      if (stmt.params.length) prepared.run(...(stmt.params as never[]))
      else prepared.run()
      tables.set(key, name)
      return name
    },
    names: () => [...tables.values()],
    dispose() {
      for (const name of tables.values()) db.exec(`DROP TABLE IF EXISTS temp."${name}"`)
      tables.clear()
    },
  }
}

/** Stable cache key: the fold expression, the filter text, and every bound filter value. */
export function foldKey(parts: unknown[]): string {
  return JSON.stringify(parts)
}
