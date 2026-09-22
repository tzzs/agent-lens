/**
 * `doctor` (§11) — the trust exit of the whole tool. Every number here is read from REAL
 * rows or REAL directory entries: the dedup line re-uses event-model's fold against the same
 * rows the cube aggregates, and the two are compared rather than assumed equal.
 *
 * Safety (§18 row 7): this command only stats, lists, and reads text logs. It never opens,
 * moves, chmods or "cleans up" anything outside the repo, and a foreign SQLite file is
 * sniffed through its 100-byte header instead of being opened — an earlier read-only OPEN
 * created `-wal`/`-shm` sidecars in the owner's data directory.
 *
 * Root override: `AGENTLENS_AGENT_ROOT` relocates every agent data root this command probes,
 * doing for the filesystem what `--db` does for the database. It exists so this section is
 * testable against a temp tree, and so a missing directory is never confused with an
 * unreadable one (§11 Permissions needs three states, not one).
 */
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { deriveSessionId, type AgentAdapter, type Detection, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { parserVersionDrift, sourceRetention, subagentOrphans, timestampGuesses } from '@agentlens/storage'
import {
  coverageReport,
  createContext,
  INGESTED_RETENTION,
  modelSpend,
  projectRowsPhrase,
  retentionPhrase,
  unpricedBuckets,
  UPSTREAM_RETENTION,
} from '@agentlens/server'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { displayPath, machineIdentity, machineLines, makeHostCtx, redactHome } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { loadPricing } from '../pricing-store.ts'
import { GLYPH, formatCount, formatTokens, table } from '../render.ts'
import { rowsOf } from './shared.ts'
import {
  accessOf,
  describeAccess,
  formatBytes,
  probeSqlite,
  readHistoryIndex,
  sessionStoreRoot,
  sqliteRefusal,
  surveySessionStore,
  type StoreSurvey,
} from '../coverage.ts'
import { measureUsageQuality, renderUsageQuality } from './doctor-usage.ts'
import { measureCapabilities, renderCapabilities } from './doctor-caps.ts'

/** Upstream's session-existence index (§4.4 row 4); the claude adapter discovers it as a source. */
const HISTORY_INDEX_FILE = 'history.jsonl'
const DEFAULT_EXT = '.jsonl'

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

function countOf(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  return Number(rowsOf(db, sql, ...params)[0]?.n ?? 0)
}

function pct(n: number, d: number): string {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`
}

/**
 * The §11 root override: an absolute `AGENTLENS_AGENT_ROOT` replaces the home directory for
 * every probe below, so this machine's `~/.claude` can never leak into a test run.
 */
export function doctorCtx(ctx: Ctx): Ctx {
  const root = ctx.env.AGENTLENS_AGENT_ROOT
  if (!root || !isAbsolute(root)) return ctx
  return { ...ctx, homedir: root }
}

export interface AdapterProbe {
  adapter: AgentAdapter
  detection: Detection | null
  /** Non-null when detection/discovery itself failed — reported, never retried destructively. */
  error: string | null
  host: HostContext | null
  sources: SourceSpec[]
  files: { path: string; bytes: number }[]
  /** Discovered but not stat-able: deleted between discovery and this pass. */
  vanished: string[]
  sqlite: { path: string; refusal: string | null; sidecars: number }[]
  storeDir: string | null
  ext: string
  historyFile: string | null
  survey: StoreSurvey | null
  bytes: number
  events: number
}

/** Everything the report needs from the filesystem, collected once, read-only. */
export async function probeAdapters(adapters: readonly AgentAdapter[], rctx: Ctx, db: DatabaseSync): Promise<AdapterProbe[]> {
  const probes: AdapterProbe[] = []
  for (const adapter of adapters) {
    const probe: AdapterProbe = {
      adapter,
      detection: null,
      error: null,
      host: null,
      sources: [],
      files: [],
      vanished: [],
      sqlite: [],
      storeDir: null,
      ext: DEFAULT_EXT,
      historyFile: null,
      survey: null,
      bytes: 0,
      events: countOf(db, 'SELECT COUNT(*) AS n FROM events WHERE agent_id = ?', adapter.id),
    }
    probes.push(probe)
    let detection: Detection
    try {
      detection = await adapter.detect(makeHostCtx(rctx))
    } catch (err) {
      probe.error = redactHome(message(err), rctx.homedir)
      continue
    }
    probe.detection = detection
    if (!detection.present) continue
    const host = makeHostCtx(rctx, detection.dataRoot ?? null)
    probe.host = host
    try {
      for await (const s of adapter.discover(host)) probe.sources.push(s)
    } catch (err) {
      probe.error = redactHome(`discover failed: ${message(err)}`, rctx.homedir)
      continue
    }
    for (const s of probe.sources) {
      if (s.kind === 'sqlite') {
        const sniffed = probeSqlite(s.path)
        probe.sqlite.push({ path: s.path, refusal: sqliteRefusal(sniffed), sidecars: sniffed.sidecars.length })
        continue
      }
      // The history index is a session-existence list, not a session file: counting it
      // would make the Agents row claim history the Coverage section then reports as missing.
      if (basename(s.path) === HISTORY_INDEX_FILE) {
        probe.historyFile = s.path
        continue
      }
      const st = await stat(s.path).catch(() => null)
      if (!st?.isFile()) {
        probe.vanished.push(s.path)
        continue
      }
      probe.files.push({ path: s.path, bytes: st.size })
      probe.bytes += st.size
    }
    probe.ext = mostUsedExt(probe.files.map((f) => f.path))
    // The store ROOT, not the deepest shared prefix of the surviving files: with one project
    // left on disk the prefix would be that project dir, and the Agents glob plus §4.4 row 4's
    // emptied-dir check would then describe a scope nobody scanned.
    probe.storeDir =
      sessionStoreRoot(probe.files.map((f) => f.path), detection.dataRoot ?? null) ?? storeDirFromDb(db, adapter.id)
    if (probe.storeDir) probe.survey = await surveySessionStore(probe.storeDir, probe.ext)
  }
  return probes
}

/** A store emptied by upstream retention leaves no live file to derive its root from (§4.4 row 4). */
function storeDirFromDb(db: DatabaseSync, agentId: string): string | null {
  const row = rowsOf(
    db,
    `SELECT path FROM sources WHERE agent_id = ? AND kind = 'jsonl' AND path IS NOT NULL AND path NOT LIKE ?
     ORDER BY path LIMIT 1`,
    agentId,
    `%${HISTORY_INDEX_FILE}`,
  )[0]
  return row ? dirname(String(row.path)) : null
}

function mostUsedExt(paths: readonly string[]): string {
  const counts = new Map<string, number>()
  let best = DEFAULT_EXT
  let bestN = 0
  for (const p of paths) {
    const ext = extname(p) || DEFAULT_EXT
    const n = (counts.get(ext) ?? 0) + 1
    counts.set(ext, n)
    if (n > bestN) {
      best = ext
      bestN = n
    }
  }
  return best
}

function sourceGlob(p: AdapterProbe, home: string): string {
  if (p.storeDir) return `${displayPath(p.storeDir, home)}/**/*${p.ext}`
  const sqliteSource = p.sqlite[0]?.path ?? p.sources.find((s) => s.kind === 'sqlite')?.path
  if (sqliteSource) return `${displayPath(sqliteSource, home)} (sqlite, header-only)`
  return p.detection?.dataRoot ? displayPath(p.detection.dataRoot, home) : 'no store located'
}

interface HostRow {
  host: string
  sessions: number
  sources: number
  events: number
}

function hostsOf(db: DatabaseSync, agentId: string): HostRow[] {
  return rowsOf(
    db,
    `SELECT COALESCE(NULLIF(host_id, ''), '(none)') AS host,
            COUNT(DISTINCT session_id) AS sessions,
            COUNT(DISTINCT source_id) AS sources,
            COUNT(*) AS events
     FROM events WHERE agent_id = ? GROUP BY host ORDER BY events DESC`,
    agentId,
  ).map((r) => ({
    host: String(r.host),
    sessions: Number(r.sessions),
    sources: Number(r.sources),
    events: Number(r.events),
  }))
}

export function renderAgents(db: DatabaseSync, rctx: Ctx, probes: readonly AdapterProbe[]): void {
  rctx.out('Agents')
  for (const p of probes) {
    const id = p.adapter.id
    if (!p.detection) {
      rctx.out(`${GLYPH.warn} ${id.padEnd(16)} ${p.error ?? 'detection unavailable'}`)
      continue
    }
    if (!p.detection.present) {
      const why = p.detection.reason ? ` — ${redactHome(String(p.detection.reason), rctx.homedir)}` : ''
      rctx.out(`${GLYPH.none} ${id.padEnd(16)} not detected${why}`)
      continue
    }
    const hosts = hostsOf(db, id)
    const refused = p.sqlite.filter((s) => s.refusal)
    const dbErrors = countOf(db, `SELECT COUNT(*) AS n FROM sources WHERE agent_id = ? AND status = 'error'`, id)
    const hostless = hosts.find((h) => h.host === '(none)')
    const troubled =
      refused.length > 0 || p.vanished.length > 0 || p.error !== null || dbErrors > 0 || p.files.length === 0 ||
      /unreadable|no session files|retention/i.test(p.detection.reason ?? '')
    const glyph = troubled ? GLYPH.warn : GLYPH.ok
    rctx.out(
      `${glyph} ${id.padEnd(16)} v${p.detection.agentVersion ?? '?'}  ` +
        `${sourceGlob(p, rctx.homedir).padEnd(34)} ${formatCount(p.files.length)} files / ${formatBytes(p.bytes)}` +
        ` · ${formatCount(p.events)} events`,
    )
    // §4.4 row 3: several hosts share one store, so only the split-by-entrypoint number is true.
    for (const h of hosts.filter((r) => r.host !== id && r.host !== '(none)')) {
      rctx.out(
        `  ${GLYPH.ok} ${h.host.padEnd(16)} same store, entrypoint=${h.host}  ${formatCount(h.sessions)} sessions / ` +
          `${formatCount(h.sources)} sources / ${formatCount(h.events)} events (${pct(h.events, p.events)} of this store)`,
      )
    }
    if (hostless) rctx.out(`  ${GLYPH.warn} ${formatCount(hostless.events)} events carry no host_id — the host split above undercounts them`)
    if (p.sqlite.length > 0) {
      rctx.out(
        `  ${refused.length > 0 ? GLYPH.warn : GLYPH.ok} ${formatCount(p.sqlite.length)} SQLite source(s) sniffed by header, ` +
          'none opened' +
          (refused.length > 0 ? ` — ${formatCount(refused.length)} refused: ${refused[0]!.refusal}` : ''),
      )
    }
    if (dbErrors > 0) {
      const why = rowsOf(
        db,
        `SELECT last_error AS e FROM sources WHERE agent_id = ? AND status = 'error' AND last_error IS NOT NULL LIMIT 1`,
        id,
      )[0]
      rctx.out(`  ${GLYPH.warn} ${formatCount(dbErrors)} source(s) recorded status=error${why ? `: ${redactHome(String(why.e), rctx.homedir)}` : ''}`)
    }
    if (p.vanished.length > 0) {
      rctx.out(`  ${GLYPH.warn} ${formatCount(p.vanished.length)} discovered file(s) could not be stat-ed (deleted or locked between passes)`)
    }
    if (p.files.length === 0) rctx.out(`  ${GLYPH.warn} ${redactHome(String(p.detection.reason ?? 'no session files found'), rctx.homedir)}`)
    if (p.error) rctx.out(`  ${GLYPH.warn} ${p.error}`)
  }

  const installed = probes.map((p) => p.adapter.id)
  const placeholders = installed.length ? installed.map(() => '?').join(',') : "''"
  for (const r of rowsOf(db, `SELECT id FROM agents WHERE id NOT IN (${placeholders})`, ...installed)) {
    const orphan = String(r.id)
    const n = countOf(db, 'SELECT COUNT(*) AS n FROM events WHERE agent_id = ?', orphan)
    rctx.out(`${GLYPH.warn} ${orphan.padEnd(16)} ingested (${formatCount(n)} events), but its adapter package is not installed in this build`)
  }
  if (probes.length === 0) rctx.out(`${GLYPH.none} no adapters installed — discovery unavailable (ingested data stays queryable)`)
}

export function renderParsing(db: DatabaseSync, rctx: Ctx, probes: readonly AdapterProbe[]): void {
  rctx.out('Parsing')
  const eventTotal = countOf(db, 'SELECT COUNT(*) AS n FROM events')
  const parseErrors = countOf(db, 'SELECT COUNT(*) AS n FROM parse_errors')
  const unknownRows = countOf(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'unknown'")
  rctx.out(
    `events ${formatCount(eventTotal)} · parse_errors ${formatCount(parseErrors)} (${pct(parseErrors, eventTotal + parseErrors)})` +
      ` · unknown types ${formatCount(unknownRows)} rows`,
  )

  // §5.3: the unknown rows must be named, because a bare total cannot show WHICH type drifted.
  const tops = rowsOf(
    db,
    `SELECT COALESCE(NULLIF(subtype, ''), '(no subtype)') AS t, COUNT(*) AS n
     FROM events WHERE type = 'unknown' GROUP BY t ORDER BY n DESC LIMIT 5`,
  )
  if (tops.length > 0) {
    rctx.out(`top unknown record types: ${tops.map((r) => `${r.t} ${formatCount(Number(r.n))}`).join(' · ')}`)
  }
  const errTops = rowsOf(
    db,
    `SELECT COALESCE(NULLIF(reason, ''), '(no reason)') AS r, COUNT(*) AS n FROM parse_errors GROUP BY r ORDER BY n DESC LIMIT 3`,
  )
  if (errTops.length > 0) {
    rctx.out(`top parse_errors: ${errTops.map((r) => `${redactHome(String(r.r), rctx.homedir)} ${formatCount(Number(r.n))}`).join(' · ')}`)
  }

  // §5.3 drift: a source whose stored parser_version is not the adapter's current one gets
  // re-read in full by the next scan — safe only because writes are idempotent (§4.2).
  // The counting is shared with `GET /api/doctor` (storage's `parserVersionDrift`); a NULL
  // parser_version is an FK placeholder for a source that was never scanned, so drift stays
  // undefined for it and is not counted as stale.
  const drift = parserVersionDrift(
    db,
    Object.fromEntries(probes.map((p) => [p.adapter.id, p.adapter.parserVersion])),
  )
  const { checked, drifted, unmapped, unscanned } = drift
  const noteUnmapped = (): void => {
    if (unmapped > 0) {
      rctx.out(`${GLYPH.none} ${formatCount(unmapped)} further source(s) belong to agents with no adapter in this build — drift unknowable for them`)
    }
  }
  if (checked === 0) {
    // "current on all 0 sources" would be a false green: say plainly that nothing was checkable.
    rctx.out(
      `${GLYPH.none} parser_version drift cannot be evaluated — ` +
        `${formatCount(unmapped)} source(s) belong to agents with no adapter here, ${formatCount(unscanned)} carry no version yet`,
    )
  } else if (drifted > 0) {
    rctx.out(
      `${GLYPH.warn} ${formatCount(drifted)} of ${formatCount(checked)} sources carry a stale parser_version → ` +
        'the next scan re-reads them in full (§5.3)',
    )
    noteUnmapped()
  } else {
    // `checked > 0` implies at least one probe: only a matched adapter version can count it.
    rctx.out(
      `${GLYPH.ok} parser_version current on all ${formatCount(checked)} sources ` +
        `(${probes.map((p) => `${p.adapter.id} v${p.adapter.parserVersion}`).join(', ')})` +
        (unscanned ? ` · ${formatCount(unscanned)} not yet scanned` : ''),
    )
    noteUnmapped()
  }
}

export async function renderCoverage(db: DatabaseSync, rctx: Ctx, probes: readonly AdapterProbe[]): Promise<void> {
  rctx.out('Coverage')
  for (const p of probes) {
    if (!p.detection?.present) continue
    if (!p.storeDir || !p.survey) {
      rctx.out(`${GLYPH.none} ${p.adapter.id}: no session store located — "we scanned everything" is not a claim this report can make`)
      continue
    }
    const shown = displayPath(p.storeDir, rctx.homedir)
    if (p.survey.access !== 'readable') {
      rctx.out(`${GLYPH.err} ${p.adapter.id}: ${shown} ${describeAccess(p.survey.access)} — coverage of it is unknown`)
      continue
    }
    if (p.survey.emptyDirs.length === 0) {
      rctx.out(
        `${GLYPH.ok} ${p.adapter.id}: all ${formatCount(p.survey.dirs)} session dirs under ${shown} hold session files ` +
          `(${formatCount(p.survey.files)} files / ${formatBytes(p.survey.bytes)})`,
      )
      continue
    }
    // The clause is `retentionPhrase`'s, shared with the dashboard banner, and it names its own
    // population: this sweep counts every dir in the live store, ingested or not, while the
    // banner's count is bounded by the `sources` table. Two questions, two honest labels (§14).
    rctx.out(`${GLYPH.warn} ${p.adapter.id}: ${retentionPhrase(UPSTREAM_RETENTION, p.survey.emptyDirs.length, p.survey.dirs, shown)}`)
    rctx.out('  → history is incomplete: whatever those dirs held was never ingested and cannot be recovered from disk')
    if (p.survey.unreadableDirs.length > 0) {
      rctx.out(`${GLYPH.err} ${formatCount(p.survey.unreadableDirs.length)} of those dirs exist but are not readable (locked?)`)
    }
  }
  if (probes.every((p) => !p.detection?.present)) {
    rctx.out(`${GLYPH.none} no agent store detected — nothing was read, so completeness cannot be claimed`)
  }
  // The other half of §11's Coverage block, from the same `coverageReport` the dashboard reads:
  // what THIS STORE can see. Printed beside the store-wide sweep so the two numbers on one
  // screen are visibly two populations rather than one disagreement (§14).
  const ingested = coverageReport(createContext({ db, now: rctx.now, homedir: rctx.homedir }))
  if (ingested.emptyDirs.length > 0) {
    rctx.out(`${GLYPH.warn} ${retentionPhrase(INGESTED_RETENTION, ingested.emptyDirs.length)}`)
  }
  if (ingested.projectDirsWithoutSessions.length > 0) {
    rctx.out(`${GLYPH.warn} ${projectRowsPhrase(ingested.projectDirsWithoutSessions.length)}`)
  }
  return renderHistoryCoverage(db, rctx, probes)
}

/** §4.4 row 4's second half: sessions proven to have existed whose own file is gone. */
async function renderHistoryCoverage(db: DatabaseSync, rctx: Ctx, probes: readonly AdapterProbe[]): Promise<void> {
  for (const p of probes) {
    if (!p.detection?.present) continue
    if (!p.historyFile) {
      rctx.out(`${GLYPH.none} ${p.adapter.id}: no ${HISTORY_INDEX_FILE} in the store — session-existence recovery unavailable`)
      continue
    }
    const shown = displayPath(p.historyFile, rctx.homedir)
    const index = await readHistoryIndex(p.historyFile)
    if (index.access !== 'readable') {
      rctx.out(`${GLYPH.err} ${shown} ${describeAccess(index.access)} — cannot cross-check session existence`)
      continue
    }
    if (index.entries.length === 0) {
      rctx.out(`${GLYPH.none} ${shown} holds no session ids${index.malformed > 0 ? ` (${formatCount(index.malformed)} unreadable lines)` : ''}`)
      continue
    }
    const natives = [...new Set(index.entries.map((e) => e.sessionId))]
    // Evidence that a session's OWN file was readable — anything but the index itself.
    const fromFiles = new Set([
      ...rowsOf(
        db,
        `SELECT DISTINCT e.session_id AS k FROM events e
         LEFT JOIN sources s ON s.id = e.source_id
         WHERE e.agent_id = ? AND (s.path IS NULL OR s.path <> ?)`,
        p.adapter.id,
        p.historyFile,
      ).map((r) => String(r.k)),
      ...rowsOf(
        db,
        `SELECT session_id_hint AS k FROM sources WHERE agent_id = ? AND session_id_hint IS NOT NULL AND path <> ?`,
        p.adapter.id,
        p.historyFile,
      ).map((r) => String(r.k)),
    ])
    const inDb = new Set(rowsOf(db, 'SELECT id FROM sessions WHERE agent_id = ?', p.adapter.id).map((r) => String(r.id)))
    const known = (native: string): boolean => fromFiles.has(deriveSessionId(p.adapter.id, native)) || fromFiles.has(native)
    const seen = (native: string): boolean => inDb.has(deriveSessionId(p.adapter.id, native)) || inDb.has(native)
    const onlyFromHistory = natives.filter((n) => !known(n))
    const neverIngested = onlyFromHistory.filter((n) => !seen(n))
    rctx.out(
      `${onlyFromHistory.length === 0 ? GLYPH.ok : GLYPH.warn} ${formatCount(natives.length)} sessions named in ${shown} · ` +
        `${formatCount(onlyFromHistory.length)} known only from history.jsonl (their own session file is gone, §4.4 row 4)` +
        (onlyFromHistory.length > 0 ? `, ${formatCount(neverIngested.length)} of them never ingested at all` : '') +
        (index.malformed > 0 ? ` · ${formatCount(index.malformed)} unreadable index lines (§5.3 drift)` : ''),
    )
  }
}

/** §4.4 row 8: the subagent parent link is a time heuristic with no foreign key behind it. */
export function renderSubagentLinkage(db: DatabaseSync, rctx: Ctx): void {
  const rows = subagentOrphans(db)
  if (rows.length === 0) {
    rctx.out(`${GLYPH.none} no subagent events ingested — nothing to link, so the heuristic's accuracy is untested here`)
    return
  }
  for (const r of rows) {
    rctx.out(
      `${r.orphan === 0 ? GLYPH.ok : GLYPH.warn} ${r.agentId}: ${formatCount(r.orphan)} of ${formatCount(r.total)} subagent events ` +
        `(${pct(r.orphan, r.total)}) have parent_event_id NULL — §4.4 row 8 links to "the nearest preceding Agent call" with no foreign key to fall back on`,
    )
    if (r.orphan > 0) rctx.out('  → their tokens and cost ARE counted; only the timeline tree placement is unknown')
  }
}

