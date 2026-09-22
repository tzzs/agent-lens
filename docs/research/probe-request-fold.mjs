#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --disable-warning=SQLite --experimental-transform-types
/**
 * §19 "立方体在 343k 事件下的量级" — measures the persisted stage-1 fold (`requests`,
 * migration 008) against the fold it replaces, on a REAL store.
 *
 * Run it on an APFS clone, never on the live database:
 *   cp -c ~/.agentlens/agentlens.db /tmp/agl-perf/agentlens.db
 *   cp -c ~/.agentlens/agentlens.db-wal /tmp/agl-perf/agentlens.db-wal
 *   docs/research/probe-request-fold.mjs --db /tmp/agl-perf/agentlens.db [events]
 *
 * The clone is opened read-write and IS migrated (creating + backfilling `requests`), which
 * is the upgrade path every existing store takes; nothing outside the clone is written, and
 * no log content or session id is printed — timings, row counts and byte lengths only.
 *
 * TWO ARMS, interleaved so thermal noise hits both:
 *   `fold`  — today's cube: stage 1 folded per statement, or materialised once per scope
 *             (`persistedFold: false`, which is exactly the pre-008 code path).
 *   `table` — stage 2 read off `requests`, zero fold passes.
 * Each route runs in both arms and its full JSON is kept: the promise is that the two are the
 * SAME BYTES, not merely close. `generatedAt`/`sinceTs` are masked because `overview` resolves
 * its default window against the wall clock outside the request's pinned `now`, so two runs of
 * one route differ by milliseconds regardless of this change (logged as a finding, not fixed).
 *
 * The write arm re-ingests a sample of the store's own event rows through `insertEvents` twice
 * — once with the derived table present, once with it dropped — which is the only honest way to
 * price the maintenance the read win costs.
 */
const REPO = new URL('../../', import.meta.url).pathname
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const dbPath = arg('db', null)
if (!dbPath) {
  console.error('usage: probe-request-fold.mjs --db <clone of agentlens.db> [eventSample]')
  process.exit(2)
}
const runs = Number(argv.find((a) => /^\d+$/.test(a)) ?? 3)
const sample = Number(argv.filter((a) => /^\d+$/.test(a))[1] ?? 60000)

const { openDatabase, migrate, loadAgentAggregations, insertEvents, rowToEvent, setAgentAggregations,
  requestFoldRowCount, requestFoldIsConsistent, requestFoldState } = await import(`${REPO}packages/storage/src/index.ts`)
const q = await import(`${REPO}packages/query/src/index.ts`)
const { projects } = await import(`${REPO}packages/server/src/projects.ts`)
const { overview } = await import(`${REPO}packages/server/src/overview.ts`)
const { loadPricing, loadBillingModes } = await import(`${REPO}apps/cli/src/pricing-store.ts`)

const clock = (s) => s.replace(/"(generatedAt|sinceTs|now|emittedAt|builtAt)":\d+/g, '"$1":CLOCK')
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
/**
 * MIN, not mean: this host runs several agents at once, and an interfered sample measures the
 * scheduler. The best-of-N is the number the code itself is responsible for. The spread is
 * printed next to it so nobody reads a noisy machine's ratio as a result.
 */
const best = (xs) => Math.min(...xs)
const worst = (xs) => Math.max(...xs)

const db = openDatabase(dbPath)
const applied = migrate(db)
console.log(`db                     ${dbPath}`)
console.log(`migrated               ${applied.length ? JSON.stringify(applied) : 'already current'}`)
const counts = db.prepare('SELECT (SELECT COUNT(*) FROM events) events, (SELECT COUNT(*) FROM sessions) sessions, (SELECT COUNT(*) FROM sources) sources').get()
const foldRows = requestFoldRowCount(db)
console.log(`events/sessions/sources ${counts.events}/${counts.sessions}/${counts.sources}`)
console.log(`requests rows          ${foldRows}  (${((100 * foldRows) / Math.max(1, counts.events)).toFixed(1)}% of events)  consistent=${requestFoldIsConsistent(db)}  state=${JSON.stringify(requestFoldState(db))}`)

