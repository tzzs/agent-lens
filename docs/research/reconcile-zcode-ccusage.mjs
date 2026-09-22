#!/usr/bin/env node
/**
 * 对账：ZCode 聚合口径 vs ccusage zcode (v20.0.23)
 *
 * 目的不是"和 ccusage 一致"，而是判定哪一种口径正确 —— ZCode 把同一次调用的 token 存了 5 份
 * （`model_usage` / `part.step-finish` / `message.data.tokens` / `turn_usage` / `session_target`），
 * 且 `input_tokens` **已包含** `cache_read_input_tokens`（列名是 Anthropic 方言、语义是 Codex 那一类）。
 * 于是候选口径不止一种，偏差方向也不同：
 *   A. 逐字段照搬  —— input=input_tokens（OpenCode 的映射形状），cache 再加一遍
 *   B. 减缓存       —— input=input_tokens-cache_read-cache_write  ← §四 采纳、适配器实现的就是它
 *   C. 再读 rollup  —— B + turn_usage 整表（当成第 6 个源）
 *   D. 再读副本     —— B + part.step-finish 的 tokens（当成第二份 usage）
 *   E. 排除 subagent —— B 去掉 query_source='subagent'（codex 式头条），用来判定 subagentsIncluded
 *
 * 用法: node reconcile-zcode-ccusage.mjs [ccusage-zcode-baseline.json] [--agentlens-db <path.db>]
 *   默认基线 ccusage-zcode-baseline.json；`--agentlens-db` 额外核对**已摄入**的 events
 *   （即 adapters/zcode 真跑过 `agl scan` 之后），那才是端到端断言。
 * 只读：源库先复制成副本、折成回滚模式再打开（§18 row 7，"复制不是打开"）；绝不写 ~/.zcode。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const DB_FLAG = argv.indexOf('--agentlens-db')
const AGENTLENS_DB = DB_FLAG === -1 ? null : argv[DB_FLAG + 1]
const BASELINE = argv.find((a, i) => !a.startsWith('--') && (i === 0 || argv[i - 1] !== '--agentlens-db')) ?? 'ccusage-zcode-baseline.json'
const SRC = path.resolve(
  process.env.ZCODE_DB || path.join(process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode'), 'cli', 'db', 'db.sqlite'),
)
const SNAPSHOT = path.join(os.tmpdir(), 'agentlens-zcode-reconcile.sqlite')

function snapshot() {
  if (!fs.existsSync(SRC)) {
    console.error(`源库不存在: ${SRC}\n  （用 ZCODE_DB=/path/to/db.sqlite 指定）`)
    process.exit(2)
  }
  const before = fs.statSync(SRC)
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true })
  fs.copyFileSync(SRC, SNAPSHOT)
  if (fs.existsSync(`${SRC}-wal`)) fs.copyFileSync(`${SRC}-wal`, `${SNAPSHOT}-wal`)
  // -shm 从不复制：那是 WAL 索引，属于对方的进程。
  const db = new DatabaseSync(SNAPSHOT)
  db.exec('PRAGMA journal_mode = DELETE')
  db.close()
  const after = fs.statSync(SRC)
  const untouched = before.size === after.size && before.mtimeMs === after.mtimeMs
  console.log(`快照: ${path.relative(os.homedir(), SRC)} → ${SNAPSHOT} (${fs.statSync(SNAPSHOT).size} B, rollback)`)
  console.log(`源库未被触碰: ${untouched ? '✅ size/mtime 相同' : '❌ 变了，立刻查'}`)
  if (!untouched) process.exit(3)
}

snapshot()
const store = new DatabaseSync(SNAPSHOT, { readOnly: true })
const one = (sql) => store.prepare(sql).get()
const raw = one(`SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_input_tokens) cr,
  SUM(cache_creation_input_tokens) cw, SUM(computed_total_tokens) ct, COUNT(*) n,
  SUM(computed_total_tokens = input_tokens+output_tokens) eq_in_out,
  SUM(cache_read_input_tokens > input_tokens) cr_gt_i FROM model_usage`)
const stepFinish = one(`SELECT SUM(json_extract(data,'$.tokens.total')) t, COUNT(*) n FROM part WHERE json_extract(data,'$.type')='step-finish'`)
const turnRollup = one(`SELECT SUM(computed_total_tokens) t, COUNT(*) n FROM turn_usage`)
// E 要按桶分别求和，不能从合计里减：subagent 的 computed_total 是 input+output 之和，
// 从 net input 与 cacheRead 两处各减一次会把同一笔钱扣两遍。
const nonSub = one(`SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_input_tokens) cr,
  SUM(cache_creation_input_tokens) cw FROM model_usage WHERE query_source<>'subagent'`)
const subagent = one(`SELECT SUM(computed_total_tokens) t, COUNT(*) n FROM model_usage WHERE query_source='subagent'`)
// 恒等式必须先立，否则下面的口径没有解释力
console.log(`\nmodel_usage: ${raw.n} 行 · computed_total == input+output 在 ${raw.eq_in_out}/${raw.n} 行成立 · cache_read > input 在 ${raw.cr_gt_i} 行（0 才算"input 含缓存"）`)
if (raw.eq_in_out !== raw.n || raw.cr_gt_i !== 0) {
  console.log('  ⚠️ 语义与简报 §四 不再一致 —— 上游改了口径，先重跑 probe-zcode.mjs 再谈对账。')
}

const four = (i, o, cr, cw) => i + o + cr + cw
const candidates = {
  'A 逐字段照搬（cache 再加一遍）': four(raw.i, raw.o, raw.cr, raw.cw),
  'B 减缓存（采纳）': four(raw.i - raw.cr - raw.cw, raw.o, raw.cr, raw.cw),
  'C B + turn_usage 整表': four(raw.i - raw.cr - raw.cw, raw.o, raw.cr, raw.cw) + (turnRollup.t ?? 0),
  'D B + step-finish 副本': four(raw.i - raw.cr - raw.cw, raw.o, raw.cr, raw.cw) + (stepFinish.t ?? 0),
  'E B 排除 subagent': four(nonSub.i - nonSub.cr - nonSub.cw, nonSub.o, nonSub.cr, nonSub.cw),
}

const baseline = JSON.parse(fs.readFileSync(new URL(`./${BASELINE}`, import.meta.url), 'utf8'))
const target = baseline.totals.totalTokens
console.log(`\n基线 ${BASELINE}: totalTokens=${target} (ccusage, ${baseline.window.capturedAt}, 离线价表 -O)`)
console.log(`  分桶: input=${baseline.totals.inputTokens} output=${baseline.totals.outputTokens} cacheRead=${baseline.totals.cacheReadTokens} cacheWrite=${baseline.totals.cacheCreationTokens} cost=${baseline.totals.totalCost} (${(baseline.totals.unpricedModels ?? []).join(',') || 'priced'})`)
console.log(`\n口径                     合计            偏差`)
for (const [k, v] of Object.entries(candidates)) {
  const d = v - target
  const pctD = ((d / target) * 100).toFixed(1)
  console.log(`  ${k.padEnd(26)} ${String(v).padStart(13)}  ${d === 0 ? '✅ 逐位相同' : `${d > 0 ? '+' : ''}${d.toLocaleString()} (${pctD}%)`}`)
}
console.log(`\n  → 只有 B 命中。C/D 的 +100% 就是"把 rollup 当第 6 个源"和"把副本当第二份 usage"，`)
console.log(`    E 的 -9.3% 说明 ccusage 的头条**含**子代理 ⇒ AggregationPolicy.subagentsIncluded 必须是 true。`)

if (AGENTLENS_DB) {
  const db = new DatabaseSync(AGENTLENS_DB, { readOnly: true })
  const ingested = db
    .prepare(
      `SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw,
              COUNT(*) rows_with_usage, COUNT(DISTINCT request_id) req,
              SUM(cost_source='reported') reported_cost, SUM(usage_source='missing' AND input_tokens IS NOT NULL) bad_usage
         FROM events WHERE agent_id='zcode' AND input_tokens IS NOT NULL`,
    )
    .get()
  const sum = four(ingested.i, ingested.o, ingested.cr, ingested.cw)
  console.log(`\n已摄入 events（adapters/zcode 真跑过 agl scan）：`)
  console.log(`  input=${ingested.i} 应为 ${baseline.totals.inputTokens} ${ingested.i === baseline.totals.inputTokens ? '✅' : '❌'}`)
  console.log(`  output=${ingested.o} 应为 ${baseline.totals.outputTokens} ${ingested.o === baseline.totals.outputTokens ? '✅' : '❌'}`)
  console.log(`  cacheRead=${ingested.cr} 应为 ${baseline.totals.cacheReadTokens} ${ingested.cr === baseline.totals.cacheReadTokens ? '✅' : '❌'}`)
  console.log(`  cacheWrite=${ingested.cw} 应为 ${baseline.totals.cacheCreationTokens} ${ingested.cw === baseline.totals.cacheCreationTokens ? '✅' : '❌'}`)
  console.log(`  四桶合计=${sum} vs ccusage totalTokens=${target} ⇒ 偏差 ${sum - target} (${((100 * (sum - target)) / target).toFixed(4)}%)`)
  console.log(`  承载 usage 的行=${ingested.rows_with_usage} · 不同 request_id=${ingested.req} ${ingested.rows_with_usage === ingested.req ? '✅ 1:1，无重复计数' : '❌ 有重复'}`)
  console.log(`  被记为 reported 的成本=${ingested.reported_cost}（套餐计费，恒 0 的 cost 不得进这一档）· 口径冲突=${ingested.bad_usage}`)
  const ok =
    sum === target &&
    ingested.i === baseline.totals.inputTokens &&
    ingested.rows_with_usage === ingested.req &&
    ingested.reported_cost === 0
  console.log(`\n端到端对账: ${ok ? '✅ 通过' : '❌ 不通过'}`)
  db.close()
  process.exitCode = ok ? 0 : 1
}

store.close()
fs.rmSync(SNAPSHOT, { force: true })
fs.rmSync(`${SNAPSHOT}-wal`, { force: true })