/**
 * §5.2 / §19: events stored under a timestamp their source never stated. A warning, never an
 * error — the rows are real activity, only their date is a stand-in — but the count has to sit
 * next to the time-windowed numbers that quietly include them.
 */
export function renderGuessedTimestamps(db: DatabaseSync, rctx: Ctx): void {
  // Shared with `GET /api/doctor`: one query, one number on both exits (§14).
  const rows = timestampGuesses(db)
  if (rows.length === 0) {
    rctx.out(`${GLYPH.ok} every ingested event carries a timestamp its source stated (§5.2)`)
    return
  }
  for (const r of rows) {
    const fromMtime = r.guessed - r.fromIngestClock
    rctx.out(
      `${GLYPH.warn} ${r.agentId}: ${formatCount(r.guessed)} of ${formatCount(r.events)} events ` +
        `(${pct(r.guessed, r.events)}) carry a timestamp the source never stated — ` +
        `${formatCount(r.fromIngestClock)} dated by the scan clock, ${formatCount(fromMtime)} by the source file's mtime`,
    )
  }
  rctx.out('  → time-windowed numbers (`--since`, the Overview window) include these rows whatever their real date is')
}

export function renderRetention(db: DatabaseSync, rctx: Ctx): void {
  // Shared with `GET /api/doctor`: the same two status counts, one implementation (§14).
  const { gone: goneCount, rotated, active } = sourceRetention(db)
  const gone = goneCount + rotated
  if (gone > 0) {
    rctx.out(`${GLYPH.warn} ${formatCount(gone)} known source(s) no longer readable (gone/rotated) — the events already ingested from them stay, nothing new can arrive`)
  }
  rctx.out(
    `${gone > 0 ? GLYPH.warn : GLYPH.ok} ${formatCount(active)} source(s) read to their end · ` +
      'coverage stops where upstream retention stops (§4.4 row 4)',
  )
}

