#!/usr/bin/env node
// 深挖三点：① requestId/apiBlockIndex 是否导致 usage 重复计数 ② attachment 承载什么 ③ 零 usage 记录与 subagent 归属
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

const groups = new Map()          // requestId -> [usage signatures]
const attTypes = new Map()
const attSample = {}
const zeroSamples = []
const sideSamples = []
const keySetSamples = {}
let multiBlockReq = 0, sameUsageReq = 0, diffUsageReq = 0, examples = 0

for (const file of walk(ROOT)) {
  if (fs.statSync(file).size > 25 * 1048576) continue
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let r; try { r = JSON.parse(line) } catch { continue }

    // ① usage 重复计数
    if (r.type === 'assistant' && r.message?.usage && r.requestId) {
      const u = r.message.usage
      const sig = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].join(',')
      const key = r.requestId
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ sig, block: r.apiBlockIndex, sid: r.sessionId })
    }

    // ② attachment 结构
    if (r.type === 'attachment' && r.attachment) {
      const t = r.attachment.type ?? '(none)'
      attTypes.set(t, (attTypes.get(t) ?? 0) + 1)
      if (!attSample[t]) attSample[t] = r.attachment
      if (!keySetSamples[`attachment.${t}`]) keySetSamples[`attachment.${t}`] = Object.keys(r.attachment)
    }

    // ③ 零 usage
    if (r.type === 'assistant') {
      const u = r.message?.usage
      if (u && ![u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].some((x) => x > 0) && zeroSamples.length < 3) {
        zeroSamples.push({ file: path.basename(file), keys: Object.keys(r.message), usage: u, contentType: Array.isArray(r.message.content) ? r.message.content.map((c) => c.type) : typeof r.message.content })
      }
    }
    // ③ subagent 归属线索
    if (r.isSidechain && sideSamples.length < 4) {
      sideSamples.push({ type: r.type, keys: Object.keys(r), agentId: r.agentId, parentUuid: r.parentUuid, taskIdLike: r.sourceToolAssistantUUID })
    }
    if (r.type === 'user' || r.type === 'assistant') {
      const k = `msg.${r.type}.top`
      if (!keySetSamples[k]) keySetSamples[k] = Object.keys(r)
    }
  }
}

for (const [key, arr] of groups) {
  if (arr.length > 1) {
    multiBlockReq++
    const sigs = new Set(arr.map((a) => a.sig))
    if (sigs.size === 1) sameUsageReq++; else diffUsageReq++
    if (examples < 3 && sigs.size > 1) {
      examples++
      console.log(`!! requestId ${key.slice(0, 12)} blocks=${arr.map((a) => `${a.block}:${a.sig}`).join(' | ')}`)
    }
  }
}
const total = groups.size
console.log(`\n## ① requestId 分组: distinct requestId=${total}, 多 block 的=${multiBlockReq} (同 usage ${sameUsageReq} / 异 usage ${diffUsageReq})`)
console.log(`   => 若全部按 assistant 记录求和，多 block 请求的 token 会被放大 ${multiBlockReq ? '（存在风险）' : '（本样本无风险）'}`)

console.log('\n## ② attachment.type 分布')
;[...attTypes].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
console.log('\n## ② attachment 字段结构')
for (const [k, v] of Object.entries(keySetSamples)) if (k.startsWith('attachment.')) console.log(`  ${k}: ${JSON.stringify(v)}`)
console.log('\n## ② attachment 样本')
for (const [k, v] of Object.entries(attSample)) {
  console.log(`  [${k}] ${JSON.stringify(v, (kk, vv) => (typeof vv === 'string' && vv.length > 200 ? vv.slice(0, 200) + '…' : vv)).slice(0, 700)}`)
}

console.log('\n## ③ 零 usage 样本'); zeroSamples.forEach((s) => console.log('  ' + JSON.stringify(s).slice(0, 500)))
console.log('\n## ③ sidechain 样本'); sideSamples.forEach((s) => console.log('  ' + JSON.stringify(s).slice(0, 600)))
console.log('\n## message 顶层字段'); for (const [k, v] of Object.entries(keySetSamples)) if (k.startsWith('msg.')) console.log(`  ${k}: ${JSON.stringify(v)}`)
