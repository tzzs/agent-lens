#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --disable-warning=SQLite --experimental-transform-types
/**
 * Where does a full-history `/api/projects` actually spend its seconds?
 *
 * The route is five cube calls plus two raw reads; before "multiplexing stage 2" is a fix, it
 * has to be the expensive part. Each arm runs against the same clone, five times interleaved,
 * and the whole route is timed as its own arm so the parts have to add up to it.
 */
const REPO = '/Users/tanzz/workspaces/agent-lens/'
const { openDatabase } = await import(`${REPO}packages/storage/src/index.ts`)
const { loadAgentAggregations } = await import(`${REPO}packages/storage/src/write.ts`)
const { createFoldCache, query } = await import(`${REPO}packages/query/src/index.ts`)
const { projects } = await import(`${REPO}packages/server/src/projects.ts`)
const { priceTableFor } = await import(`${REPO}packages/server/src/serve.ts`)

const dbPath = process.argv[2] ?? '/tmp/agl-fold-final/agentlens.db'
const db = openDatabase(dbPath)
const aggregation = loadAgentAggregations(db)
const pricing = priceTableFor(dbPath)
const RUNS = Number(process.argv[3] ?? 5)

const ARMS = {
  'top (project)': () => query(db, { metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv', 'cost_total', 'duration'], dims: ['project'], limit: 30 }, deps()),
  'sub (project,agent)': () => query(db, { metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv'], dims: ['project', 'agent'], totals: false }, deps()),
  'modelMix (project,model)': () => query(db, { metrics: ['events', 'tokens_total'], dims: ['project', 'model'], limit: 600, totals: false }, deps()),
  'capMix (project,capability)': () => query(db, { metrics: ['events'], dims: ['project', 'capability_type'], limit: 600, totals: false }, deps()),
  'costView (agent)': () => query(db, { metrics: ['cost_reported', 'cost_api_equiv', 'cost_total'], dims: ['agent'], totals: false }, deps()),
  'cwdRows (events json_extract)': () => db.prepare("SELECT project_id, json_extract(metadata,'$.cwd') AS cwd, COUNT(*) AS n FROM events WHERE project_id IS NOT NULL AND metadata IS NOT NULL GROUP BY project_id, cwd").all().length,
  'sessionRows (sessions)': () => db.prepare('SELECT id, project_id, agent_id, host_id, title, last_timestamp FROM sessions ORDER BY last_timestamp DESC LIMIT 800').all().length,
  'whole route': () => projects(ctx(), new URLSearchParams()).rows.length,
}

let cache = null
function deps() {
  return { aggregation, priceResolver: pricing.table.lookup.bind(pricing.table), billingModeFor: () => 'api', foldCache: cache, persistedFold: undefined }
}
function ctx() {
  return { db, dbPath, now: () => Date.now(), homedir: process.env.HOME ?? '/', priceResolver: pricing.table.lookup.bind(pricing.table), billingModeFor: () => 'api', cubeDeps: deps(), aggregation }
}

const times = new Map()
for (let i = 0; i < RUNS; i++) {
  for (const [name, fn] of Object.entries(ARMS)) {
    cache = createFoldCache(db)
    const t0 = process.hrtime.bigint()
    let out
    try {
      out = fn()
    } catch (err) {
      console.log(`${name} THREW ${String(err).slice(0, 120)}`)
      cache.dispose()
      cache = null
      continue
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (!times.has(name)) times.set(name, [])
    times.get(name).push(ms)
    cache.dispose()
    cache = null
    if (i === 0) console.log(`  ${name.padEnd(32)} ${ms.toFixed(0).padStart(5)} ms  rows=${typeof out === 'number' ? out : (out?.rows?.length ?? '?')}`)
  }
}
console.log(`\nbest of ${RUNS}, one fresh fold-cache scope per arm:`)
for (const [name, xs] of times) {
  const best = Math.min(...xs)
  console.log(`  ${name.padEnd(32)} ${best.toFixed(0).padStart(5)} ms   (worst ${Math.max(...xs).toFixed(0)})`)
}
const parts = Object.keys(times).filter((n) => n !== 'whole route').reduce((a, n) => a + Math.min(...times.get(n)), 0)
console.log(`  ${'sum of parts'.padEnd(32)} ${parts.toFixed(0).padStart(5)} ms`)
db.close()