/**
 * §8's unpriced set and §11's read of it come from `modelSpend` + `unpricedBuckets`, the same
 * two calls `/api/doctor` and `/api/models` make: one model could otherwise read "missing
 * price" on one surface and priced on the other (§14). Only the roll-ups below — priced event
 * share, undated entries — are phrased for the terminal here.
 */
export function renderPricing(db: DatabaseSync, rctx: Ctx, dbPath: string): void {
  rctx.out('Pricing')
  const { table: priceTable, snapshot, overrideCount } = loadPricing(dbPath)
  const now = rctx.now()
  rctx.out(
    `${GLYPH.ok} ${formatCount(priceTable.size())} models priced (source: ${snapshot.source === 'bundled' ? 'bundled snapshot' : 'updated snapshot'}` +
      `${overrideCount ? `, ${overrideCount} overrides` : ''})`,
  )
  const models = modelSpend(db, now)
  if (models.length === 0) {
    rctx.out(`${GLYPH.none} no models ingested yet — nothing to price`)
    return
  }
  const gaps: { provider: string; model: string; events: number; buckets: string[] }[] = []
  let pricedEvents = 0
  let undatedModels = 0
  for (const m of models) {
    const entry = priceTable.lookup(m.provider, m.model, m.lastSeen)
    if (entry?.effectiveFrom === 0) undatedModels++
    const buckets = unpricedBuckets(entry, m)
    if (buckets.length === 0) {
      pricedEvents += m.events
      continue
    }
    gaps.push({ provider: m.provider, model: m.model, events: m.events, buckets })
  }
  gaps.sort((a, b) => b.events - a.events || a.model.localeCompare(b.model))
  if (gaps.length > 0) {
    rctx.out(
      `${GLYPH.warn} ${formatCount(gaps.length)} of ${formatCount(models.length)} ingested models unpriced → ` +
        'cost = "n/a", never $0 ($0 reads as a free local model, §8) — `agl pricing update` or `agl pricing override`',
    )
    rctx.out(
      table(
        ['provider', 'model', 'events', 'missing price for', 'cost'],
        gaps.map((g) => [g.provider, g.model, formatCount(g.events), g.buckets.join(','), 'n/a']),
        ['left', 'left', 'right', 'left', 'right'],
      ),
    )
  } else {
    rctx.out(`${GLYPH.ok} every ingested model has a price for each token bucket its events spent, at its last-seen date`)
  }
  rctx.out(`${GLYPH.none} ${formatCount(pricedEvents)} of ${formatCount(models.reduce((a, m) => a + m.events, 0))} model-tagged events are priced into the cost figures`)
  const reported = countOf(db, 'SELECT COUNT(*) AS n FROM events WHERE cost_reported IS NOT NULL')
  rctx.out(
    reported > 0
      ? `${GLYPH.ok} ${formatCount(reported)} event(s) carry a cost the agent reported itself, which the cube prefers over computed (§18 row 1)`
      : `${GLYPH.none} no agent reported a cost for any event — every $ figure this tool prints is computed from the local price table (§8)`,
  )
  if (undatedModels > 0) {
    rctx.out(
      `${GLYPH.warn} ${formatCount(undatedModels)} priced model(s) have an undated entry (effective_from 0): the current rate ` +
        'is applied to their whole history, so the $ totals are what today\'s price would have cost, not what was paid (§8) — ' +
        '`agl pricing update` fetches dated entries',
    )
  }
}

