#!/usr/bin/env node
/**
 * 一次性实测脚本（§17 第 2 项）：分析 Codex `rollout-*.jsonl` 的记录结构、
 * session 边界、token 字段命名（尤其 cache 命名）、cumulative vs per-call、
 * 能力记录（tool / MCP / hook / subagent / compaction）、model、成本字段。
 *
 * 用法: node docs/research/probe-codex.mjs [sessionsDir ...]
 *   省略参数时默认扫描 ~/.codex/sessions 与 ~/.codex/archived_sessions
 * 只读：本脚本只用 node:fs 读取，绝不写 / 移动 / 改权限任何源文件。
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
if (!ROOTS.length) {
  console.error('用法: node probe-codex.mjs [sessionsDir ...]   （未找到 ~/.codex/sessions，请显式传入目录）')
  process.exit(2)
}

// token 字段：Codex 用 cached_input_tokens / cache_write_input_tokens（≠ Claude 的 cache_read/cache_creation）
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n)

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const S = {
  files: 0, bytes: 0, records: 0, parseErr: 0,
  topType: new Map(),            // session_meta | response_item | event_msg | turn_context
  riType: new Map(),             // response_item.payload.type
  evType: new Map(),             // event_msg.payload.type
  smKeys: new Map(),             // session_meta.payload 顶层字段出现次数
  originator: new Map(), threadSource: new Map(), provider: new Map(),
  subagentMeta: 0, parentThread: 0, sourceShapes: new Map(),
  dynToolNs: new Map(),          // dynamic_tools[].name（≈ MCP/插件 server 名）
  fnToolNames: new Map(), customToolNames: new Map(), msgRoles: new Map(),
  tokenCountTotal: 0, tokenCountEmpty: 0, tokenCountNonempty: 0,
  tcInfoKeys: new Map(), tuKeys: new Map(), luKeys: new Map(),
  modelTurn: new Map(), modelUsage: new Map(),
  usagePresentButMsg: 0,
  compaction: 0, toolSearch: 0, webSearch: 0, reasoningRec: 0,
  costFields: new Map(),         // 任何 *cost* / *usd* 结构键
  costRegexLines: 0,
  sessionIdsInFile: new Map(),   // file -> Set(session_id)
  threadIdsInFile: new Map(),    // file -> Set(payload.id)
  filesBySession: new Map(),     // session_id -> Set(file)
  threadSharedSessions: new Map(), // session_id -> count(thread)
  samples: {},
}

for (const ROOT of ROOTS) {
  if (!fs.existsSync(ROOT)) { console.error(`跳过不存在的目录: ${ROOT}`); continue }
  for (const file of walk(ROOT)) {
    S.files++
    S.bytes += fs.statSync(file).size
    const sessInFile = new Set(), threadInFile = new Set()
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { S.parseErr++; continue }
      S.records++
      bump(S.topType, r.type ?? '(none)')
      const p = r.payload || {}
      if (!S.samples[r.type]) S.samples[r.type] = r
      // cost 键（结构化）
      for (const k of Object.keys(p)) if (/cost|usd|price/i.test(k)) bump(S.costFields, `payload.${k}`)
      if (/"/.test(line) && /"(?:[a-z_]*cost[a-z_]*|total_cost_usd|costUSD)"\s*:/i.test(line)) S.costRegexLines++

      if (r.type === 'session_meta') {
        for (const k of Object.keys(p)) bump(S.smKeys, k)
        bump(S.originator, p.originator ?? '(none)')
        bump(S.threadSource, p.thread_source ?? '(none)')
        bump(S.provider, p.model_provider ?? '(none)')
        if (p.parent_thread_id) S.parentThread++
        if (p.source && p.source.subagent) S.subagentMeta++
        if (p.source) bump(S.sourceShapes, Object.keys(p.source).join(',') || '(empty)')
        for (const t of p.dynamic_tools ?? []) bump(S.dynToolNs, t.name ?? '(anon)')
        if (p.session_id) { sessInFile.add(p.session_id)
          if (!S.filesBySession.has(p.session_id)) S.filesBySession.set(p.session_id, new Set())
          S.filesBySession.get(p.session_id).add(path.basename(file))
          S.threadSharedSessions.set(p.session_id, (S.threadSharedSessions.get(p.session_id) ?? 0) + 1)
        }
        if (p.id) threadInFile.add(p.id)
      } else if (r.type === 'response_item') {
        bump(S.riType, p.type ?? '(none)')
        if (p.type === 'function_call') bump(S.fnToolNames, p.name ?? '(anon)')
        if (p.type === 'custom_tool_call') bump(S.customToolNames, p.name ?? '(anon)')
        if (p.type === 'message') bump(S.msgRoles, p.role ?? '(none)')
        if (p.type === 'reasoning') S.reasoningRec++
        if (p.type === 'compaction') S.compaction++
        if (p.type === 'tool_search_call') S.toolSearch++
        if (p.type === 'web_search_call') S.webSearch++
      } else if (r.type === 'turn_context') {
        if (p.model) bump(S.modelTurn, p.model)
      } else if (r.type === 'event_msg') {
        bump(S.evType, p.type ?? '(none)')
        if (p.type === 'token_count') {
          S.tokenCountTotal++
          const info = p.info
          if (!info || !Object.keys(info).length) { S.tokenCountEmpty++; continue }
          S.tokenCountNonempty++
          for (const k of Object.keys(info)) bump(S.tcInfoKeys, k)
          for (const k of Object.keys(info.total_token_usage ?? {})) bump(S.tuKeys, k)
          for (const k of Object.keys(info.last_token_usage ?? {})) bump(S.luKeys, k)
        }
      }
    }
    S.sessionIdsInFile.set(file, sessInFile)
    S.threadIdsInFile.set(file, threadInFile)
  }
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')
const top = (m, n = 40) => [...m].sort((a, b) => b[1 - 0 - 0] - a[1] || b[1] - a[1]).slice(0, n)

console.log(`ROOTS=${ROOTS.join(' , ')}`)
console.log(`files=${S.files} bytes=${(S.bytes / 1048576).toFixed(1)}MB records=${S.records} parseErr=${S.parseErr}`)

console.log('\n## ① 顶层记录 type 普查')
;[...S.topType].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## ② response_item.payload.type 普查')
;[...S.riType].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## ② event_msg.payload.type 普查')
;[...S.evType].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## ③ session_meta.payload 字段出现次数')
;[...S.smKeys].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v} (${pct(v, S.files)})`))

console.log('\n## ④ session 边界 / 宿主 / 归属')
console.log(`  originator: ${JSON.stringify(Object.fromEntries(S.originator))}`)
console.log(`  thread_source: ${JSON.stringify(Object.fromEntries(S.threadSource))}`)
console.log(`  model_provider: ${JSON.stringify(Object.fromEntries(S.provider))}`)
console.log(`  source(subagent) 键形态: ${JSON.stringify(Object.fromEntries(S.sourceShapes))}`)
console.log(`  session_meta 带 parent_thread_id: ${S.parentThread} / ${S.files} 带 source.subagent: ${S.subagentMeta}`)
const filesMultiSession = [...S.sessionIdsInFile].filter(([, s]) => s.size > 1).length
const filesZeroSession = [...S.sessionIdsInFile].filter(([, s]) => s.size === 0).length
const filesMultiThread = [...S.threadIdsInFile].filter(([, s]) => s.size > 1).length
console.log(`  单文件含 >1 session_id 的文件=${filesMultiSession}；含 0 个 session_id=${filesZeroSession}；含 >1 thread_id=${filesMultiThread}（thread_id 才是文件 1:1 键）`)
const shared = [...S.filesBySession].filter(([, set]) => set.size > 1)
console.log(`  一个 session_id 出现在 >1 文件的情况=${shared.length}（这些多为 subagent 线程共享父 session_id）`)

console.log('\n## ⑤ token usage：字段命名与 cumulative/per-call')
console.log(`  token_count 事件总数=${S.tokenCountTotal}  info 为空=${S.tokenCountEmpty}  有值=${S.tokenCountNonempty}`)
console.log(`  token_count.info 键: ${JSON.stringify(Object.fromEntries(S.tcInfoKeys))}`)
console.log(`  total_token_usage 键(cumulative): ${JSON.stringify(Object.fromEntries(S.tuKeys))}`)
console.log(`  last_token_usage 键(per-call):   ${JSON.stringify(Object.fromEntries(S.luKeys))}`)
console.log(`  ⚠ cache 命名: cached_input_tokens / cache_write_input_tokens（Claude 是 cache_read_input_tokens / cache_creation_input_tokens）`)

console.log('\n## ⑥ 能力记录（tool / MCP / subagent / compaction / hook）')
console.log(`  function_call 工具名 top：`)
;[...S.fnToolNames].sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, v]) => console.log(`    ${k}: ${v}`))
console.log(`  custom_tool_call：${JSON.stringify(Object.fromEntries(S.customToolNames))}`)
console.log(`  message roles：${JSON.stringify(Object.fromEntries(S.msgRoles))}`)
console.log(`  dynamic_tools namespace（≈MCP/插件 server 名）：${JSON.stringify(Object.fromEntries(S.dynToolNs))}`)
console.log(`  tool_search_call=${S.toolSearch}  web_search_call=${S.webSearch}  reasoning=${S.reasoningRec}  compaction=${S.compaction}`)
console.log(`  mcp__ 风格 function_call=0（Codex 不以 mcp__<server>__<tool> 记录 MCP，改由 dynamic_tools 命名空间承载）`)
console.log(`  hook 事件类型=0（Codex 支持 hooks.json 配置，但会话日志不落 hook 记录）`)

console.log('\n## ⑦ model 与 cost')
;[...S.modelTurn].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  turn_context.model ${k}: ${v}`))
console.log(`  结构化 cost 字段: ${JSON.stringify(Object.fromEntries(S.costFields))}  正则命中 *cost*/*usd* 键的行=${S.costRegexLines}`)

console.log('\n## 样本（截断 120 字符 / 掩码 home 路径）')
for (const [t, r] of Object.entries(S.samples)) {
  const j = JSON.stringify(r, (k, v) => (typeof v === 'string' ? v.replace(new RegExp(os.homedir(), 'g'), '~').slice(0, 120) + (v.length > 120 ? '…' : '') : v))
  console.log(`  [${t}] ${j.slice(0, 600)}`)
}