const { table } = loadPricing(dbPath)
const modes = loadBillingModes(dbPath)
const aggregation = loadAgentAggregations(db)
const stamp = Date.now()
const deps = (persisted) => ({
  priceResolver: (p, m, at) => table.lookup(p, m, at),
  billingModeFor: (a) => modes[a] ?? 'api',
  aggregation,
  now: () => stamp,
  persistedFold: persisted,
})
const ctx = (persisted, foldCache) => ({
  db,
  now: () => stamp,
  homedir: process.env.HOME ?? '/',
  priceResolver: deps(persisted).priceResolver,
  billingModeFor: deps(persisted).billingModeFor,
  aggregation,
  cubeDeps: { ...deps(persisted), ...(foldCache ? { foldCache } : {}) },
  changeSource: () => ({ snapshot: () => ({ maxTimestamp: null, events: 0, emittedAt: 0 }), watch: () => () => {} }),
})

const USAGE = ['events', 'sessions', 'tokens_total', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'cost_total', 'cost_api_equiv', 'cost_reported']
const CASES = [
  ['GET /api/projects (full)', (c) => projects(c, new URLSearchParams('limit=30'))],
  ['GET /api/projects?since=30d', (c) => projects(c, new URLSearchParams('since=30d&limit=30'))],
  ['GET /api/overview?since=30d', (c) => overview(c, new URLSearchParams('since=30d'))],
  ['cube usage --by day (full)', (c) => q.query(db, { metrics: USAGE, dims: ['day'], filter: {} }, c.cubeDeps)],
  ['cube projects (full)', (c) => q.query(db, { metrics: USAGE, dims: ['project'], filter: {} }, c.cubeDeps)],
  ['cube usage --since 30d', (c) => q.query(db, { metrics: USAGE, dims: ['day'], filter: { since: '30d' } }, c.cubeDeps)],
  ['cube usage --by model (full)', (c) => q.query(db, { metrics: USAGE, dims: ['model'], filter: {} }, c.cubeDeps)],
]

const push = (map, key, value) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
const timings = new Map()
const payloads = new Map()
for (let i = 0; i < runs; i++) {
  for (const persisted of [true, false]) {
    for (const [name, fn] of CASES) {
      const foldCache = q.createFoldCache(db)
      const c = ctx(persisted, foldCache)
      q.resetFoldPasses()
      const t0 = process.hrtime.bigint()
      const out = clock(JSON.stringify(fn(c)))
      const took = ms(t0)
      foldCache.dispose()
      const key = `${name}|${persisted ? 'table' : 'fold'}`
      push(timings, key, took)
      push(payloads, key, out)
      if (i === 0) process.stdout.write(`  ${key.padEnd(36)} folds=${JSON.stringify(q.foldPasses())}\n`)
    }
  }
}
console.log('\nread paths (median of %d interleaved runs)'.replace('%d', String(runs)))
for (const [name] of CASES) {
  const a = timings.get(`${name}|table`) ?? []
  const b = timings.get(`${name}|fold`) ?? []
  const same = payloads.get(`${name}|table`).every((x) => x === payloads.get(`${name}|fold`)[0]) &&
    payloads.get(`${name}|fold`).every((x) => x === payloads.get(`${name}|table`)[0])
  console.log(
    `${name.padEnd(30)} fold ${best(b).toFixed(0).padStart(6)} ms (worst ${worst(b).toFixed(0)}) -> table ${best(a).toFixed(0).padStart(6)} ms (worst ${worst(a).toFixed(0)})` +
      `  x${(best(b) / best(a)).toFixed(2)}  identical-bytes=${same} (${payloads.get(`${name}|table`)[0].length} B)`,
  )
}

console.log('\nwrite path (re-ingest of %d stored event rows through insertEvents)'.replace('%d', String(sample)))
const rows = db
  .prepare(`SELECT e.*, m.provider AS model_provider, m.name AS model_name, m.tier AS model_tier FROM events e LEFT JOIN models m ON m.rowid = e.model_rowid LIMIT ${sample}`)
  .all()
const events = rows.map((r) => rowToEvent(r))
for (const withFold of [false, true, false, true]) {
  const target = openDatabase(':memory:')
  migrate(target)
  if (!withFold) target.exec('DROP TABLE requests; DROP TABLE requests_state')
  setAgentAggregations(target, aggregation)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < events.length; i += 500) insertEvents(target, events.slice(i, i + 500))
  const took = ms(t0)
  if (withFold && !requestFoldIsConsistent(target)) throw new Error('table drifted from events during a cold ingest')
  console.log(`  ${withFold ? 'with requests maintained' : 'fold table absent      '} ${took.toFixed(0).padStart(6)} ms${withFold ? `  rows=${requestFoldRowCount(target)}` : ''}`)
  target.close()
}
db.close()
