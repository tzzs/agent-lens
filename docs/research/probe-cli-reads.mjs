#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * The terminal's own read budget (§19). The server routes were measured through HTTP; the CLI
 * is the other half of every figure and has NO fold cache, so each statement it runs folds (or
 * reads) on its own — which is where the persisted stage 1 and the shared bucket fold should
 * show up largest.
 *
 * Spawns the real entry point so process start-up, `migrate()` and pricing load are inside the
 * number, the way `agl usage` feels to a person. Best of N, with the worst beside it: on a host
 * running several agents the spread IS the finding, not an error bar to hide.
 */
const { spawnSync } = await import('node:child_process')
const REPO = new URL('../../', import.meta.url).pathname
const BIN = `${REPO}apps/cli/src/command-exec.ts`

const argv = process.argv.slice(2)
const dbArg = argv[0] ?? '/tmp/agl-fold-final/agentlens.db'
const runs = Number(argv[1] ?? 5)

const COMMANDS = [
  'usage --since 30d',
  'usage',
  'usage --by model',
  'projects --since 30d',
  'projects',
  'sessions --since 30d',
  'doctor',
]

const quiet = { stdio: ['ignore', 'ignore', 'ignore'] }
for (const cmd of COMMANDS) {
  const times = []
  let code = 0
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    // The flags the bin shim's shebang carries: `--experimental-transform-types` is not
    // optional (workspace sources use parameter properties, which strip-only mode rejects).
    const res = spawnSync(
      'node',
      ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--disable-warning=SQLite', BIN, '--db', dbArg, ...cmd.split(' ')],
      quiet,
    )
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
    code = res.status ?? -1
  }
  const best = Math.min(...times)
  const worst = Math.max(...times)
  console.log(`agl ${cmd.padEnd(22)} ${best.toFixed(0).padStart(5)} ms  (worst ${worst.toFixed(0)}, exit ${code})`)
}