export function renderPermissions(rctx: Ctx, probes: readonly AdapterProbe[]): void {
  rctx.out('Permissions')
  let lines = 0
  let sniffed = 0
  const shown = new Set<string>()
  for (const p of probes) {
    const roots = [p.detection?.dataRoot ?? null, p.storeDir, p.historyFile, ...p.sqlite.map((s) => s.path)].filter((r): r is string => Boolean(r))
    // A session dir the store survey could not list is a permission fact of exactly the same
    // kind as the roots above, and it is only knowable from the survey (§11's third state).
    const targets = [...roots, ...(p.survey?.unreadableDirs ?? []).filter((d) => accessOf(d) === 'unreadable')]
    for (const root of new Set(targets)) {
      if (shown.has(root)) continue
      shown.add(root)
      const access = accessOf(root)
      const glyph = access === 'readable' ? GLYPH.ok : access === 'unreadable' ? GLYPH.err : GLYPH.none
      rctx.out(`${glyph} ${displayPath(root, rctx.homedir).padEnd(32)} ${describeAccess(access)}`)
      lines++
    }
    for (const s of p.sqlite) {
      sniffed++
      if (!s.refusal) continue
      rctx.out(`${GLYPH.warn} ${displayPath(s.path, rctx.homedir)} not read: ${s.refusal}`)
      if (s.sidecars > 0) rctx.out(`  → ${s.sidecars} -wal/-shm sidecar(s) already present: a live writer owns this store`)
    }
  }
  if (lines === 0) {
    rctx.out(`${GLYPH.none} no agent data roots to check (${probes.length === 0 ? 'no adapters installed in this build' : 'none detected'})`)
  }
  if (sniffed > 0) {
    rctx.out(`${GLYPH.ok} ${formatCount(sniffed)} foreign SQLite store(s) inspected as a 100-byte header only — nothing opened, no sidecar written (§18 row 7)`)
  }
}

