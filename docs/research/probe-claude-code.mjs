#!/usr/bin/env node
// 一次性实测脚本：分析 Claude Code JSONL 的 usage 留存、session 边界、subagent/skill 表达。
// 用法: node docs/research/probe-claude-code.mjs [projectsDir]
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || path.join(process.env.HOME, '.claude/projects')
const NOW = Date.now()

function* walkJsonl(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walkJsonl(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const AGE_BUCKETS = [
  ['<10min', 10 * 60e3],
  ['10-60min', 60 * 60e3],
  ['1-6h', 6 * 60 * 60e3],
  ['6-24h', 24 * 60 * 60e3],
  ['1-7d', 7 * 864e5],
  ['7-30d', 30 * 864e5],
  ['>30d', Infinity],
]

const stats = {
  files: 0, bytes: 0, records: 0, parseErr: 0,
  types: new Map(),
  topKeys: new Map(),
  // usage 留存：按文件年龄分桶
  age: Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, { files: 0, asstMsgs: 0, withUsage: 0, withCost: 0, withTokens: 0 }])),
  usageKeys: new Map(),
  usageZeroOnly: 0,
  models: new Map(),
  // session / 树
  sessionIdsSeen: new Map(), // file -> set of sessionId
  parentUuidNull: 0, hasParent: 0, isSidechain: 0,
  sidechainTypes: new Map(),
  agentIdFields: new Map(),
  cwdMissing: 0, gitBranchMissing: 0,
  // tool
  toolNames: new Map(),
  skillArgs: [], taskSubtypes: new Map(), mcpToolCount: 0,
  // 其他
  subtypeValues: new Map(),
  compactRecords: 0,
  sampleRecords: {},
}

function bump(m, k, n = 1) { m.set(k, (m.get(k) ?? 0) + n) }

function bucketFor(ageMs) {
  for (const [k, lim] of AGE_BUCKETS) if (ageMs <= lim) return k
}

for (const file of walkJsonl(ROOT)) {
  const st = fs.statSync(file)
  const age = NOW - st.mtimeMs
  const b = bucketFor(age)
  stats.files++; stats.bytes += st.size
  stats.age[b].files++

  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n').filter(Boolean)
  const fileSessions = new Set()
  let asst = 0, withUsage = 0, withCost = 0, withTotalTokens = 0

  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { stats.parseErr++; continue }
    stats.records++
    bump(stats.types, r.type ?? '(none)')
    if (r.subtype) bump(stats.subtypeValues, `${r.type}/${r.subtype}`)
    if (r.type === 'system' && /compact/i.test(JSON.stringify(r.subtype ?? ''))) stats.compactRecords++
    if (r.isCompactSummary || r.type === 'compact') stats.compactRecords++
    if (!stats.sampleRecords[r.type ?? 'x']) stats.sampleRecords[r.type ?? 'x'] = r

    for (const k of Object.keys(r)) bump(stats.topKeys, k)
    if (r.sessionId) fileSessions.add(r.sessionId); else if (r.type === 'user' || r.type === 'assistant') stats.sessionIdsSeen.set('__no_session__', 1)
    if (r.parentUuid == null) stats.parentUuidNull++; else stats.hasParent++
    if (r.isSidechain) {
      stats.isSidechain++
      bump(stats.sidechainTypes, r.type ?? '(none)')
    }
    for (const k of ['agentId', 'agent', 'subagentType', 'subagent_type', 'spawnedBy', 'leafUuid']) {
      if (r[k] !== undefined) bump(stats.agentIdFields, `${k}=${typeof r[k]}`)
    }
    if (!r.cwd) stats.cwdMissing++
    if (!r.gitBranch) stats.gitBranchMissing++

    if (r.type === 'assistant' && r.message) {
      asst++
      const u = r.message.usage
      if (u) {
        withUsage++
        for (const k of Object.keys(u)) bump(stats.usageKeys, k)
        const nonzero = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
          .some((k) => (u[k] ?? 0) > 0)
        if (!nonzero) stats.usageZeroOnly++
      }
      if (r.message.costUSD != null || r.message.total_cost_usd != null) withCost++
      if (r.message.model) bump(stats.models, r.message.model)
      if (r.message.totalTokens != null) withTotalTokens++
      const content = r.message.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'tool_use') {
            bump(stats.toolNames, c.name)
            if (c.name === 'Skill') stats.skillArgs.push({ skill: c.input?.skill ?? c.input?.command ?? Object.keys(c.input ?? {}) })
            if (c.name === 'Task') bump(stats.taskSubtypes, c.input?.subagent_type ?? '(none)')
            if (c.name.startsWith('mcp__')) stats.mcpToolCount++
          }
        }
      }
    }
    if (r.type === 'user' && r.isMeta) stats.sampleRecords['meta-user'] ??= r
  }

  stats.age[b].asstMsgs += asst
  stats.age[b].withUsage += withUsage
  stats.age[b].withCost += withCost
  stats.age[b].withTokens += withTotalTokens
  stats.sessionIdsSeen.set(file, fileSessions)
}

