#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --disable-warning=SQLite --experimental-transform-types
/**
 * A/B the served JSON of every cost-bearing route across an engine change: same clone, same
 * server wiring, two trees. Prints a per-route byte length and a sha so two runs can be
 * compared exactly, and the best of N for the speed claim.
 */
const REPO = '/Users/tanzz/workspaces/agent-lens/'
const { startServer } = await import(`${REPO}packages/server/src/serve.ts`)
const { createHash } = await import('node:crypto')
const { mkdirSync, writeFileSync } = await import('node:fs')

const [dbPath, outDir, runsArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 5)
mkdirSync(outDir, { recursive: true })

const running = startServer({ dbPath, port: 8899, host: '127.0.0.1' })
const ROUTES = [
  'projects-full|/api/projects',
  'projects-30d|/api/projects?since=30d',
  'overview-30d|/api/overview?since=30d',
  'overview-full|/api/overview',
  'agents-full|/api/agents',
  'agents-30d|/api/agents?since=30d',
  'models-30d|/api/models?since=30d',
  'sessions-30d|/api/sessions?since=30d',
  'usage-day-30d|/api/query?metrics=tokens_total,cost_api_equiv&dims=day&since=30d',
]

for (const entry of ROUTES) {
  const [name, path] = entry.split('|')
  let best = Infinity
  let text = ''
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    const res = await fetch(`${running.url}${path}`)
    text = await res.text()
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6)
    if (!res.ok) console.log(`${name} HTTP ${res.status}`)
  }
  // Wall-clock fields outside the cube's reach — `sinceTs` included, because a relative window
  // is resolved against the real clock even when the request pins `now`. Masked so a byte
  // difference can only mean a number moved.
  const masked = text.replace(/"(generatedAt|serverTime|now|emittedAt|builtAt|sinceTs|untilTs)":\d+/g, '"$1":MASKED')
  const sha = createHash('sha256').update(masked).digest('hex').slice(0, 16)
  writeFileSync(`${outDir}/${name}.json`, masked)
  console.log(`${name.padEnd(15)} ${best.toFixed(0).padStart(5)} ms  ${String(masked.length).padStart(8)} B  sha=${sha}`)
}
await running.close()