export async function cmdDoctor(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): Promise<number> {
  const rctx = doctorCtx(ctx)
  const only = flags.list('agent')
  const all = await getAdapters()
  const adapters = only.length > 0 ? all.filter((a) => only.includes(a.id)) : all
  const probes = await probeAdapters(adapters, rctx, db)

  renderAgents(db, rctx, probes)

  // §2: the store's own identity line — same wording as `status` (§14: one fact, one phrase).
  ctx.out('')
  for (const line of machineLines(machineIdentity(db))) ctx.out(line)

  ctx.out('')
  renderParsing(db, rctx, probes)

  ctx.out('')
  ctx.out('Usage quality')
  renderUsageQuality(rctx, measureUsageQuality(db, adapters), adapters)

  ctx.out('')
  await renderCoverage(db, rctx, probes)
  renderSubagentLinkage(db, rctx)
  renderGuessedTimestamps(db, rctx)
  renderRetention(db, rctx)

  ctx.out('')
  const hosts = new Map<string, HostContext>(
    probes.flatMap((p): [string, HostContext][] => (p.host ? [[p.adapter.id, p.host]] : [])),
  )
  renderCapabilities(rctx, await measureCapabilities(adapters, hosts, db))

  ctx.out('')
  renderPricing(db, rctx, dbPath)

  ctx.out('')
  renderPermissions(rctx, probes)
  return 0
}