// ---- 输出 ----
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')
console.log(`files=${stats.files} bytes=${(stats.bytes / 1048576).toFixed(1)}MB records=${stats.records} parseErr=${stats.parseErr}`)

console.log('\n## record types');;
[...stats.types].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## system subtypes');
[...stats.subtypeValues].filter(([k]) => k.startsWith('system')).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`))

console.log('\n## top-level keys (freq)');
[...stats.topKeys].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## usage retention by FILE AGE (assistant messages with message.usage)');
for (const [k] of AGE_BUCKETS) {
  const a = stats.age[k]
  if (!a.asstMsgs) continue
  console.log(`  ${k.padEnd(9)} files=${String(a.files).padStart(3)} asst=${String(a.asstMsgs).padStart(5)} usage=${String(a.withUsage).padStart(5)} (${pct(a.withUsage, a.asstMsgs)}) costField=${a.withCost} totalTokensField=${a.withTokens}`)
}

console.log('\n## usage sub-keys');
[...stats.usageKeys].sort((a,b)=>b[1]-a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
console.log(`  usage present but ALL token fields == 0: ${stats.usageZeroOnly}`)

console.log('\n## session / tree')
console.log(`  records with parentUuid=${stats.hasParent} without=${stats.parentUuidNull}`)
console.log(`  isSidechain records=${stats.isSidechain} by type: ${JSON.stringify(Object.fromEntries(stats.sidechainTypes))}`)
console.log(`  agent/subagent fields: ${JSON.stringify(Object.fromEntries(stats.agentIdFields))}`)
console.log(`  records missing cwd=${stats.cwdMissing} missing gitBranch=${stats.gitBranchMissing}`)
const multi = [...stats.sessionIdsSeen].filter(([, s]) => s.size > 1)
const zero = [...stats.sessionIdsSeen].filter(([, s]) => s.size === 0).length
console.log(`  files with >1 sessionId=${multi.length} ; files where no record carried sessionId=${zero} (of ${stats.files})`)
multi.slice(0, 3).forEach(([f, s]) => console.log(`    ${path.basename(f)} -> ${s.size} sessions`))

console.log('\n## tools');
[...stats.toolNames].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
console.log(`  mcp__* tool_use total=${stats.mcpToolCount}`)
console.log(`  Skill invocations=${stats.skillArgs.length} sample=${JSON.stringify(stats.skillArgs.slice(0, 6))}`)
console.log(`  Task subagent_type: ${JSON.stringify(Object.fromEntries(stats.taskSubtypes))}`)

console.log('\n## models');
[...stats.models].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

console.log('\n## samples (trimmed)')
for (const [t, r] of Object.entries(stats.sampleRecords)) {
  const j = JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v))
  console.log(`  [${t}] ${j.slice(0, 900)}`)
}
