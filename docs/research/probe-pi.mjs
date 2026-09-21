#!/usr/bin/env node
/**
 * Pi 实测（§17）：~/.pi/agent/sessions/**\/*.jsonl 的会话轨迹普查。
 * 用法: node docs/research/probe-pi.mjs [sessionsDir]
 *   默认 ~/.pi/agent/sessions
 * 只读：全部走 fs 读接口，不写任何文件、不打开任何 SQLite。
 * 输出：记录类型 / 顶层 key / message 角色与字段 / content part 形态 /
 *       usage 语义验证（total == 四桶之和 → input 与 cache 互斥）/ cost 结构 /
 *       stopReason 与 provider 词表 / 会话头与文件名 uuid 一致性 / 能力目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(process.argv[2] || path.join(os.homedir(), '.pi', 'agent', 'sessions'))
if (!fs.existsSync(ROOT)) {
  console.error(`不存在: ${ROOT}   （用法: node probe-pi.mjs [sessionsDir]）`)
  process.exit(2)
}

const files = []
for (const d of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, d)
  if (!fs.statSync(p).isDirectory()) continue
  for (const f of fs.readdirSync(p)) if (f.endsWith('.jsonl')) files.push(path.join(p, f))
}
files.sort()
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

const types = new Map()
const topKeys = new Map()
const msgKeys = new Map()
const partKeys = new Map()
const stop = new Map()
const apis = new Map()
const providers = new Map()
const tools = new Map()
const usageKeys = new Map()
const costKeys = new Map()
let records = 0
let unparseable = 0
let disjointSum = 0
let notDisjoint = 0
const notDisjointSamples = []
let costSumOk = 0
let costSumBad = 0
let headers = 0
let headerMidFile = 0
let filenameUuidMatchesHeader = 0
let noHeaderFiles = 0
const thinkingSig = new Set()
let respIds = 0
let asstNoRespId = 0

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  let header = null
  for (let i = 0; i < lines.length; i++) {
    let o
    try {
      o = JSON.parse(lines[i])
    } catch {
      unparseable++
      continue
    }
    records++
    bump(types, String(o.type))
    for (const k of Object.keys(o)) bump(topKeys, k)
    if (o.type === 'session') {
      headers++
      if (i !== 0) headerMidFile++
      if (!header) header = o
    }
    const m = o.message
    if (!m || typeof m !== 'object') continue
    bump(msgKeys, `${m.role}|${Object.keys(m).sort().join(',')}`)
    if (Array.isArray(m.content))
      for (const c of m.content) {
        bump(partKeys, `${m.role}|${c.type ?? '?'}|${Object.keys(c).sort().join(',')}`)
        if (c.thinkingSignature !== undefined) thinkingSig.add(String(c.thinkingSignature))
        if (m.role === 'assistant' && c.type === 'toolCall') bump(tools, String(c.name))
        if (m.role === 'toolResult') bump(tools, String(m.toolName))
      }
    if (m.role !== 'assistant') continue
    bump(stop, String(m.stopReason))
    bump(apis, String(m.api))
    bump(providers, String(m.provider))
    if (m.responseId) respIds++
    else asstNoRespId++
    const u = m.usage
    if (!u) continue
    for (const k of Object.keys(u)) bump(usageKeys, k)
    for (const k of Object.keys(u.cost ?? {})) bump(costKeys, k)
    const sum = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
    if (u.totalTokens === sum) disjointSum++
    else {
      notDisjoint++
      if (notDisjointSamples.length < 3) notDisjointSamples.push(u)
    }
    const csum = (u.cost?.input ?? 0) + (u.cost?.output ?? 0) + (u.cost?.cacheRead ?? 0) + (u.cost?.cacheWrite ?? 0)
    if (Math.abs((u.cost?.total ?? 0) - csum) < 1e-9) costSumOk++
    else costSumBad++
  }
  if (!header) noHeaderFiles++
  else {
    const fn = path.basename(f, '.jsonl')
    if (fn.includes(`_${header.id}`)) filenameUuidMatchesHeader++
  }
}

const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])
console.log(`files=${files.length} records=${records} unparseableLines=${unparseable}`)
console.log(`\n## type 分布\n${sorted(types).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`)
console.log(`\n## 顶层 key 分布\n${sorted(topKeys).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`)
console.log(`\n## message 形态 (role|keys)\n${sorted(msgKeys).map(([k, v]) => `  ${v}  ${k}`).join('\n')}`)
console.log(`\n## content part 形态 (role|type|keys)\n${sorted(partKeys).map(([k, v]) => `  ${v}  ${k}`).join('\n')}`)
console.log(`\n## assistant 词表\n  stopReason: ${JSON.stringify(sorted(stop))}\n  api: ${JSON.stringify([...apis])}\n  provider: ${JSON.stringify(sorted(providers))}`)
console.log(`\n## toolName 分布\n${sorted(tools).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`)
console.log(`\n## usage / cost`)
console.log(`  usage keys: ${JSON.stringify([...usageKeys])}`)
console.log(`  cost keys:  ${JSON.stringify([...costKeys])}`)
console.log(`  totalTokens == input+output+cacheRead+cacheWrite: ${disjointSum} 相等 / ${notDisjoint} 不等 ${notDisjointSamples.length ? JSON.stringify(notDisjointSamples) : ''}`)
console.log(`  cost.total == cost 四桶之和: ${costSumOk} 相等 / ${costSumBad} 不等`)
console.log(`  responseId: 有=${respIds} 无=${asstNoRespId}`)
console.log(`\n## 会话结构`)
console.log(`  session 头记录: ${headers}（非首行出现 ${headerMidFile}）/ 无头文件 ${noHeaderFiles} / 文件名 uuid == 头 id: ${filenameUuidMatchesHeader}/${files.length}`)
console.log(`  thinkingSignature 取值: ${JSON.stringify([...thinkingSig])}`)

const agentRoot = path.join(os.homedir(), '.pi', 'agent')
console.log(`\n## 能力目录（静态安装面）`)
for (const d of ['skills', 'extensions']) {
  const p = path.join(agentRoot, d)
  try {
    const items = fs.readdirSync(p)
    console.log(`  ~/.pi/agent/${d}: ${items.length} 项（${items.slice(0, 5).join(', ')}${items.length > 5 ? ' …' : ''}）`)
  } catch (e) {
    console.log(`  ~/.pi/agent/${d}: ${e.code}`)
  }
}
try {
  const s = JSON.parse(fs.readFileSync(path.join(agentRoot, 'settings.json'), 'utf8'))
  console.log(`  settings.json keys: ${Object.keys(s).join(', ')}; lastChangelogVersion=${s.lastChangelogVersion}`)
} catch (e) {
  console.log(`  settings.json: ${e.code}`)
}
