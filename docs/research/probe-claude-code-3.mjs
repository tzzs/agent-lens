#!/usr/bin/env node
// ④ usage 去重后的成本虚高量化 ⑤ sidechain(子Agent) 是否独立计费 ⑥ 斜杠命令/Task 归属 ⑦ 版本字段
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.HOME, '.claude/projects')
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
let naive = Object.fromEntries(FIELDS.map((f) => [f, 0]))
const perReq = new Map()          // requestId -> {field:max}
const sideReq = new Map()         // sidechain requestId -> {field:max}
const versions = new Map()
let noRequestId = 0, noRequestIdTokens = 0
const metaUserSamples = []
const taskSamples = []
const agentToolSamples = []
const cmdFromText = []
let sideRecords = 0, sideWithUsage = 0
const entrypoints = new Map()

for (const file of walk(ROOT)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.version) versions.set(r.version, (versions.get(r.version) ?? 0) + 1)
    if (r.entrypoint) entrypoints.set(r.entrypoint, (entrypoints.get(r.entrypoint) ?? 0) + 1)

    if (r.type === 'assistant' && r.message?.usage) {
      const u = r.message.usage
      for (const f of FIELDS) naive[f] += u[f] ?? 0
      if (r.isSidechain) { sideRecords++; sideWithUsage++ }
      const key = r.requestId ?? (r.sessionId + '#' + r.uuid)
      if (!r.requestId && (r.isSidechain || true)) noRequestId++
      const store = r.isSidechain ? sideReq : perReq
      const cur = store.get(key) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]))
      for (const f of FIELDS) cur[f] = Math.max(cur[f], u[f] ?? 0)
      store.set(key, cur)
    }

    if (r.type === 'user' && r.isMeta && metaUserSamples.length < 6) {
      const c = r.message?.content
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? String(c[0]?.text ?? '') : ''
      metaUserSamples.push({ keys: Object.keys(r), cmd: r.commandName ?? null, uuid: r.uuid?.slice(0, 8), text: txt.slice(0, 180) })
    }
    if (r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith('/') && cmdFromText.length < 8) {
      cmdFromText.push(r.message.content.slice(0, 60))
    }
    const content = r.type === 'assistant' ? r.message?.content : null
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue
        if (c.name === 'Task' && taskSamples.length < 3) taskSamples.push({ inputKeys: Object.keys(c.input ?? {}), sub: c.input?.subagent_type, id: c.id?.slice(0, 14) })
        if (c.name === 'Agent' && agentToolSamples.length < 3) agentToolSamples.push({ inputKeys: Object.keys(c.input ?? {}), sub: c.input?.subagent_type, id: c.id?.slice(0, 14) })
      }
    }
    if (r.toolUseResult && (taskSamples.length && r.toolUseResult.agentId)) {
      // 记录 Task 结果里是否带 agentId
    }
    if (r.toolUseResult && typeof r.toolUseResult === 'object' && 'agentId' in r.toolUseResult && metaUserSamples.length < 99) {
      // noop
    }
  }
}

const dedup = Object.fromEntries(FIELDS.map((f) => [f, 0]))
for (const v of perReq.values()) for (const f of FIELDS) dedup[f] += v[f]
const dedupSide = Object.fromEntries(FIELDS.map((f) => [f, 0]))
for (const v of sideReq.values()) for (const f of FIELDS) dedupSide[f] += v[f]

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(0) + 'K')
console.log('## ④/⑤ token 求和口径对比（本机全量历史）')
console.log('口径            ' + FIELDS.map((f) => f.replace('_tokens', '').padStart(14)).join('') + '        合计')
const row = (label, o) => {
  const tot = FIELDS.reduce((s, f) => s + o[f], 0)
  console.log(label.padEnd(16) + FIELDS.map((f) => fmt(o[f]).padStart(14)).join('') + fmt(tot).padStart(14))
}
row('naive(逐条求和)', naive)
row('主链去重', dedup)
row('子链去重', dedupSide)
const combined = Object.fromEntries(FIELDS.map((f) => [f, dedup[f] + dedupSide[f]]))
row('主+子去重(正确)', combined)
const totNaive = FIELDS.reduce((s, f) => s + naive[f], 0)
const totCorrect = FIELDS.reduce((s, f) => s + combined[f], 0)
console.log(`\n虚高倍数 = ${(totNaive / totCorrect).toFixed(2)}x   (naive ${fmt(totNaive)} vs correct ${fmt(totCorrect)})`)
for (const f of FIELDS) console.log(`  ${f.padEnd(28)} naive=${fmt(naive[f])} correct=${fmt(combined[f])} ratio=${(naive[f] / (combined[f] || 1)).toFixed(2)}x`)
console.log(`\ndistinct 主链请求=${perReq.size} 子链请求=${sideReq.size} ; 子链 assistant 记录=${sideRecords} (带 usage ${sideWithUsage})`)
console.log(`缺 requestId 的 assistant 记录=${noRequestId}`)
console.log(`\n## ⑦ version 分布(top)`); [...versions].sort((a,b)=>b[1]-a[1]).slice(0,6).forEach(([k,v])=>console.log(`  ${k}: ${v}`))
console.log(`## ⑦ entrypoint 分布`); [...entrypoints].sort((a,b)=>b[1]-a[1]).slice(0,6).forEach(([k,v])=>console.log(`  ${k}: ${v}`))
console.log(`\n## ⑥ isMeta user 记录样本`); metaUserSamples.slice(0,6).forEach((s)=>console.log('  '+JSON.stringify(s)))
console.log(`## ⑥ content 以 / 开头的 user`); cmdFromText.forEach((s)=>console.log('  '+s))
console.log(`## ⑥ Task tool_use input`); taskSamples.forEach((s)=>console.log('  '+JSON.stringify(s)))
console.log(`## ⑥ Agent tool_use input`); agentToolSamples.forEach((s)=>console.log('  '+JSON.stringify(s)))
