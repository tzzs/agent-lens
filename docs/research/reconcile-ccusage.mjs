#!/usr/bin/env node
/**
 * 对账：AgentLens 聚合口径 vs ccusage (v20.0.23) 基线
 *
 * 目的不是"和 ccusage 一致"，而是判定哪一种口径是正确的：
 *   A. naive        —— 逐条 assistant 记录求和（v1/v2 未察觉重复计数时的默认做法）
 *   B. dedup:requestId —— 按 requestId 分组、各字段取 max（§4.4 采纳的规则）
 *   C. dedup:requestId-first —— 按 requestId 取首块（验证 output_tokens 是否累积）
 *   D. dedup:message.id —— 按 Anthropic 响应 id 分组取 max（候选的更通用键）
 *
 * 用法: node reconcile-ccusage.mjs [ccusage-baseline.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.join(os.homedir(), '.claude/projects')
const ALL = process.argv.includes('--all')
const BASELINE = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'ccusage-baseline.json'
const SINCE = '2026-08-22'
const UNTIL = '2026-09-21' // 与 ccusage --since/--until 保持一致（UTC，含端点）

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const OUT_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const t0 = ALL ? 0 : Date.parse(`${SINCE}T00:00:00Z`)
const t1 = ALL ? Infinity : Date.parse(`${UNTIL}T23:59:59.999Z`)

const A = Object.fromEntries(FIELDS.map((f) => [f, 0]))
const groups = { reqMax: new Map(), reqFirst: new Map(), msgMax: new Map() }
const groupHost = new Map()      // requestId -> entrypoint，用于量化宿主拆分的金额影响
let inWindow = 0, synthInWindow = 0, noMsgId = 0, noReqId = 0
const perDayNaive = new Map()   // 该天 naive 合计，用于定位分歧发生在哪天
const groupDay = new Map()      // requestId -> 该请求所属日期（同请求不跨天）
const modelsSeen = new Set()

function maxInto(map, key, u) {
  const cur = map.get(key) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]))
  for (const f of FIELDS) cur[f] = Math.max(cur[f], u[f] ?? 0)
  map.set(key, cur)
}
function firstInto(map, key, u) {
  if (!map.has(key)) map.set(key, Object.fromEntries(FIELDS.map((f) => [f, u[f] ?? 0])))
}

for (const file of walk(ROOT)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.type !== 'assistant') continue
    const u = r.message?.usage
    if (!u) continue
    const ts = Date.parse(r.timestamp)
    if (!ALL && !(ts >= t0 && ts <= t1)) continue
    modelsSeen.add(r.message?.model ?? '?')
    if (r.message?.model === '<synthetic>') { synthInWindow++; continue }
    inWindow++
    for (const f of FIELDS) A[f] += u[f] ?? 0

    const day = r.timestamp.slice(0, 10)
    if (!r.requestId) noReqId++
    const msgId = r.message?.id
    if (!msgId) noMsgId++

    const reqKey = r.requestId ?? `req#${r.sessionId}/${r.uuid}`
    const msgKey = msgId ?? `msg#${r.sessionId}/${r.uuid}`
    maxInto(groups.reqMax, reqKey, u)
    firstInto(groups.reqFirst, reqKey, u)
    maxInto(groups.msgMax, msgKey, u)
    if (!groupHost.has(reqKey)) groupHost.set(reqKey, r.entrypoint ?? 'unknown')

    if (!groupDay.has(reqKey)) groupDay.set(reqKey, day)
    const dn = perDayNaive.get(day) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]))
    for (const f of FIELDS) dn[f] += u[f] ?? 0
    perDayNaive.set(day, dn)
  }
}

const sum = (map) => {
  const o = Object.fromEntries(FIELDS.map((f) => [f, 0]))
  for (const v of map.values()) for (const f of FIELDS) o[f] += v[f]
  return o
}
const B = sum(groups.reqMax)
const C = sum(groups.reqFirst)
const D = sum(groups.msgMax)

// ---- ccusage 基线 ----
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
const cc = Object.fromEntries(OUT_KEYS.map((k) => [k, 0]))
let ccCost = 0
for (const day of base.daily) {
  for (const m of day.modelBreakdowns ?? []) {
    cc.inputTokens += m.inputTokens
    cc.outputTokens += m.outputTokens
    cc.cacheReadTokens += m.cacheReadTokens
    cc.cacheCreationTokens += m.cacheCreationTokens
    ccCost += m.cost ?? 0
  }
}

// ---- 比对 ----
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(3) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(0) + 'K'
const LABEL = {
  input_tokens: 'input', output_tokens: 'output',
  cache_read_input_tokens: 'cache_read', cache_creation_input_tokens: 'cache_create',
}
const order = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const ccOf = { input_tokens: cc.inputTokens, output_tokens: cc.outputTokens, cache_read_input_tokens: cc.cacheReadTokens, cache_creation_input_tokens: cc.cacheCreationTokens }

console.log(`窗口 ${SINCE} → ${UNTIL} (UTC)  |  ccusage v20.0.23 claude daily -j -b -O -z UTC`)
if (ALL) console.log('⚠ --all：扫描全量历史，ccusage 基线只覆盖上面这个窗口，故"相对 ccusage 的偏差"与逐日比对仅供参考，勿用于对账。')
console.log(`窗口内 assistant+usage 记录=${inWindow}  合成记录已排除=${synthInWindow}  缺 requestId=${noReqId}  缺 message.id=${noMsgId}  模型=${[...modelsSeen].filter(m=>m!=='<synthetic>').length} 个\n`)

const header = '口径'.padEnd(26) + order.map((f) => LABEL[f].padStart(12)).join('') + '        合计'
console.log(header); console.log('-'.repeat(78))
const row = (label, o) => {
  const tot = order.reduce((s, f) => s + o[f], 0)
  console.log(label.padEnd(26) + order.map((f) => fmt(o[f]).padStart(12)).join('') + fmt(tot).padStart(12))
}
if (!ALL) row('ccusage 基线', ccOf)
row('A naive 逐条求和', A)
row('B requestId 取 max', B)
row('C requestId 取首块', C)
row('D message.id 取 max', D)

if (!ALL) {
console.log('\n相对 ccusage 的偏差:')
for (const [label, o] of [['A naive', A], ['B reqId-max', B], ['C reqId-first', C], ['D msgId-max', D]]) {
  const parts = order.map((f) => `${LABEL[f]}:${(((o[f] - ccOf[f]) / (ccOf[f] || 1)) * 100).toFixed(1)}%`)
  const tot = order.reduce((s, f) => s + o[f], 0)
  const ccTot = order.reduce((s, f) => s + ccOf[f], 0)
  console.log(`  ${label.padEnd(14)} ${parts.join('  ')}   总量:${(((tot - ccTot) / ccTot) * 100).toFixed(1)}%`)
}
const totOf = (o) => order.reduce((s, f) => s + o[f], 0)
console.log(`\n判定:`)
console.log(`  naive / ccusage = ${(totOf(A) / totOf(ccOf)).toFixed(3)}x   （全量历史测得 1.87x，此处为同窗口一致性检验）`)
console.log(`  B ≡ D ? ${JSON.stringify(B) === JSON.stringify(D) ? '是（两种键等价）' : '否 → 二者不等价，须选 requestId（见下）'}  C ≡ B ? ${JSON.stringify(B) === JSON.stringify(C) ? '是' : '否 → output_tokens 为累积值，必须取 max'}`)
console.log(`  distinct 组数: requestId=${groups.reqMax.size}  message.id=${groups.msgMax.size}`)
console.log(`  ccusage 报告成本合计 = $${ccCost.toFixed(2)}（价格来源：ccusage 离线缓存价表）`)
}

// 逐日比对：定位分歧发生在哪天
const perDayDedup = new Map()
for (const [k, v] of groups.reqMax) {
  const day = groupDay.get(k)
  const o = perDayDedup.get(day) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]))
  for (const f of FIELDS) o[f] += v[f]
  perDayDedup.set(day, o)
}
const ccDay = new Map()
for (const d of base.daily) {
  const o = Object.fromEntries(OUT_KEYS.map((k) => [k, 0]))
  for (const m of d.modelBreakdowns ?? []) {
    o.inputTokens += m.inputTokens; o.outputTokens += m.outputTokens
    o.cacheReadTokens += m.cacheReadTokens; o.cacheCreationTokens += m.cacheCreationTokens
  }
  ccDay.set(d.date, o)
}
if (!ALL) console.log(`\n逐日比对（总 token）：\n  ${'date'.padEnd(12)}${'ccusage'.padStart(12)}${'B reqId-max'.padStart(14)}${'A naive'.padStart(12)}   B/cc   A/cc`)
if (!ALL) for (const day of [...new Set([...ccDay.keys(), ...perDayDedup.keys()])].sort()) {
  const c = ccDay.get(day), b = perDayDedup.get(day), a = perDayNaive.get(day)
  if (!c || !b) { console.log(`  ${day.padEnd(12)}${c ? 'present' : 'MISSING-IN-CCUSAGE'.padStart(12)}${b ? '' : '  ← 我方采到但 ccusage 未计入'}`); continue }
  const tc = order.reduce((s, f) => s + c[ccOfKey(f)], 0), tb = order.reduce((s, f) => s + b[f], 0), ta = order.reduce((s, f) => s + a[f], 0)
  console.log(`  ${day.padEnd(12)}${fmt(tc).padStart(12)}${fmt(tb).padStart(14)}${fmt(ta).padStart(12)}   ${(tb / tc).toFixed(2)}x  ${(ta / tc).toFixed(2)}x`)
}
function ccOfKey(f) { return { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens', cache_creation_input_tokens: 'cacheCreationTokens' }[f] }

// 宿主拆分：量化"把 Desktop 当成 CLI"的金额误差（§1.5 / §4.4 第 3 项）
const byHost = new Map()
for (const [k, v] of groups.reqMax) {
  const h = groupHost.get(k)
  const o = byHost.get(h) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]).concat([['reqs', 0]]))
  for (const f of FIELDS) o[f] += v[f]
  o.reqs++
  byHost.set(h, o)
}
const hostTot = [...byHost.values()].reduce((s, o) => s + order.reduce((x, f) => x + o[f], 0), 0)
console.log(`\n宿主拆分（口径 B，总 token 及占比）：`)
for (const [h, o] of [...byHost.entries()].sort((a, b) => b[1].reqs - a[1].reqs)) {
  const t = order.reduce((s, f) => s + o[f], 0)
  console.log(`  ${h.padEnd(18)} requests=${String(o.reqs).padStart(5)}  ${fmt(t).padStart(10)}  ${(t / hostTot * 100).toFixed(1)}%   ${order.map((f) => `${LABEL[f]}=${fmt(o[f])}`).join(' ')}`)
}
const cli = byHost.get('cli')
if (cli) {
  const cliTot = order.reduce((s, f) => s + cli[f], 0)
  console.log(`  → 不分宿主直接把整目录记在 CLI 头上，误差 = ${(hostTot / cliTot).toFixed(1)}x（CLI 实际只占 ${(cliTot / hostTot * 100).toFixed(1)}%）`)
}
