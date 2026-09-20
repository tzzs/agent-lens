#!/usr/bin/env node
/**
 * Codex 深挖（§17 第 2 项续）：
 *   ① 三种 usage 粒度的混淆量化（per-call last vs cumulative total）——Codex 的头号精度陷阱
 *   ② 逐文件核验：Σ last_token_usage == 末条 total_token_usage ？（证明"取 last 求和"是正确口径）
 *   ③ requestId 式"同一响应重复 usage"是否存在（Claude 的陷阱）——答案应为"否"
 *   ④ synthetic/占位记录检测（新格式 token_usage_record 的 r1/resp_1）
 *   ⑤ 按天输出 Σlast，供与 ccusage codex 对账
 *
 * 用法: node docs/research/probe-codex-2.mjs [sessionsDir ...]
 * 只读。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const DEFAULTS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
].filter((d) => fs.existsSync(d))
const ROOTS = argv.length ? argv.map((p) => path.resolve(p)) : DEFAULTS
if (!ROOTS.length) { console.error('用法: node probe-codex-2.mjs [sessionsDir ...]'); process.exit(2) }

const F = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const zero = () => Object.fromEntries(F.map((k) => [k, 0]))
let sumLast = zero(), sumTotal = zero()
const perDay = new Map()          // day -> Σlast
let tokRec = 0, emptyInfo = 0
let filesChecked = 0, filesCumEqSumLast = 0, maxRatio = 0
const responseGroups = new Map()  // (old fmt has none) new fmt: response_id -> Set(usage sig) 仅统计跨记录重复
let synthOld = 0                  // 旧格式里 input/output/cache 全 0 的 token_count
let synthNew = 0                  // 新格式占位（usage 全 <=1 且 response_id 为 r1/resp_* 之类）
const newRecPerFile = new Map()   // file -> response_id 次数分布，用于确认 1:1

for (const ROOT of ROOTS) {
  if (!fs.existsSync(ROOT)) continue
  for (const file of walk(ROOT)) {
    let text; try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    let fileSumLast = zero(), fileFinalTotal = null, fileTok = 0
    const respSeen = new Map()
    for (const line of text.split('\n')) {
      if (!line) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      const p = r.payload || {}
      if (r.type === 'event_msg' && p.type === 'token_count') {
        const info = p.info
        if (!info || !info.last_token_usage) { emptyInfo++; continue }
        tokRec++
        const day = (r.timestamp || '').slice(0, 10)
        const isSynth = F.every((k) => (info.last_token_usage[k] ?? 0) === 0)
        if (isSynth) synthOld++
        for (const k of F) {
          sumLast[k] += info.last_token_usage[k] ?? 0
          sumTotal[k] += (info.total_token_usage ?? {})[k] ?? 0
          fileSumLast[k] += info.last_token_usage[k] ?? 0
        }
        fileFinalTotal = info.total_token_usage
        fileTok++
        const d = perDay.get(day) ?? zero()
        for (const k of F) d[k] += info.last_token_usage[k] ?? 0
        perDay.set(day, d)
      }
      if (r.type === 'token_usage_record') {
        const u = p.usage || {}
        const sig = F.map((k) => u[k] ?? 0).join(',')
        const key = `${p.thread_id}/${p.response_id}`
        respSeen.set(key, (respSeen.get(key) ?? 0) + 1)
        if (u.response_id_placeholder || /^(r1|resp_\d+|test)/i.test(String(p.response_id)) && F.every((k) => (u[k] ?? 0) <= 1)) synthNew++
        const day = (r.timestamp || '').slice(0, 10)
        const d = perDay.get(day) ?? zero()
        for (const k of F) d[k] += u[k] ?? 0
        perDay.set(day, d)
        for (const k of F) sumLast[k] += u[k] ?? 0
        tokRec++
      }
    }
    // ② 逐文件：Σlast ≈ final cumulative total ？
    if (fileFinalTotal && fileTok > 5) {
      filesChecked++
      const sl = F.reduce((s, k) => s + fileSumLast[k], 0)
      const ft = F.reduce((s, k) => s + (fileFinalTotal[k] ?? 0), 0)
      const ratio = ft ? sl / ft : 1
      if (ratio > 0.98 && ratio < 1.05) filesCumEqSumLast++
      if (ratio > maxRatio) maxRatio = ratio
    }
    for (const [k, n] of respSeen) if (n > 1) bump(responseGroups, k)
    newRecPerFile.set(file, respSeen)
  }
}

const fmt = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v / 1e3).toFixed(0) + 'K'
const tot = (o) => F.reduce((s, k) => s + o[k], 0)

console.log(`ROOTS=${ROOTS.join(' , ')}`)
console.log(`token usage 记录（旧 token_count + 新 token_usage_record）=${tokRec}，info 为空=${emptyInfo}`)

console.log('\n## ① usage 粒度混淆量化（全量历史，单位 tokens）')
console.log('字段                      Σ last(per-call,正确)     Σ total(cumulative,错误)')
for (const k of F) console.log(`  ${k.padEnd(24)} ${fmt(sumLast[k]).padStart(14)}        ${fmt(sumTotal[k]).padStart(16)}`)
console.log(`  ${'合计'.padEnd(22)} ${fmt(tot(sumLast)).padStart(14)}        ${fmt(tot(sumTotal)).padStart(16)}`)
console.log(`  → 误用 cumulative 字段求和的虚高 = ${(tot(sumTotal) / tot(sumLast)).toFixed(0)}×`)

console.log('\n## ② 逐文件核验 Σlast == 末条 total（证明"取 last 求和"= 正确口径）')
console.log(`  抽检文件（>5 条 usage）=${filesChecked}，其中 Σlast/final∈[0.98,1.05] 的=${filesCumEqSumLast} (${pct(filesCumEqSumLast, filesChecked)})，最大比值=${maxRatio.toFixed(3)}`)
function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : 'n/a' }

console.log('\n## ③ Claude 式"同一响应重复 usage"是否存在')
const dupResp = [...responseGroups.entries()]
console.log(`  新格式 token_usage_record 中同一 (thread,response_id) 出现>1 次的组=${dupResp.length}（旧格式无 requestId 概念）`)
console.log(`  → Codex 的重复来源不是"一次响应拆多 block 重复携带"，而是"cumulative 字段被误当 per-call 求和"`)

console.log('\n## ④ 占位/synthetic 记录')
console.log(`  旧格式 token_count 四项全 0=${synthOld}  新格式占位(r1/resp_*, usage<=1)=${synthNew} → 需排除（否则每线程多计幽灵调用）`)

console.log('\n## ⑤ 按天 Σlast（供 ccusage codex 对账，UTC 日期=记录 timestamp 前 10 位）')
console.log('  day          input        cached      output      reasoning     合计')
const days = [...perDay].sort((a, b) => a[0] < b[0] ? -1 : 1)
for (const [day, o] of days.slice(-20)) {
  console.log(`  ${day}  ${fmt(o.input_tokens).padStart(10)} ${fmt(o.cached_input_tokens).padStart(11)} ${fmt(o.output_tokens).padStart(11)} ${fmt(o.reasoning_output_tokens).padStart(11)} ${fmt(tot(o)).padStart(12)}`)
}
console.log(`\n全量 Σlast 合计=${fmt(tot(sumLast))}  （写 reconcile 时可与此对 ccusage codex daily --all 的 totalTokens 比较）`)
