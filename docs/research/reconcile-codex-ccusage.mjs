#!/usr/bin/env node
/**
 * 对账：Codex rollout 聚合口径 vs ccusage codex (v20.0.23)
 *
 * 关键语义（实测确定）：
 *  - Codex `last_token_usage.input_tokens` 是"含缓存的总输入"；ccusage 把
 *    `cached_input_tokens` 计为 cacheRead，把 (input - cached) 计为净 input。
 *    故可比的"合计" = 净input + cacheRead + output（与 ccusage totalTokens 同式）。
 *  - ccusage 疑似 **不计 subagent 线程**（实测 257/379 文件是 subagent，排除后逐字段基本对齐）。
 *
 * 用法: node reconcile-codex-ccusage.mjs [ccusage-codex-baseline.json]
 * 只读源目录；baseline 由 `ccusage codex daily -j -O -z UTC --since 20260201 --until 20260921` 生成。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASELINE = process.argv[2] || 'ccusage-codex-baseline.json'
const SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const ARCHIVED = path.join(os.homedir(), '.codex', 'archived_sessions')

function* walk(d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl')) yield p } }

const blank = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 })
const add = (a, b) => { for (const k of Object.keys(b)) a[k] += b[k]; return a }
const ex = (o) => o ? { input: o.input_tokens ?? 0, cached: o.cached_input_tokens ?? 0, cacheWrite: o.cache_write_input_tokens ?? 0, output: o.output_tokens ?? 0, reasoning: o.reasoning_output_tokens ?? 0 } : null
// 可比合计 = 含缓存的总input + output。Codex 的 input_tokens 已含缓存，直接用；
// ccusage 的 inputTokens 是净值（不含 cacheRead），故其"含缓存总输入" = input + cacheRead。
const comparable = (o) => o.input + o.output

/**
 * @param dirs 扫描目录
 * @param mode 'last'|'cumulative'
 * @param skipSubagents 是否排除 thread_source==='subagent'||'guardian_review'
 */
function scan(dirs, mode, skipSubagents) {
  const tot = blank()
  for (const d of dirs) for (const f of walk(d)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    let src = '(none)'
    for (const l of lines) { let r; try { r = JSON.parse(l) } catch { continue } if (r.type === 'session_meta') { src = r.payload?.thread_source ?? '(none)'; break } }
    if (skipSubagents && (src === 'subagent' || src === 'guardian_review')) continue
    let finalTotal = null
    for (const l of lines) {
      let r; try { r = JSON.parse(l) } catch { continue }
      const p = r.payload || {}
      if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
        if (mode === 'last') add(tot, ex(p.info.last_token_usage) || blank())
        finalTotal = ex(p.info.total_token_usage)
      } else if (r.type === 'token_usage_record') {
        add(tot, ex(p.usage) || blank())
      }
    }
    if (mode === 'cumulative' && finalTotal) add(tot, finalTotal)
  }
  return tot
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).totals
const cc = { input: base.inputTokens, cached: base.cacheReadTokens, cacheWrite: base.cacheCreationTokens, output: base.outputTokens, reasoning: base.reasoningOutputTokens }
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(3) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(0) + 'K'

const variants = {
  'A Σlast 全部': scan([SESSIONS, ARCHIVED], 'last', false),
  'B Σlast 排除subagent': scan([SESSIONS, ARCHIVED], 'last', true),
  'C Σcumulative末值 全部': scan([SESSIONS, ARCHIVED], 'cumulative', false),
}

const ccRaw = { input: cc.input + cc.cached, cached: cc.cached, output: cc.output } // ccusage input 为净值，还原为"含缓存总输入"以同式比较
console.log(`ccusage codex: ${JSON.parse(fs.readFileSync(BASELINE, 'utf8')).daily.length} 天  cost=$${base.costUSD.toFixed(2)}`)
console.log(`ccusage 净字段: 净input=${fmt(cc.input)} cacheRead=${fmt(cc.cached)} cacheCreate=${fmt(cc.cacheWrite)} output=${fmt(cc.output)} reasoning=${fmt(cc.reasoning)}  可比合计(含缓存总输入+output)=${fmt(comparable(ccRaw))}\n`)
console.log('口径(净input=input-cached)'.padEnd(28) + '  可比合计'.padStart(12) + '  Δ合计%   cacheReadΔ   净inputΔ   outputΔ  reasonΔ')
for (const [label, o] of Object.entries(variants)) {
  const net = o.input - o.cached
  const cmp = comparable(o)
  const d = (a, b) => (((a - b) / b) * 100).toFixed(1) + '%'
  console.log(label.padEnd(28) + fmt(cmp).padStart(12) + '   ' + d(cmp, comparable(ccRaw)).padStart(6) + '  ' + d(o.cached, cc.cached).padStart(9) + '  ' + d(net, cc.input).padStart(9) + '  ' + d(o.output, cc.output).padStart(7) + '  ' + d(o.reasoning, cc.reasoning).padStart(7))
}
console.log(`\n判定:`)
console.log(`  · 排除 subagent 的 Σlast（口径 B）逐字段最接近 ccusage → 社区口径 = "逐条 per-call last_token_usage 求和 + 不计子线程"。`)
console.log(`  · 残余偏差来自 subagent 归类边界与 resumed session 的 cumulative 基数，量级 <11%（净input）、cacheRead ~2%。`)
console.log(`  · 不存在 Claude 式"同一 requestId 多 block 重复 usage"（probe-codex-2 ③：0 组重复）。`)
console.log(`  · 致命项是"字段粒度"：误用 total_token_usage（cumulative）求和 → 虚高 ~2000×（见 probe-codex-2 ①）。`)
